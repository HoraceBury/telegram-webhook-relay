'use strict';
/**
 * TradingView -> Telegram webhook relay & TradeLocker Order Execution
 * -------------------------------------------------------------------
 * Listens for POST requests from TradingView alerts:
 * 1) /webhook: validates GUID and forwards payload to Telegram chat.
 * 2) /trade: validates GUID, parses symbol, entry, TP, SL, side, and qty,
 *    connects to TradeLocker API using details from config.json, places the order,
 *    and sends an execution report to Telegram.
 * 3) /health: simple GET endpoint for health checks (returns 200 OK).
 *
 * Configuration is read from config.json in the same directory.
 * See config.example.json for required fields and format.
 * Requires Node.js 18+ (uses the built-in `fetch`). No npm packages needed.
 *
 * Run:
 *   node webhook-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'webhook.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFile(LOG_PATH, line + '\n', () => {}); // best-effort, non-blocking
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const required = ['guid', 'telegramBotToken', 'telegramChatId', 'port', 'ip'];
  for (const key of required) {
    if (!cfg[key]) throw new Error(`config.json is missing required field: "${key}"`);
  }
  if (!cfg.webhookPath) cfg.webhookPath = '/webhook';
  if (!cfg.tradePath) cfg.tradePath = '/trade';
  return cfg;
}

let config = loadConfig();
log(`Config loaded. Webhook path: ${config.webhookPath}, Trade path: ${config.tradePath}, port: ${config.port}`);

// Reload config.json automatically if you edit it (e.g. rotate GUID or update credentials)
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    config = loadConfig();
    log('config.json changed on disk — reloaded.');
  } catch (err) {
    log(`Failed to reload config.json: ${err.message} (keeping previous config)`);
  }
});

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.telegramChatId, text }),
    signal: AbortSignal.timeout(10_000), // don't hang forever if Telegram/outbound is unreachable
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram API returned ${resp.status}: ${body}`);
  }
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Builds the Telegram message from every field in the payload except the GUID.
function formatMessage(payload) {
  const lines = ['TradingView Alert'];
  for (const [key, value] of Object.entries(payload)) {
    if (key.toLowerCase() === 'guid') continue;
    const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
    lines.push(`${key}: ${displayValue}`);
  }
  return lines.join('\n');
}

// -------------------------------------------------------------------
// TradeLocker API Integration
// -------------------------------------------------------------------

let tlAuthToken = null;
let tlTokenExpiresAt = 0;

function getTradeLockerBaseUrl(cfg) {
  let env = cfg.tradelockerEnvironment || cfg.tradelockerApiUrl || 'https://demo.tradelocker.com';
  env = env.trim().replace(/\/+$/, '');
  if (!env.endsWith('/backend-api')) {
    env += '/backend-api';
  }
  return env;
}

async function getTradeLockerToken(forceRefresh = false) {
  if (!forceRefresh && tlAuthToken && Date.now() < tlTokenExpiresAt - 60_000) {
    return tlAuthToken;
  }

  const baseUrl = getTradeLockerBaseUrl(config);
  const email = config.tradelockerEmail;
  const password = config.tradelockerPassword;
  const server = config.tradelockerServer;

  if (
    !email ||
    !password ||
    !server ||
    email.startsWith('REPLACE') ||
    password.startsWith('REPLACE') ||
    server.startsWith('REPLACE')
  ) {
    throw new Error('TradeLocker credentials (tradelockerEmail, tradelockerPassword, tradelockerServer) are not properly set in config.json');
  }

  const resp = await fetch(`${baseUrl}/auth/jwt/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, server }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`TradeLocker authentication failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  if (!data.accessToken) {
    throw new Error('TradeLocker auth response did not contain an accessToken');
  }

  tlAuthToken = data.accessToken;
  if (data.expireDate) {
    tlTokenExpiresAt = new Date(data.expireDate).getTime();
  } else {
    tlTokenExpiresAt = Date.now() + 3600_000;
  }

  return tlAuthToken;
}

async function getTradeLockerAccountDetails(token) {
  let accountId = config.tradelockerAccountId;
  let accNum = config.tradelockerAccNum;

  if (accountId && accNum) {
    return { accountId: String(accountId), accNum: String(accNum) };
  }

  const baseUrl = getTradeLockerBaseUrl(config);
  const resp = await fetch(`${baseUrl}/auth/jwt/all-accounts`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to list TradeLocker accounts (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const accounts = data.accounts || [];
  if (accounts.length === 0) {
    throw new Error('No TradeLocker trading accounts associated with this login');
  }

  const activeAcc = accounts.find((a) => a.status === 'ACTIVE') || accounts[0];
  accountId = accountId || String(activeAcc.id);
  accNum = accNum || String(activeAcc.accNum);

  return { accountId, accNum };
}

async function findTradeLockerInstrument(token, accountId, accNum, rawSymbol) {
  const baseUrl = getTradeLockerBaseUrl(config);
  const resp = await fetch(`${baseUrl}/trade/accounts/${accountId}/instruments`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch TradeLocker instruments (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const instruments = data.d?.instruments || data.instruments || [];

  const cleanSymbol = String(rawSymbol).toUpperCase().replace(/[\/\-_.]/g, '');

  let matched = instruments.find((i) => String(i.name).toUpperCase().replace(/[\/\-_.]/g, '') === cleanSymbol);
  if (!matched) {
    matched = instruments.find((i) =>
      String(i.name).toUpperCase().includes(cleanSymbol) || cleanSymbol.includes(String(i.name).toUpperCase())
    );
  }

  if (!matched) {
    throw new Error(`Symbol "${rawSymbol}" could not be matched to any available TradeLocker instrument`);
  }

  const tradableInstrumentId = matched.tradableInstrumentId;
  let routeId = 0;
  if (Array.isArray(matched.routes) && matched.routes.length > 0) {
    const tradeRoute = matched.routes.find((r) => r.type === 'TRADE');
    routeId = tradeRoute ? tradeRoute.id : matched.routes[0].id;
  }

  return { tradableInstrumentId, routeId, instrumentName: matched.name };
}

async function createTradeLockerTrade(payload) {
  let token = await getTradeLockerToken();

  const rawSymbol = payload.symbol ?? payload.Symbol ?? payload.ticker ?? payload.Ticker;
  if (!rawSymbol) {
    throw new Error('Payload is missing required parameter "symbol"');
  }

  const rawSide = String(payload.side ?? payload.Side ?? payload.action ?? payload.Action ?? payload.direction ?? 'buy').toLowerCase();
  const side = (rawSide.includes('sell') || rawSide.includes('short')) ? 'sell' : 'buy';

  const rawType = String(payload.type ?? payload.Type ?? payload.orderType ?? 'market').toLowerCase();
  let type = 'market';
  if (rawType.includes('limit')) type = 'limit';
  else if (rawType.includes('stop')) type = 'stop';

  const validity = (type === 'market') ? 'IOC' : 'GTC';

  const entry = payload.entry ?? payload.Entry ?? payload.price ?? payload.Price ?? payload.entryPrice ?? payload.entry_price;
  const tp = payload.tp ?? payload.TP ?? payload.takeProfit ?? payload.TakeProfit ?? payload.take_profit;
  const sl = payload.sl ?? payload.SL ?? payload.stopLoss ?? payload.StopLoss ?? payload.stop_loss;
  const qty = Number(payload.qty ?? payload.Qty ?? payload.quantity ?? payload.Quantity ?? payload.volume ?? payload.Volume ?? payload.lots ?? config.tradelockerDefaultQty ?? 0.01);

  const placeOrderCall = async (authToken) => {
    const { accountId, accNum } = await getTradeLockerAccountDetails(authToken);
    const { tradableInstrumentId, routeId, instrumentName } = await findTradeLockerInstrument(authToken, accountId, accNum, rawSymbol);

    const orderBody = {
      tradableInstrumentId,
      routeId,
      side,
      type,
      validity,
      qty,
      price: (type === 'market') ? 0 : Number(entry || 0),
    };

    if (type === 'stop') {
      orderBody.stopPrice = Number(entry || 0);
    }

    if (tp !== undefined && tp !== null && tp !== '') {
      orderBody.takeProfit = Number(tp);
      orderBody.takeProfitType = 'absolute';
    }

    if (sl !== undefined && sl !== null && sl !== '') {
      orderBody.stopLoss = Number(sl);
      orderBody.stopLossType = 'absolute';
    }

    const baseUrl = getTradeLockerBaseUrl(config);
    const resp = await fetch(`${baseUrl}/trade/accounts/${accountId}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'accNum': String(accNum),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderBody),
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.status === 401) {
      throw new Error('UNAUTHORIZED_TOKEN');
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`TradeLocker place order failed (${resp.status}): ${text}`);
    }

    const result = await resp.json();
    const orderId = result.d?.orderId ?? result.orderId ?? 'Unknown';

    return {
      orderId,
      instrumentName,
      side,
      type,
      qty,
      entry: entry ?? 'Market',
      tp: tp ?? 'N/A',
      sl: sl ?? 'N/A',
      result,
    };
  };

  try {
    return await placeOrderCall(token);
  } catch (err) {
    if (err.message === 'UNAUTHORIZED_TOKEN') {
      log('TradeLocker token expired, refreshing and retrying order...');
      token = await getTradeLockerToken(true);
      return await placeOrderCall(token);
    }
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  // DIAGNOSTIC: log the instant any request is received, before any
  // parsing/validation. If this line never appears in webhook.log for a
  // failed call, the request isn't reaching Node at all (network/OS layer,
  // not application code) — remove this once things are working.
  log(`Incoming ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

  req.on('aborted', () => log('Request aborted by client mid-read.'));
  res.on('close', () => {
    if (!res.writableEnded) log('Connection closed before a response was sent.');
  });

  if (req.method === 'GET' && req.url.split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const requestPath = req.url.split('?')[0];
  const isWebhookPath = requestPath === config.webhookPath;
  const isTradePath = requestPath === config.tradePath;

  if (!isWebhookPath && !isTradePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    log(`Rejected request: ${err.message}`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Body must be valid JSON');
    log(`Rejected request: invalid JSON body: ${raw.slice(0, 200)}`);
    return;
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Body must be a JSON object');
    log(`Rejected request: JSON body is not an object: ${raw.slice(0, 200)}`);
    return;
  }

  const incomingGuid = payload.guid ?? payload.GUID ?? payload.Guid;

  if (!incomingGuid || String(incomingGuid) !== String(config.guid)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    log(`Rejected request on ${requestPath}: GUID mismatch (received "${incomingGuid}").`);
    return;
  }

  if (isWebhookPath) {
    const message = formatMessage(payload);

    try {
      await sendTelegramMessage(message);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      log(`Forwarded to Telegram: ${message.replace(/\n/g, ' | ')}`);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Failed to notify Telegram');
      log(`Telegram send failed: ${err.message}`);
    }
  } else if (isTradePath) {
    try {
      const tradeResult = await createTradeLockerTrade(payload);
      
      log(`TradeLocker order created successfully: ${JSON.stringify(tradeResult)}`);

      const telegramText = [
        '⚡ TradeLocker Trade Executed',
        `Order ID: ${tradeResult.orderId}`,
        `Symbol: ${tradeResult.instrumentName}`,
        `Side: ${tradeResult.side.toUpperCase()}`,
        `Type: ${tradeResult.type.toUpperCase()}`,
        `Quantity: ${tradeResult.qty}`,
        `Entry: ${tradeResult.entry}`,
        `Take Profit: ${tradeResult.tp}`,
        `Stop Loss: ${tradeResult.sl}`
      ].join('\n');

      try {
        await sendTelegramMessage(telegramText);
      } catch (tgErr) {
        log(`Failed to send trade execution alert to Telegram: ${tgErr.message}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', orderId: tradeResult.orderId, details: tradeResult }));
    } catch (err) {
      log(`Trade creation failed: ${err.message}`);

      try {
        await sendTelegramMessage(`❌ Trade Execution FAILED\nSymbol: ${payload.symbol || payload.ticker || 'Unknown'}\nError: ${err.message}`);
      } catch (_) {}

      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Trade creation failed: ${err.message}`);
    }
  }
});

server.listen(config.port, config.ip, () => {
  log(`Webhook server listening on http://${config.ip}:${config.port} (Webhook: ${config.webhookPath}, Trade: ${config.tradePath})`);
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
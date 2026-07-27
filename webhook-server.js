'use strict';
/**
 * TradingView -> Telegram webhook relay & TradeLocker Order Execution
 * -------------------------------------------------------------------
 * Listens for POST requests from TradingView alerts:
 * 1) /webhook: validates GUID and forwards payload to Telegram chat.
 * 2) /trade: validates GUID, parses symbol, type (buy/sell), tp, and sl.
 *    Entry is resolved from the live market price (market order), and qty
 *    is calculated to risk config.riskPercentage of account balance.
 *    Connects to TradeLocker API using details from config.json, places
 *    the order, and sends an execution report to Telegram.
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
  if (!cfg.closePath) cfg.closePath = '/close';
  if (!cfg.healthPath) cfg.healthPath = '/health';
  if (cfg.riskPercentage === undefined && cfg.tradelockerRiskPercent === undefined) {
    cfg.riskPercentage = 1;
  } else {
    cfg.riskPercentage = Number(cfg.riskPercentage ?? cfg.tradelockerRiskPercent ?? 1);
  }
  cfg.dryRun = Boolean(cfg.dryRun ?? cfg.tradelockerDryRun ?? false);
  cfg.maxOpenTrades = Number(cfg.maxOpenTrades ?? 1);
  return cfg;
}

let config = loadConfig();
log(`Config loaded. Webhook path: ${config.webhookPath}, Trade path: ${config.tradePath}, Health path: ${config.healthPath}, Risk: ${config.riskPercentage}%, Max Open Trades: ${config.maxOpenTrades}, Dry Run: ${config.dryRun}, port: ${config.port}`);

// Reload config.json automatically if you edit it (e.g. rotate GUID or update credentials)
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    config = loadConfig();
    log('config.json changed on disk — reloaded.');
  } catch (err) {
    log(`Failed to reload config.json: ${err.message} (keeping previous config)`);
  }
});

// -------------------------------------------------------------------
// Telegram API Integration
// -------------------------------------------------------------------

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

  log(`TradeLocker accounts found: ${JSON.stringify(accounts.map((a) => ({ id: a.id, accNum: a.accNum, name: a.name, status: a.status, currency: a.currency, accountBalance: a.accountBalance })))}`);

  const activeAcc = accounts.find((a) => a.status === 'ACTIVE') || accounts[0];
  accountId = accountId || String(activeAcc.id);
  accNum = accNum || String(activeAcc.accNum);

  log(`Using TradeLocker account: accountId=${accountId}, accNum=${accNum} (name=${activeAcc.name}, status=${activeAcc.status})`);

  return { accountId, accNum };
}

async function getTradeLockerAccountBalance(token, accountId, accNum) {
  const baseUrl = getTradeLockerBaseUrl(config);
  try {
    const resp = await fetch(`${baseUrl}/trade/accounts/${accountId}/state`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'accNum': String(accNum),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const bal = data.d?.balance ?? data.d?.accountBalance ?? data.balance ?? data.accountBalance;
      if (bal !== undefined && !isNaN(Number(bal))) {
        return Number(bal);
      }
    }
  } catch (_) {}

  try {
    const respAll = await fetch(`${baseUrl}/auth/jwt/all-accounts`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (respAll.ok) {
      const dataAll = await respAll.json();
      const accounts = dataAll.accounts || [];
      const match = accounts.find((a) => String(a.id) === String(accountId) || String(a.accNum) === String(accNum)) || accounts[0];
      if (match) {
        const bal = match.accountBalance ?? match.balance;
        if (bal !== undefined && !isNaN(Number(bal))) {
          return Number(bal);
        }
      }
    }
  } catch (_) {}

  throw new Error('Unable to retrieve TradeLocker account balance for position sizing');
}

let tlConfigCache = null;

async function getTradeLockerConfig(token, accNum) {
  if (tlConfigCache) return tlConfigCache;
  const baseUrl = getTradeLockerBaseUrl(config);
  const resp = await fetch(`${baseUrl}/trade/config`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch TradeLocker config (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  tlConfigCache = data.d ?? data;
  log(`TradeLocker config fetched. Top-level keys: ${JSON.stringify(Object.keys(tlConfigCache))}`);
  return tlConfigCache;
}

// Positions (and several other endpoints) return rows as plain arrays, with
// the column order defined separately in /trade/config. This turns each row
// into a proper keyed object using that column list.
function mapRowsToObjects(rows, columnsConfig) {
  if (!Array.isArray(rows)) return [];
  if (!Array.isArray(columnsConfig) || columnsConfig.length === 0) return rows;
  return rows.map((row) => {
    if (!Array.isArray(row)) return row; // already an object — nothing to map
    const obj = {};
    columnsConfig.forEach((col, i) => {
      const name = typeof col === 'string' ? col : (col.id ?? col.name ?? col.field ?? `col${i}`);
      obj[name] = row[i];
    });
    return obj;
  });
}

async function getTradeLockerOpenPositions(token, accountId, accNum) {
  const baseUrl = getTradeLockerBaseUrl(config);
  const resp = await fetch(`${baseUrl}/trade/accounts/${accountId}/positions`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch TradeLocker positions (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const rawPositions = data.d?.positions || data.positions || [];
  log(`Open positions raw response: ${JSON.stringify(data).slice(0, 1000)}`);

  const cfg = await getTradeLockerConfig(token, accNum);
  const positionsConfig = cfg.positionsConfig?.columns || cfg.positionsConfig || cfg.positions || [];
  log(`Positions column config: ${JSON.stringify(positionsConfig)}`);

  const positions = mapRowsToObjects(rawPositions, positionsConfig);
  log(`Mapped positions: ${JSON.stringify(positions)}`);
  return positions;
}

async function closeTradeLockerPosition(token, accountId, accNum, positionId) {
  const baseUrl = getTradeLockerBaseUrl(config);
  const resp = await fetch(`${baseUrl}/trade/positions/${positionId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ qty: 0 }), // qty: 0 = fully close the position
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text();
    throw new Error(`Failed to close position ${positionId} (${resp.status}): ${text}`);
  }
}

async function closeAllTradeLockerPositions() {
  let token = await getTradeLockerToken();
  const { accountId, accNum } = await getTradeLockerAccountDetails(token);
  const positions = await getTradeLockerOpenPositions(token, accountId, accNum);

  const closed = [];
  for (const p of positions) {
    const positionId = p.positionId ?? p.id ?? p.PositionID;
    if (!positionId) {
      throw new Error(`Could not determine positionId from position data — check the "Mapped positions" log line and update the field mapping. Raw position: ${JSON.stringify(p)}`);
    }
    await closeTradeLockerPosition(token, accountId, accNum, positionId);
    closed.push({ positionId, instrument: p.instrument ?? p.name ?? p.tradableInstrumentId, side: p.side, qty: p.lots ?? p.qty ?? p.qtyOpen });
  }
  return closed;
}

async function getTradeLockerQuote(token, accountId, accNum, tradableInstrumentId, routeId) {
  const baseUrl = getTradeLockerBaseUrl(config);
  const resp = await fetch(`${baseUrl}/trade/quotes?tradableInstrumentId=${tradableInstrumentId}&routeId=${routeId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch TradeLocker quote (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  log(`Quote response for instrument ${tradableInstrumentId}: ${JSON.stringify(data).slice(0, 500)}`);

  const q = (Array.isArray(data.d?.quotes) && data.d.quotes[0]) || (Array.isArray(data.quotes) && data.quotes[0]) || data.d || data;
  const ask = Number(q.ap ?? q.ask ?? q.askPrice ?? 0);
  const bid = Number(q.bp ?? q.bid ?? q.bidPrice ?? 0);

  if (!ask && !bid) {
    throw new Error(`TradeLocker returned no usable ask/bid for instrument ${tradableInstrumentId} — check the "Quote response for instrument..." log line and verify the /trade/quotes response shape`);
  }

  return { ask, bid };
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

  if (instruments.length === 0) {
    log(`Instruments list came back empty for accountId=${accountId}, accNum=${accNum}. Raw response: ${JSON.stringify(data).slice(0, 2000)}`);
  }

  const cleanSymbol = String(rawSymbol).toUpperCase().replace(/[\/\-_.]/g, '');

  let matched = instruments.find((i) => String(i.name).toUpperCase().replace(/[\/\-_.]/g, '') === cleanSymbol);
  if (!matched) {
    matched = instruments.find((i) =>
      String(i.name).toUpperCase().includes(cleanSymbol) || cleanSymbol.includes(String(i.name).toUpperCase())
    );
  }

  if (!matched) {
    const allNames = instruments.map((i) => i.name);
    const looksClose = allNames.filter((n) => {
      const c = String(n).toUpperCase().replace(/[\/\-_.]/g, '');
      return c.includes(cleanSymbol.slice(0, 3)) || cleanSymbol.includes(c.slice(0, 3));
    });
    log(`Symbol match failed for "${rawSymbol}". Closest-looking instrument names: ${JSON.stringify(looksClose)}. Full instrument list (${allNames.length} total): ${JSON.stringify(allNames)}`);
    throw new Error(`Symbol "${rawSymbol}" could not be matched to any available TradeLocker instrument`);
  }

  const tradableInstrumentId = matched.tradableInstrumentId;
  let routeId = 0;
  let infoRouteId = 0;
  if (Array.isArray(matched.routes) && matched.routes.length > 0) {
    const tradeRoute = matched.routes.find((r) => r.type === 'TRADE');
    const infoRoute = matched.routes.find((r) => r.type === 'INFO');
    routeId = tradeRoute ? tradeRoute.id : matched.routes[0].id;
    infoRouteId = infoRoute ? infoRoute.id : routeId;
  }

  let contractSize = Number(matched.lotSize ?? matched.contractSize ?? matched.size ?? matched.unitsPerLot ?? 0);
  if (!contractSize || isNaN(contractSize) || contractSize <= 0) {
    const knownCryptoPrefixes = ['BTC', 'ETH', 'XRP', 'LTC', 'BCH', 'ADA', 'SOL', 'DOGE', 'DOT', 'BNB'];
    const isCrypto = knownCryptoPrefixes.some((p) => cleanSymbol.startsWith(p));
    contractSize = (!isCrypto && /^[A-Z]{6}$/.test(cleanSymbol)) ? 100000 : 1;
    log(`WARNING: TradeLocker did not report a lot size for "${matched.name}" — guessing contractSize=${contractSize}. Verify this against the broker's real contract size before trusting position sizing.`);
  }

  const minQty = Number(matched.minLot ?? matched.minQty ?? 0.01);
  const askPrice = Number(matched.ask ?? matched.askPrice ?? matched.price ?? 0);
  const bidPrice = Number(matched.bid ?? matched.bidPrice ?? matched.price ?? 0);

  return { tradableInstrumentId, routeId, infoRouteId, instrumentName: matched.name, contractSize, minQty, askPrice, bidPrice };
}

async function createTradeLockerTrade(payload) {
  let token = await getTradeLockerToken();

  const rawSymbol = payload.symbol ?? payload.Symbol ?? payload.ticker ?? payload.Ticker;
  if (!rawSymbol) {
    throw new Error('Payload is missing required parameter "symbol"');
  }

  const rawSide = String(payload.type ?? payload.Type ?? payload.side ?? payload.Side ?? '').toLowerCase();
  if (!rawSide.includes('buy') && !rawSide.includes('sell')) {
    throw new Error('Payload must include "type": "buy" or "sell"');
  }
  const side = rawSide.includes('sell') ? 'sell' : 'buy';
  const type = 'market'; // order execution type — always market for this endpoint
  const validity = 'IOC';

  const tp = payload.tp ?? payload.TP ?? payload.takeProfit ?? payload.TakeProfit;
  const sl = payload.sl ?? payload.SL ?? payload.stopLoss ?? payload.StopLoss;
  if (tp === undefined || tp === null || tp === '' || isNaN(Number(tp))) {
    throw new Error('Payload must include a numeric "tp" price');
  }
  if (sl === undefined || sl === null || sl === '' || isNaN(Number(sl))) {
    throw new Error('Payload must include a numeric "sl" price');
  }
  const tpNum = Number(tp);
  const slNum = Number(sl);

  const placeOrderCall = async (authToken) => {
    const { accountId, accNum } = await getTradeLockerAccountDetails(authToken);

    // Max concurrent open trades check — reject new trades once the limit is reached.
    const openPositions = await getTradeLockerOpenPositions(authToken, accountId, accNum);
    if (openPositions.length >= config.maxOpenTrades) {
      throw new Error(`Max open trades reached (${openPositions.length}/${config.maxOpenTrades}) — new trade rejected`);
    }

    const { tradableInstrumentId, routeId, infoRouteId, instrumentName, contractSize, minQty } = await findTradeLockerInstrument(authToken, accountId, accNum, rawSymbol);

    // Market order — entry is the current live price, fetched from the quotes endpoint.
    // Quotes require the INFO routeId, not the TRADE routeId used for order placement.
    const { ask, bid } = await getTradeLockerQuote(authToken, accountId, accNum, tradableInstrumentId, infoRouteId);
    const entryNum = side === 'buy' ? (ask || bid) : (bid || ask);

    // Position sizing: quantity risking config.riskPercentage of current account balance
    const riskPercent = Number(config.riskPercentage ?? 1);
    const slDistance = Math.abs(entryNum - slNum);
    const balance = await getTradeLockerAccountBalance(authToken, accountId, accNum);
    const riskAmount = balance * (riskPercent / 100);
    const lossPerLot = slDistance * contractSize;
    let qty = lossPerLot > 0 ? riskAmount / lossPerLot : Number(config.tradelockerDefaultQty ?? 0.01);
    qty = Math.max(minQty || 0.01, Math.round(qty * 100) / 100);
    log(`Position Sizing: Entry = ${entryNum}, Contract Size = ${contractSize}, Account Balance = $${balance}, Risk (${riskPercent}%) = $${riskAmount.toFixed(2)}, SL Distance = ${slDistance}, Calculated Lots = ${qty}`);

    const orderBody = {
      tradableInstrumentId,
      routeId,
      side,
      type,
      validity,
      qty,
      price: 0,
    };

    if (tp !== undefined && tp !== null && tp !== '') {
      orderBody.takeProfit = Number(tp);
      orderBody.takeProfitType = 'absolute';
    }

    if (sl !== undefined && sl !== null && sl !== '') {
      orderBody.stopLoss = Number(sl);
      orderBody.stopLossType = 'absolute';
    }

    // dryRun:true from EITHER config or payload blocks a live trade. A live
    // trade only happens when both are false (payload omitted = false).
    const isDryRun = Boolean(config.dryRun) || Boolean(payload.dryRun ?? payload.dry_run ?? false);

    // ALWAYS log the exact trade order details whether executing live or in dry-run mode
    log(`Exact Trade Order Details ${isDryRun ? '(DRY-RUN - WOULD CREATE)' : '(SENDING TO BROKER)'}: ${JSON.stringify({ accountId, accNum, ...orderBody })}`);

    let result;
    let orderId;

    if (isDryRun) {
      orderId = `DRY-RUN-${Date.now()}`;
      result = { status: 'DRY_RUN', simulated: true, orderId, orderBody };
      log(`[DRY-RUN] Trade order simulated (not sent to broker). Order ID: ${orderId}`);
    } else {
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

      result = await resp.json();
      orderId = result.d?.orderId ?? result.orderId ?? 'Unknown';
    }

    return {
      orderId,
      instrumentName,
      side,
      type,
      qty,
      entry: entryNum,
      tp: tp ?? 'N/A',
      sl: sl ?? 'N/A',
      result,
      dryRun: isDryRun,
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

  const requestPath = req.url.split('?')[0];

  // -------------------------------------------------------------------
  // Health Check Endpoint
  // -------------------------------------------------------------------
  if (req.method === 'GET' && requestPath === config.healthPath) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const isWebhookPath = requestPath === config.webhookPath;
  const isTradePath = requestPath === config.tradePath;
  const isClosePath = requestPath === config.closePath;

  if (!isWebhookPath && !isTradePath && !isClosePath) {
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

  // A /trade call with no "type" field is treated as a close request, so a
  // single TradingView alert (one fixed webhook URL) can drive both opens
  // and closes — the payload shape decides which, not the URL.
  const hasType = payload.type !== undefined && payload.type !== null && payload.type !== '';
  const shouldOpenTrade = isTradePath && hasType;
  const shouldClosePositions = isClosePath || (isTradePath && !hasType);

  // -------------------------------------------------------------------
  // Telegram Webhook Relay Endpoint
  // -------------------------------------------------------------------
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
  // -------------------------------------------------------------------
  // TradeLocker Order Execution Endpoint
  // -------------------------------------------------------------------
  } else if (shouldOpenTrade) {
    try {
      const tradeResult = await createTradeLockerTrade(payload);
      const isDry = tradeResult.dryRun;
      
      log(`TradeLocker order ${isDry ? 'simulated (DRY RUN)' : 'created'} successfully: ${JSON.stringify(tradeResult)}`);

      const telegramText = [
        isDry ? '🧪 TradeLocker Trade (DRY RUN - SIMULATED)' : '⚡ TradeLocker Trade Executed',
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
        log(`Trade execution alert sent to Telegram: ${telegramText.replace(/\n/g, ' | ')}`);
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
  // -------------------------------------------------------------------
  // TradeLocker Close Position Endpoint
  // -------------------------------------------------------------------
  } else if (shouldClosePositions) {
    try {
      const closed = await closeAllTradeLockerPositions();
      log(`Closed ${closed.length} TradeLocker position(s): ${JSON.stringify(closed)}`);

      const telegramText = closed.length > 0
        ? ['🔒 TradeLocker Position(s) Closed', ...closed.map((p) => `${p.instrument} ${p.side} qty ${p.qty} (positionId ${p.positionId})`)].join('\n')
        : 'ℹ️ /close called — no open position to close';

      try {
        await sendTelegramMessage(telegramText);
        log(`Close alert sent to Telegram: ${telegramText.replace(/\n/g, ' | ')}`);
      } catch (tgErr) {
        log(`Failed to send close alert to Telegram: ${tgErr.message}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', closed }));
    } catch (err) {
      log(`Position close failed: ${err.message}`);

      try {
        await sendTelegramMessage(`❌ Position Close FAILED\nError: ${err.message}`);
      } catch (_) {}

      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Position close failed: ${err.message}`);
    }
  }
});

server.listen(config.port, config.ip, () => {
  log(`Webhook server listening on http://${config.ip}:${config.port} (Webhook: ${config.webhookPath}, Trade: ${config.tradePath}, Health: ${config.healthPath})`);
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
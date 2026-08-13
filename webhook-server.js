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
// Trade Context Persistence (entry/sl per open position, for R:R calc)
// -------------------------------------------------------------------
// Stores the entry and SL actually used to open each live trade, keyed by
// tradableInstrumentId, so a later close can compute an R-multiple result
// (SL hit = -1.0, full TP = +1.0, halfway to TP = +0.5, etc.). Persisted to
// disk so a server/app restart doesn't lose it.

const TRADE_CONTEXT_PATH = path.join(__dirname, 'trade-context.json');
const openTradeContext = new Map(); // key: String(tradableInstrumentId) -> { instrumentName, side, entry, sl, savedAt }

function saveTradeContext() {
  try {
    fs.writeFileSync(TRADE_CONTEXT_PATH, JSON.stringify(Object.fromEntries(openTradeContext), null, 2));
  } catch (err) {
    log(`Failed to save trade-context.json: ${err.message}`);
  }
}

function setTradeContext(tradableInstrumentId, data) {
  openTradeContext.set(String(tradableInstrumentId), { ...data, savedAt: new Date().toISOString() });
  saveTradeContext();
}

function clearTradeContext(tradableInstrumentId) {
  if (openTradeContext.delete(String(tradableInstrumentId))) {
    saveTradeContext();
  }
}

function loadTradeContext() {
  if (!fs.existsSync(TRADE_CONTEXT_PATH)) {
    log('No trade-context.json found on disk — starting with empty R:R tracking.');
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(TRADE_CONTEXT_PATH, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      openTradeContext.set(key, value);
    }
    if (openTradeContext.size === 0) {
      log('trade-context.json loaded but was empty.');
    } else {
      log(`Loaded trade context from disk for ${openTradeContext.size} instrument(s):`);
      for (const [key, value] of openTradeContext.entries()) {
        log(`  - ${value.instrumentName ?? key} (tradableInstrumentId=${key}): side=${value.side}, entry=${value.entry}, sl=${value.sl}, savedAt=${value.savedAt}`);
      }
    }
  } catch (err) {
    log(`Failed to load trade-context.json: ${err.message} — starting with empty R:R tracking.`);
  }
}

// Compares loaded (persisted) context against TradeLocker's actual live open
// positions. Stale entries (no matching live position — e.g. it closed while
// the app was down) are removed. Live positions with no stored context are
// logged as a warning, since R:R won't be computable for those if they close.
async function corroborateTradeContextWithLivePositions() {
  try {
    const token = await getTradeLockerToken();
    const { accountId, accNum } = await getTradeLockerAccountDetails(token);
    const livePositions = await getTradeLockerOpenPositions(token, accountId, accNum);
    const liveInstrumentIds = new Set(livePositions.map((p) => String(p.tradableInstrumentId)));

    for (const [key, value] of Array.from(openTradeContext.entries())) {
      if (!liveInstrumentIds.has(key)) {
        log(`STALE trade context: ${value.instrumentName ?? key} (tradableInstrumentId=${key}) has no matching live open position — removing stored context.`);
        openTradeContext.delete(key);
      } else {
        log(`Corroborated trade context: ${value.instrumentName ?? key} (tradableInstrumentId=${key}) matches a live open position.`);
      }
    }
    saveTradeContext();

    for (const p of livePositions) {
      const key = String(p.tradableInstrumentId);
      if (!openTradeContext.has(key)) {
        log(`WARNING: live open position on tradableInstrumentId=${key} (positionId=${p.positionId ?? p.id}) has no stored entry/sl context — R:R result won't be available if this closes.`);
      }
    }
  } catch (err) {
    log(`Failed to corroborate trade context with live positions: ${err.message}`);
  }
}

// Runs periodically (every 15 minutes, see the setInterval near server
// startup) while trades are being tracked. Unlike the one-time startup
// corroboration above, this actively notifies Telegram when it finds a
// tracked trade has closed outside the app (SL/TP hit at the broker, or
// closed manually) — the whole point being you find out even if the app
// missed the close signal for some reason.
async function checkForExternallyClosedTrades() {
  if (openTradeContext.size === 0) {
    log('Reconciliation check: no tracked open trades — skipping.');
    return;
  }

  try {
    const token = await getTradeLockerToken();
    const { accountId, accNum } = await getTradeLockerAccountDetails(token);
    const livePositions = await getTradeLockerOpenPositions(token, accountId, accNum);
    const liveInstrumentIds = new Set(livePositions.map((p) => String(p.tradableInstrumentId)));

    for (const [key, ctx] of Array.from(openTradeContext.entries())) {
      if (liveInstrumentIds.has(key)) continue; // still open — nothing to do

      log(`Reconciliation: tracked trade on ${ctx.instrumentName} (tradableInstrumentId=${key}) is no longer open on the broker — closed externally (SL/TP hit, or closed outside this app).`);

      let resultR = null;
      try {
        const instrument = await findTradeLockerInstrument(token, accountId, accNum, ctx.instrumentName);
        const { ask, bid } = await getTradeLockerQuote(token, accountId, accNum, instrument.tradableInstrumentId, instrument.infoRouteId);
        const estClosePrice = ctx.side === 'buy' ? bid : ask;
        resultR = calculateRMultiple(ctx.side, ctx.entry, ctx.sl, estClosePrice);
      } catch (err) {
        log(`Could not estimate R:R for externally-closed ${ctx.instrumentName}: ${err.message}`);
      }

      const resultText = (resultR !== null && resultR !== undefined) ? ` — Estimated Result: ${resultR >= 0 ? '+' : ''}${resultR.toFixed(1)}` : '';
      try {
        await sendTelegramMessage(`⚠️ ${ctx.instrumentName} position closed outside the app (SL/TP hit, or closed manually)${resultText}`);
      } catch (tgErr) {
        log(`Failed to send reconciliation Telegram alert: ${tgErr.message}`);
      }

      clearTradeContext(key);
    }
  } catch (err) {
    log(`Reconciliation check failed: ${err.message}`);
  }
}

function calculateRMultiple(side, entry, sl, closePrice) {
  if (entry === undefined || sl === undefined || closePrice === undefined || entry === null || sl === null || closePrice === null) return null;
  const risk = side === 'sell' ? (sl - entry) : (entry - sl);
  if (!risk) return null;
  const raw = side === 'sell' ? (entry - closePrice) : (closePrice - entry);
  return raw / risk;
}

function formatClosedPositionLine(p) {
  const resultText = (p.resultR !== null && p.resultR !== undefined)
    ? ` — Result: ${p.resultR >= 0 ? '+' : ''}${p.resultR.toFixed(1)}`
    : '';
  return `${p.instrument} ${p.side} qty ${p.qty} (positionId ${p.positionId})${resultText}`;
}

loadTradeContext();


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

async function sendTelegramMessageWithButton(text, buttonText, callbackData) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      reply_markup: { inline_keyboard: [[{ text: buttonText, callback_data: callbackData }]] },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram API returned ${resp.status}: ${body}`);
  }
}

async function answerTelegramCallback(callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 200) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log(`Failed to answer Telegram callback query: ${err.message}`);
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

// Wraps fetch() for TradeLocker calls, retrying on 429 (Too Many Requests)
// with exponential backoff + jitter, honoring Retry-After when present. A
// burst of near-simultaneous open/close requests (e.g. duplicate/retried
// webhook deliveries) previously tripped TradeLocker's rate limit and
// surfaced immediately as a request failure. Each attempt gets its own
// fresh timeout signal rather than reusing one across retries.
async function tlFetch(url, options = {}, { retries = 3, timeoutMs = 10_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (resp.status !== 429 || attempt >= retries) {
      return resp;
    }
    const retryAfterSeconds = Number(resp.headers.get('retry-after'));
    const backoffMs = retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
    log(`TradeLocker request rate-limited (429): ${url} — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries}).`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
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

  const resp = await tlFetch(`${baseUrl}/auth/jwt/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, server }),
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
  const resp = await tlFetch(`${baseUrl}/auth/jwt/all-accounts`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
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
    const resp = await tlFetch(`${baseUrl}/trade/accounts/${accountId}/state`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'accNum': String(accNum),
      },
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
    const respAll = await tlFetch(`${baseUrl}/auth/jwt/all-accounts`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
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
  const resp = await tlFetch(`${baseUrl}/trade/config`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
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
  const resp = await tlFetch(`${baseUrl}/trade/accounts/${accountId}/positions`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
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
  const resp = await tlFetch(`${baseUrl}/trade/positions/${positionId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ qty: 0 }), // qty: 0 = fully close the position
  });

  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text();
    throw new Error(`Failed to close position ${positionId} (${resp.status}): ${text}`);
  }
}

async function closeAllTradeLockerPositions(rawSymbol) {
  let token = await getTradeLockerToken();
  const { accountId, accNum } = await getTradeLockerAccountDetails(token);
  let positions = await getTradeLockerOpenPositions(token, accountId, accNum);

  let instrumentName;
  let scopedInstrumentId;
  let scopedInfoRouteId;
  if (rawSymbol) {
    const instrument = await findTradeLockerInstrument(token, accountId, accNum, rawSymbol);
    instrumentName = instrument.instrumentName;
    scopedInstrumentId = instrument.tradableInstrumentId;
    scopedInfoRouteId = instrument.infoRouteId;
    log(`Resolved instrument for CLOSE: ${instrumentName} (tradableInstrumentId=${scopedInstrumentId}) — scoping close to this instrument only.`);
    positions = positions.filter((p) => String(p.tradableInstrumentId) === String(instrument.tradableInstrumentId));
  } else {
    log(`CLOSE request has no symbol scope — closing ALL open positions account-wide (${positions.length} found).`);
  }

  // Fetch a live quote once for the scoped instrument, used as the estimated
  // close price for the R-multiple calculation. Only available when the
  // close is symbol-scoped (an account-wide close skips R:R — no single
  // instrument to quote).
  let closeQuote;
  if (rawSymbol && scopedInstrumentId && scopedInfoRouteId) {
    try {
      closeQuote = await getTradeLockerQuote(token, accountId, accNum, scopedInstrumentId, scopedInfoRouteId);
    } catch (err) {
      log(`Could not fetch close-estimate quote for ${instrumentName}: ${err.message} — R:R result will be omitted.`);
    }
  }

  const closed = [];
  for (const p of positions) {
    const positionId = p.positionId ?? p.id ?? p.PositionID;
    if (!positionId) {
      throw new Error(`Could not determine positionId from position data — check the "Mapped positions" log line and update the field mapping. Raw position: ${JSON.stringify(p)}`);
    }
    log(`Closing position ${positionId} on instrument ${p.tradableInstrumentId} (${instrumentName ?? 'unscoped'})`);

    const ctx = openTradeContext.get(String(p.tradableInstrumentId));
    let resultR = null;
    if (ctx && closeQuote) {
      // Closing a buy = selling at bid; closing a sell = buying at ask.
      const estClosePrice = p.side === 'buy' ? closeQuote.bid : closeQuote.ask;
      resultR = calculateRMultiple(p.side, ctx.entry, ctx.sl, estClosePrice);
    }

    await closeTradeLockerPosition(token, accountId, accNum, positionId);
    clearTradeContext(p.tradableInstrumentId);
    closed.push({ positionId, instrument: instrumentName ?? p.instrument ?? p.name ?? p.tradableInstrumentId, tradableInstrumentId: p.tradableInstrumentId, side: p.side, qty: p.lots ?? p.qty ?? p.qtyOpen, resultR });
  }
  return closed;
}

// -------------------------------------------------------------------
// Telegram "Close Trade" Button Handling (long-polling)
// -------------------------------------------------------------------
// Telegram delivers button presses as "callback queries." Real-time push
// delivery (a Telegram-side webhook) requires an HTTPS URL, which this
// server doesn't have, so instead we periodically ask Telegram for new
// updates (long polling) — no inbound exposure or TLS needed.
//
// Only one polling session runs at a time (Telegram's getUpdates doesn't
// support overlapping concurrent calls with the same offset — a second
// call while one is pending returns a 409 Conflict). A session is up to
// 10 polls of 30s each (~5 minutes), then it stops. Starting a trade
// triggers a session only if one isn't already running; any "Close"
// button pressed while a session is active works, regardless of which
// trade's message it came from.

let tgUpdateOffset = 0;
let tgPollingActive = false;
const TG_MAX_POLLS = 10; // 10 x 30s long-polls ≈ 5 minutes per session

async function startTelegramPollingSession() {
  if (tgPollingActive) return; // a session is already running — don't overlap
  tgPollingActive = true;
  log('Telegram polling session started (up to 10 polls, ~5 minutes).');

  try {
    for (let pollCount = 0; pollCount < TG_MAX_POLLS; pollCount++) {
      try {
        const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?timeout=30&offset=${tgUpdateOffset}&allowed_updates=%5B%22callback_query%22%5D`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(35_000) });
        if (!resp.ok) {
          const text = await resp.text();
          log(`Telegram getUpdates failed (${resp.status}): ${text}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const data = await resp.json();
        for (const update of data.result || []) {
          tgUpdateOffset = update.update_id + 1;

          const cb = update.callback_query;
          if (!cb || !cb.data || !cb.data.startsWith('close:')) continue;

          const symbol = cb.data.slice('close:'.length);
          log(`Telegram "Close" button pressed for ${symbol}`);

          try {
            const closed = await runExclusive(symbol, () => closeAllTradeLockerPositions(symbol));
            const resultText = closed.length > 0
              ? `Closed ${closed.length} position(s) on ${symbol}`
              : `No open position on ${symbol}`;
            await answerTelegramCallback(cb.id, resultText);

            const telegramText = closed.length > 0
              ? ['🔒 Position Closed (via button)', ...closed.map(formatClosedPositionLine)].join('\n')
              : `ℹ️ Close button pressed for ${symbol} — no open position to close`;
            await sendTelegramMessage(telegramText);
            log(`Closed ${closed.length} position(s) for ${symbol} via Telegram button.`);
          } catch (err) {
            await answerTelegramCallback(cb.id, `Failed: ${err.message}`);
            log(`Failed to close ${symbol} via Telegram button: ${err.message}`);
            try {
              await sendTelegramMessage(`❌ Close via button FAILED for ${symbol}\nError: ${err.message}`);
            } catch (_) {}
          }
        }
      } catch (err) {
        log(`Telegram polling error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } finally {
    tgPollingActive = false;
    log('Telegram polling session ended (5-minute window elapsed).');
  }
}

async function getTradeLockerQuote(token, accountId, accNum, tradableInstrumentId, routeId) {
  const baseUrl = getTradeLockerBaseUrl(config);
  const resp = await tlFetch(`${baseUrl}/trade/quotes?tradableInstrumentId=${tradableInstrumentId}&routeId=${routeId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
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
  const resp = await tlFetch(`${baseUrl}/trade/accounts/${accountId}/instruments`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': String(accNum),
    },
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

    const { tradableInstrumentId, routeId, infoRouteId, instrumentName, contractSize, minQty } = await findTradeLockerInstrument(authToken, accountId, accNum, rawSymbol);
    log(`Resolved instrument for OPEN: ${instrumentName} (tradableInstrumentId=${tradableInstrumentId})`);

    // Max concurrent open trades check — per instrument, not account-wide.
    // A GBPUSD position open doesn't block a new BTCUSD trade, for example.
    const openPositions = await getTradeLockerOpenPositions(authToken, accountId, accNum);
    const openForSymbol = openPositions.filter((p) => String(p.tradableInstrumentId) === String(tradableInstrumentId));
    if (openForSymbol.length >= config.maxOpenTrades) {
      throw new Error(`Max open trades reached for ${instrumentName} (${openForSymbol.length}/${config.maxOpenTrades}) — new trade rejected`);
    }

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
      const resp = await tlFetch(`${baseUrl}/trade/accounts/${accountId}/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'accNum': String(accNum),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderBody),
      });

      if (resp.status === 401) {
        throw new Error('UNAUTHORIZED_TOKEN');
      }

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`TradeLocker place order failed (${resp.status}): ${text}`);
      }

      result = await resp.json();

      // TradeLocker can return HTTP 200 with a logical failure in the body
      // (e.g. {"s":"error","errmsg":"TP price for the order is not valid."}).
      // resp.ok alone doesn't catch this — check the body's own status too.
      if (result.s === 'error') {
        throw new Error(`TradeLocker rejected the order: ${result.errmsg || JSON.stringify(result)}`);
      }

      orderId = result.d?.orderId ?? result.orderId;
      if (!orderId) {
        throw new Error(`TradeLocker response did not contain an orderId — treating as a failed order. Response: ${JSON.stringify(result)}`);
      }
    }

    if (!isDryRun) {
      setTradeContext(tradableInstrumentId, { instrumentName, side, entry: entryNum, sl: slNum });
      log(`Stored trade context for R:R tracking: ${instrumentName} side=${side} entry=${entryNum} sl=${slNum}`);
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

// -------------------------------------------------------------------
// Per-instrument request serialization
// -------------------------------------------------------------------
// TradingView can deliver an open and a close for the same instrument
// within milliseconds of each other (two independent alert() calls firing
// off the same bar close, or retried deliveries). Each request used to
// independently fetch "current open positions" and act on it — two
// overlapping requests could both read the same stale snapshot and both
// proceed. Routing every open/close for a given symbol through here forces
// them to run one at a time, in arrival order, instead of racing.
const instrumentLocks = new Map(); // symbolKey -> tail promise of that symbol's chain

function runExclusive(rawSymbol, task) {
  const key = String(rawSymbol || '(unscoped)').toUpperCase();
  const previous = instrumentLocks.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  instrumentLocks.set(key, run.catch(() => {})); // never let a rejection wedge the chain
  return run;
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
  const requestSymbol = payload.symbol ?? payload.Symbol ?? payload.ticker ?? payload.Ticker;

  if (shouldOpenTrade || shouldClosePositions) {
    const intent = shouldOpenTrade ? `OPEN ${String(payload.type).toUpperCase()}` : 'CLOSE';
    if (shouldClosePositions && !requestSymbol) {
      log(`WARNING: ${intent} request on ${requestPath} has no "symbol" field — this will close ALL open positions account-wide, not one instrument. Symbol: (none)`);
    } else {
      log(`${intent} request on ${requestPath} — Symbol: ${requestSymbol ?? '(none)'}`);
    }
  }

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
    // Ack immediately — TradingView only needs a prompt 200 to consider this
    // delivered. The full TradeLocker/Telegram round-trip (up to 8 sequential
    // outbound calls) used to run before responding; if TradingView's own
    // delivery timeout was shorter than that chain, or a call in it was slow
    // or rate-limited, the late/failed response triggered a TradingView retry
    // — which is what piled duplicate open/close requests on top of each
    // other in the 2026-08-11 incident. Failures are still reported (via the
    // Telegram alert below), just not via the HTTP status anymore.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ACCEPTED' }));

    runExclusive(requestSymbol, async () => {
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

        try {
          await sendTelegramMessageWithButton(
            `Kill switch for ${tradeResult.instrumentName}`,
            `🔴 Close ${tradeResult.instrumentName}`,
            `close:${tradeResult.instrumentName}`
          );
          startTelegramPollingSession(); // fire-and-forget; no-op if a session is already active
        } catch (tgErr) {
          log(`Failed to send close-trade button to Telegram: ${tgErr.message}`);
        }
      } catch (err) {
        log(`Trade creation failed: ${err.message}`);

        try {
          await sendTelegramMessage(`❌ Trade Execution FAILED\nSymbol: ${payload.symbol || payload.ticker || 'Unknown'}\nError: ${err.message}`);
        } catch (_) {}
      }
    });
  // -------------------------------------------------------------------
  // TradeLocker Close Position Endpoint
  // -------------------------------------------------------------------
  } else if (shouldClosePositions) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ACCEPTED' }));

    runExclusive(requestSymbol, async () => {
      try {
        const closed = await closeAllTradeLockerPositions(requestSymbol);
        log(`Closed ${closed.length} TradeLocker position(s)${requestSymbol ? ` for ${requestSymbol}` : ''}: ${JSON.stringify(closed)}`);

        const telegramText = closed.length > 0
          ? ['🔒 TradeLocker Position(s) Closed', ...closed.map(formatClosedPositionLine)].join('\n')
          : `ℹ️ Close called${requestSymbol ? ` for ${requestSymbol}` : ''} — no open position to close`;

        try {
          await sendTelegramMessage(telegramText);
          log(`Close alert sent to Telegram: ${telegramText.replace(/\n/g, ' | ')}`);
        } catch (tgErr) {
          log(`Failed to send close alert to Telegram: ${tgErr.message}`);
        }
      } catch (err) {
        log(`Position close failed: ${err.message}`);

        try {
          await sendTelegramMessage(`❌ Position Close FAILED\nError: ${err.message}`);
        } catch (_) {}
      }
    });
  }
});

server.listen(config.port, config.ip, () => {
  log(`Webhook server listening on http://${config.ip}:${config.port} (Webhook: ${config.webhookPath}, Trade: ${config.tradePath}, Health: ${config.healthPath})`);
});

corroborateTradeContextWithLivePositions();

const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
setInterval(checkForExternallyClosedTrades, RECONCILIATION_INTERVAL_MS);
log('Reconciliation check scheduled every 15 minutes.');

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
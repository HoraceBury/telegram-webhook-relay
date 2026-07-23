'use strict';
/**
 * TradingView -> Telegram webhook relay
 * ---------------------------------------
 * Listens for POST requests from a TradingView alert, validates a GUID
 * embedded in the JSON body against config.json, and forwards everything
 * else in the payload to a Telegram chat.
 *
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
  return cfg;
}

let config = loadConfig();
log(`Config loaded. Listening path: ${config.webhookPath}, port: ${config.port}`);

// Reload config.json automatically if you edit it (e.g. rotate the GUID)
// without needing to restart the process.
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
  if (requestPath !== config.webhookPath) {
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
    log(`Rejected request: GUID mismatch (received "${incomingGuid}").`);
    return;
  }

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
});

server.listen(config.port, config.ip, () => {
  log(`Webhook server listening on http://${config.ip}:${config.port}${config.webhookPath}`);
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
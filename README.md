# TradingView → Telegram Webhook Relay & TradeLocker Execution

A tiny Node.js server for a Windows VPS with three jobs:

- **`/webhook`** — TradingView alert → forwarded straight to your Telegram chat.
- **`/trade`** — TradingView alert → validated, sized, and placed as a live (or dry-run) market order on TradeLocker, with a Telegram execution report. The **same endpoint also handles closing** — see Section 6B.
- **`/close`** — closes open position(s), optionally scoped to one instrument.

Plus a **Telegram "Close" button**: every trade-opened message is followed
by a message with a button that closes that instrument's position(s)
directly from Telegram — see Section 6D.

Why Node.js over C# here: this is a handful of lightweight HTTP endpoints
doing I/O (accept request → a few outbound HTTPS calls → respond). Node's
event loop handles that with a very small idle memory/CPU footprint and
no JIT warm-up or GC pauses of any real size at this scale. A C#/.NET
service would do the job fine too, but carries a heavier baseline
(runtime + GC + larger working set) for the same amount of work, so
Node is the lighter choice for this workload.

## 1. Install required components

Open PowerShell **as Administrator** on the VPS and run these in order.

**Git** (only needed if you'll pull files onto the VPS via a repo rather
than copying them directly — install it now regardless, it's handy to
have):

```powershell
winget install --id Git.Git -e --source winget
```

**Node.js** (LTS — the script uses the built-in `fetch`, so Node 18+ is
required; no npm packages needed):

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell after these finish, so both get picked up on
`PATH`, then confirm:

```powershell
git --version
node -v
npm -v
```

Keeping these updated later is the same pattern:

```powershell
winget upgrade --id Git.Git
winget upgrade OpenJS.NodeJS.LTS
```

> If `winget` isn't available on this VPS image, see the fallback
> install methods (Chocolatey, direct installer) discussed earlier in
> this conversation — the winget path above is the quickest when it's
> available.

## 2. Set up your Telegram bot

Telegram messages come from a bot you create, delivered straight to a
private chat with it — no channel or server required.

1. Open Telegram, search for **@BotFather**, and send `/newbot`. Follow
   the prompts (it'll ask for a name and a username for your bot).
   BotFather replies with a **bot token** — a string like
   `123456789:ABC-defGhIjKlmNoPQRsTuVwxyZ`. Save this.
2. Search for your new bot by the username you gave it, open a chat with
   it, and send it any message (e.g. "hi"). This lets the bot "see" you
   — it can't message you until you've messaged it first.
3. Get your **chat ID**: message **@userinfobot** and it'll reply with
   your numeric ID. (Alternatively, after step 2, visit
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
   and read the `chat.id` field from the JSON response.)

You should now have two values: a **bot token** and a **chat ID**. You'll
put both in `config.json` in the next step.

To sanity-check them before wiring up the whole app, you can test with a
plain HTTP request (e.g. in Postman):

- **Method:** `POST`
- **URL:** `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage`
- **Body (raw JSON):**
  ```json
  {
    "chat_id": "<YOUR_CHAT_ID>",
    "text": "Test message"
  }
  ```

If it's set up correctly, that message shows up instantly in your chat
with the bot.

## 3. Copy the files

Put `webhook-server.js` and `config.json` in the same folder on the VPS,
e.g. `C:\tv-webhook\`.

## 4. Fill in config.json

```json
{
  "port": 80,
  "ip": "<your-vps-ip>",
  "webhookPath": "/webhook",
  "tradePath": "/trade",
  "closePath": "/close",
  "healthPath": "/health",
  "guid": "REPLACE-WITH-A-RANDOM-GUID",
  "telegramBotToken": "REPLACE-WITH-YOUR-BOT-TOKEN",
  "telegramChatId": "REPLACE-WITH-YOUR-CHAT-ID",
  "tradelockerEnvironment": "https://demo.tradelocker.com",
  "tradelockerEmail": "REPLACE-WITH-TRADELOCKER-EMAIL",
  "tradelockerPassword": "REPLACE-WITH-TRADELOCKER-PASSWORD",
  "tradelockerServer": "REPLACE-WITH-TRADELOCKER-SERVER",
  "tradelockerAccountId": "",
  "tradelockerAccNum": "",
  "tradelockerDefaultQty": 0.01,
  "riskPercentage": 1,
  "maxOpenTrades": 1,
  "dryRun": false
}
```

- **guid** — any random GUID, used as a shared secret. Generate one in
  PowerShell with:
  ```powershell
  [guid]::NewGuid()
  ```
- **telegramBotToken** / **telegramChatId** — the two values from step 2
  above.
- **port** — TradingView only allows webhooks on port 80, so this needs
  to be `80`. Binding to port 80 on Windows requires running the process
  elevated (or fronting it with a reverse proxy) — see Section 7 if you
  hit a permissions error on startup.
- **ip** — the VPS's actual network-adapter IP (check with `ipconfig`
  on the VPS). Binding to a specific IP rather than all interfaces is a
  deliberate choice here; if you ever need to test locally on the VPS,
  use this IP rather than `localhost`, since the app won't be listening
  on the loopback address.
- **webhookPath** — the URL path for simple Telegram notification forwarding (default `/webhook`).
- **tradePath** — the URL path for TradeLocker order placement **and** closing (default `/trade`). See Section 6B — whether it opens or closes depends on the payload, not the URL.
- **closePath** — an alternate, close-only URL if you'd rather keep it separate from `/trade` (default `/close`).
- **healthPath** — the URL path for the health check endpoint (default `/health`).
- **tradelockerEnvironment** — `https://demo.tradelocker.com` or `https://live.tradelocker.com`.
- **tradelockerEmail** — Your TradeLocker login email address.
- **tradelockerPassword** — Your TradeLocker login password.
- **tradelockerServer** — Broker server name (as selected during TradeLocker login).
- **tradelockerAccountId** / **tradelockerAccNum** — (Optional) Specific account ID / account number. If left blank, the server will auto-detect your active TradeLocker account.

  **Important:** these two values must come from the **same** account —
  they're a pair, not independent settings. TradeLocker's `accNum` is a
  small internal number (e.g. `1`, `2`) and is **not** the account number
  shown in your broker's dashboard (e.g. PlexyTrade) — don't use that
  one. If you have more than one account (e.g. multiple demo accounts)
  and need to pick a specific one:

  1. Leave both fields blank and send a `/trade` request with
     `"dryRun": true`.
  2. Check `webhook.log` for a line like:
     ```
     TradeLocker accounts found: [{"id":"1111111","accNum":"1","name":"...","status":"ACTIVE","accountBalance":"994.54"},{"id":"2222222","accNum":"2","name":"...","status":"ACTIVE","accountBalance":"1000.00"}]
     ```
     This lists every account visible to your login.
  3. Pick the account you want by its `accountBalance`/`name`, then copy
     its `id` **and** `accNum` from that *same* object into
     `tradelockerAccountId` and `tradelockerAccNum`. Mixing the `id` from
     one account with the `accNum` from another returns
     `"Account not found!"` when placing a trade.

  Auto-detect (leaving both blank) picks the first account marked
  `ACTIVE`, which may not be the one you intend if you have several
  active accounts — setting both explicitly avoids that ambiguity.
- **tradelockerDefaultQty** — Fallback trade lot size (e.g. `0.01`) used only if position sizing can't be calculated (e.g. stop-loss distance is zero).
- **riskPercentage** — Percentage of current account balance to risk per trade (default `1` for 1%).
- **maxOpenTrades** — Maximum simultaneously open positions **per instrument**. A `/trade` open request for a given symbol is rejected once that symbol already has this many positions open — a GBPUSD position doesn't block a new EURUSD or BTCUSD trade.
- **dryRun** — Set to `true` to block real order placement account-wide (see the dryRun rules below — this cannot be overridden into a live trade by the payload).

You can edit `config.json` later (e.g. to rotate the GUID or update credentials) without
restarting the process — the server watches the file and reloads it
automatically.

## 5. Run it

```powershell
cd C:\tv-webhook
node webhook-server.js
```

You should see a log line confirming it's listening. Leave this running
— see step 8 for making it survive reboots/logouts.

Quick health check once it's running — a plain `GET` to confirm the
server itself is reachable, independent of the webhook logic:

```
http://<your-vps-ip>/health
```

This should return `OK`.

## 6. Set up TradingView alerts

### A. Telegram Notification Relay (`/webhook`)

Set the **Webhook URL** to:

```
http://<your-vps-public-ip-or-domain>:80/webhook
```

Set the **Message** to JSON containing your GUID plus whatever
fields you want in the Telegram message, e.g.:

```json
{
  "guid": "paste-the-same-guid-from-config.json",
  "symbol": "{{ticker}}",
  "action": "BUY",
  "price": "{{close}}",
  "time": "{{time}}"
}
```

Every field except `guid` is forwarded to Telegram as `key: value` lines.

### B. TradeLocker Order Execution & Close (`/trade`)

Set the **Webhook URL** to:

```
http://<your-vps-public-ip-or-domain>:80/trade
```

**This single URL handles both opening and closing trades.** The server
looks at whether the payload has a `type` field: present → open a trade;
absent → close position(s) for that `symbol`. This means one TradingView
alert (one fixed webhook URL, since TradingView only lets you set one per
alert) can drive your whole open/close cycle — exactly what the
accompanying Pine indicator's `alert()` calls are built to do.

**To open a trade**, the message needs your GUID, symbol, trade direction
(`type`), take profit (`tp`), and stop loss (`sl`):

```json
{
  "guid": "paste-the-same-guid-from-config.json",
  "symbol": "{{ticker}}",
  "type": "BUY",
  "tp": "1.10500",
  "sl": "1.10200"
}
```

**Required fields to open:** `guid`, `symbol`, `type` (`"buy"` or `"sell"`), `tp`, `sl`.

- **Market order only, no `entry` field** — every open executes at the
  live market price fetched from TradeLocker at the moment the request is
  processed. There's no pending/limit order support here, so don't send
  an `entry` value; it's ignored if you do.
- **`sl` is required, not calculated** — you must supply the stop loss
  directly. It's not derived automatically from `entry`/`tp`.
- **Quantity is always calculated, not accepted from the payload** — the
  server fetches your live TradeLocker account balance and sizes the
  trade so it risks `riskPercentage` (from `config.json`) of that balance,
  based on the distance between the live entry price and your `sl`. You
  cannot override this by sending a `qty` field. The result is floored to
  the instrument's minimum lot size (see the sizing caveat in Section 9).
- **Max open trades check is per instrument** — see `maxOpenTrades` above.
- **dryRun** — you can optionally include `"dryRun": true` or `"dryRun": false`
  in the payload. See the rules below — a payload can only ever prevent a
  live trade, never force one through.

**To close a trade**, omit `type` — just send `guid` and `symbol`:

```json
{
  "guid": "paste-the-same-guid-from-config.json",
  "symbol": "{{ticker}}"
}
```

This closes only the position(s) open on that specific symbol, not the
whole account.

#### Contract size caveat

If TradeLocker doesn't report a real lot size for an instrument, the
server guesses (`100000` for standard 6-letter FX pairs, `1` for known
crypto tickers and everything else) and logs a `WARNING: ... guessing
contractSize=...` line whenever this happens. Check `webhook.log` for
that warning on any new symbol before trusting its position sizing —
a wrong guess here silently skews how much is actually risked.

#### dryRun rules

A real, live trade is placed **only if both** `config.json`'s `dryRun`
**and** the payload's `dryRun` evaluate to `false`. If either one is
`true`, the request is treated as a dry run — everything runs (auth,
instrument lookup, position sizing, logging, Telegram alert) except the
actual order isn't sent to the broker.

| `config.json` `dryRun` | payload `dryRun` | Result |
|---|---|---|
| `true` | any value, or omitted | Dry run — no live trade |
| `false` | omitted | **Live trade** |
| `false` | `false` | **Live trade** |
| `false` | `true` | Dry run — no live trade |

In short: `true` anywhere wins. The payload can only ever make a trade
*safer* (force a dry run), never turn a config-level dry run into a real
one. (This flag only affects opening; closing always executes for real,
dry-run or not — closing a position that doesn't exist is harmless and
just responds with "no open position.")

### C. Close-Only Endpoint (`/close`)

An alternative to sending a typeless `/trade` request — functionally
identical, kept as a separate URL if you'd rather not rely on payload
shape for routing.

```
http://<your-vps-public-ip-or-domain>:80/close
```

```json
{
  "guid": "paste-the-same-guid-from-config.json",
  "symbol": "{{ticker}}"
}
```

`symbol` is optional here: if omitted, **every** open position on the
account is closed, not just one instrument. Include it to scope the
close to a single symbol, same as `/trade`'s close behavior.

### D. Telegram "Close" Button

Every successful trade-open (live or dry-run) triggers a second Telegram
message, right after the execution report, with a single button:

```
🔴 Close <instrument>
```

Pressing it closes that instrument's open position(s) — same effect as
sending a typeless `/trade`/`/close` request for that symbol — and posts
a confirmation back to the chat.

**How it works:** Telegram delivers button presses as "callback queries."
Real-time push delivery would need an HTTPS webhook from Telegram's side,
which this server doesn't have (see Section 9's note on TLS), so instead
the server **long-polls** Telegram (asks for updates, Telegram holds the
connection open until something happens or ~30s elapses) for up to 10
polls — about **5 minutes** — after a trade opens, then stops. Only one
polling session runs at a time; if a trade opens while a session from an
earlier trade is still active, it doesn't start a second one — the
existing session still catches the new button press too. If you press
"Close" more than ~5 minutes after the most recent trade (with no other
trade having opened since to restart the window), the button won't work;
use `/close` or the indicator's own close signal instead in that case.

## 7. Running on port 80

TradingView restricts webhooks to port 80, which on Windows means either:

- Running the Node process elevated (as Administrator), or
- Fronting it with a reverse proxy (IIS, Caddy, nginx) that owns port 80
  and forwards to the app on an unprivileged port — also the way to add
  TLS (see Section 9).

If another app on the VPS is already using port 80, see `Diagnostic.md`
for how to check what's bound to it and work around it.

## 8. Keep it running (as a Windows service)

Running `node webhook-server.js` in a plain console window stops when
you log out. To keep it running in the background, the simplest options:

**Option A — NSSM (recommended, free)**
1. Download NSSM (nssm.cc) and extract it to the VPS.
2. Run:
   ```powershell
   nssm install TVWebhook
   ```
3. In the dialog: Path = your `node.exe` location, Arguments =
   `webhook-server.js`, Startup directory = `C:\tv-webhook`.
4. Start it: `nssm start TVWebhook`. It'll now auto-start on boot and
   restart if it crashes.

**Option B — Windows Task Scheduler**
Create a task that runs `node.exe C:\tv-webhook\webhook-server.js` at
system startup, with "Run whether user is logged on or not" checked.

## 9. Security notes

- **Open only the port you need** in the Windows Firewall (and your
  VPS provider's firewall/security group), pointing at this app. See
  `Diagnostic.md` if requests aren't reaching the app — a misconfigured
  or missing firewall rule is the most common cause. `Diagnostic.md`
  also covers scoping inbound port 80 to TradingView's published IPs
  once you're done testing, to cut down on internet scan noise.
- The GUID protects against random internet traffic hitting the
  endpoint, but it travels in plain text if you use `http://`. If you
  want it encrypted in transit, put a reverse proxy in front (IIS with
  a URL Rewrite/ARR module, or Caddy/nginx) with a free TLS cert (e.g.
  via Let's Encrypt/win-acme) and point TradingView at the `https://`
  URL instead, forwarding to this app's local port. (This would also
  let you switch the Telegram "Close" button to real-time webhook
  delivery instead of long-polling, if you ever want that.)
- Treat the GUID like a password — don't post it anywhere public, and
  rotate it if you ever suspect it's leaked (just edit `config.json`,
  no restart needed).
- Treat the Telegram bot token the same way — anyone with it can send
  messages as your bot (though not read your other chats).
- `webhook.log` in the same folder records every accepted/rejected
  request, useful for confirming TradingView is calling correctly.
- The calculated quantity is floored at the instrument's minimum lot
  size (typically 0.01). On very small accounts with a wide stop loss,
  this floor can mean the actual risk taken exceeds `riskPercentage` —
  the position simply can't be sized any smaller.
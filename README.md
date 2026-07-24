# TradingView → Telegram Webhook Relay

A tiny Node.js server for a Windows VPS: TradingView calls it on alert,
it checks a GUID, and forwards everything else in the alert to your
Telegram chat.

Why Node.js over C# here: this is a single lightweight HTTP endpoint doing
I/O (accept request → one outbound HTTPS call → respond). Node's event
loop handles that with a very small idle memory/CPU footprint and no
JIT warm-up or GC pauses of any real size at this scale. A C#/.NET
service would do the job fine too, but carries a heavier baseline
(runtime + GC + larger working set) for the same amount of work, so
Node is the lighter choice for this specific workload.

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
- **tradePath** — the URL path for TradeLocker automated order placement (default `/trade`).
- **healthPath** — the URL path for health check endpoint (default `/health`).
- **tradelockerEnvironment** — `https://demo.tradelocker.com` or `https://live.tradelocker.com`.
- **tradelockerEmail** — Your TradeLocker login email address.
- **tradelockerPassword** — Your TradeLocker login password.
- **tradelockerServer** — Broker server name (as selected during TradeLocker login).
- **tradelockerAccountId** / **tradelockerAccNum** — (Optional) Specific account ID / account number. If left blank, the server will auto-detect your active TradeLocker account.
- **tradelockerDefaultQty** — Fallback trade lot size (e.g. `0.01`) if position sizing cannot be calculated.
- **riskPercentage** — Percentage of current account balance to risk per trade (default `1` for 1%).
- **dryRun** — Set to `true` for dry-run simulation mode (runs all authentication, calculations, and logging, but skips sending the actual trade order to the broker).

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

### B. TradeLocker Order Execution (`/trade`)

Set the **Webhook URL** to:

```
http://<your-vps-public-ip-or-domain>:80/trade
```

Set the **Message** to JSON containing your GUID, symbol, side/action, entry, and take profit (`tp`):

```json
{
  "guid": "paste-the-same-guid-from-config.json",
  "symbol": "{{ticker}}",
  "action": "BUY",
  "entry": "{{close}}",
  "tp": "1.1050",
  "type": "market"
}
```

#### Automatic 1:1 Risk-to-Reward & Risk-Based Position Sizing:
- **1:1 Stop Loss Calculation**: When `entry` and `tp` (Take Profit) are provided in the alert payload and `sl` is omitted, the server automatically calculates the **1:1 Stop Loss** (`entry - TP_distance` for BUY, or `entry + TP_distance` for SELL). You can still pass an explicit `"sl"` in the JSON payload to override this.
- **Dynamic 1% Position Sizing**: If `"qty"` is omitted from the alert payload, the server fetches your current TradeLocker account balance and calculates the exact lot size so that the trade risks your configured percentage (`riskPercentage` in `config.json`, default **1%**). You can still pass an explicit `"qty"` to override automated position sizing.
- The server connects to TradeLocker via API, matches the symbol to the account's tradable instruments, places the trade with the entry, TP, calculated 1:1 SL, and risk-sized lot quantity, and forwards an execution summary to your Telegram chat.

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
  or missing firewall rule is the most common cause.
- The GUID protects against random internet traffic hitting the
  endpoint, but it travels in plain text if you use `http://`. If you
  want it encrypted in transit, put a reverse proxy in front (IIS with
  a URL Rewrite/ARR module, or Caddy/nginx) with a free TLS cert (e.g.
  via Let's Encrypt/win-acme) and point TradingView at the `https://`
  URL instead, forwarding to this app's local port.
- Treat the GUID like a password — don't post it anywhere public, and
  rotate it if you ever suspect it's leaked (just edit `config.json`,
  no restart needed).
- Treat the Telegram bot token the same way — anyone with it can send
  messages as your bot (though not read your other chats).
- `webhook.log` in the same folder records every accepted/rejected
  request, useful for confirming TradingView is calling correctly.
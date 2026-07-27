# Diagnostic.md — TradingView Webhook Relay Troubleshooting

Runbook for diagnosing connectivity issues (e.g. `Error: socket hang up`,
timeouts, or "Unable to connect") with the webhook relay on the Windows VPS.

Work through these in order — each step narrows down which layer the
problem is in before you start changing things.

---

## 0. Symptom recap (what we solved before)

- Postman/curl to `/health` or `/webhook` → `Error: socket hang up`
- `webhook.log` showed the server started and was listening, but **no
  "Incoming ..." line** for the failed requests
- `nc -vz <ip> 80` from another machine → **succeeded** (raw TCP handshake
  was fine)
- `Invoke-WebRequest http://localhost/health` on the VPS itself →
  **"Unable to connect to the remote server"**
- Temporarily disabling Windows Firewall (`netsh advfirewall set
  allprofiles state off`) → requests immediately started working

**Root cause:** Windows Firewall was resetting the connection after the
TCP handshake but before the HTTP request reached Node — hence a
completed `nc` handshake, but a "hang up" instead of a real HTTP
response. Fixed by adding a properly scoped inbound firewall rule for
port 80.

---

## 1. Confirm the app is actually running and listening

```powershell
Get-Process -Name node
```

Check `webhook.log` for the startup lines:
```
Config loaded. Listening path: /webhook, port: 80
Webhook server listening on http://<ip>:80/webhook
```

If these aren't present, the problem is the app itself (crashed, bad
config, port already in use) — not networking. Check the console output
for a stack trace.

---

## 2. Check if the request reaches the app at all

The server logs an `Incoming <METHOD> <URL> from <IP>` line for every
request it receives, before any validation.

- Send a test request (Postman, curl, or a browser hitting `/health`).
- Immediately check `webhook.log`.

**"Incoming ..." line appears** → the request is reaching Node. The
problem is in the app's handling of it (check the log lines further down
for rejections, or a Telegram send failure) — skip to Step 6.

**No "Incoming ..." line at all** → the request is NOT reaching Node.
The problem is somewhere in the network path between the client and the
Node process. Continue to Step 3.

---

## 3. Test raw TCP reachability (bypass HTTP entirely)

From a **different machine** than the VPS (e.g. your laptop):

```bash
nc -vz <vps-ip> 80          # macOS/Linux
```
```powershell
Test-NetConnection -ComputerName <vps-ip> -Port 80   # Windows
```

- **Succeeds** → the TCP handshake completes fine. This narrows the
  problem to something that resets the connection *after* the handshake
  but before/during the HTTP exchange — almost always Windows Firewall
  or a security/AV agent. Go to Step 4.
- **Fails** → this is a lower-level networking problem: the VPS
  provider's firewall/security group (a layer outside Windows entirely),
  a misconfigured NIC binding, or the app not actually listening on that
  IP. Go to Step 5.

---

## 4. Test locally on the VPS itself

```powershell
Invoke-WebRequest -Uri "http://<config.ip>/health"
```

> Note: if the app is bound to a specific IP (not `0.0.0.0`), don't use
> `localhost` here — it won't connect even if everything else is fine,
> since Node isn't listening on the loopback address. Use the same IP
> that's in `config.json`.

- **Works locally, fails remotely** → confirms it's something in the
  network path *external* to the app itself (firewall almost certainly).
  Continue below.
- **Fails locally too** → the app isn't actually listening where you
  think it is. Re-check `config.json`'s `ip`/`port` values and the
  `ipconfig` output on the VPS to make sure they match.

### 4a. Isolate Windows Firewall as the cause

Temporarily disable it (diagnostic only — turn back on immediately after
testing):

```powershell
netsh advfirewall set allprofiles state off
```

Re-test from Postman/curl. If it now works, Windows Firewall is
confirmed as the cause. Re-enable it right away:

```powershell
netsh advfirewall set allprofiles state on
```

### 4b. Add a correctly scoped firewall rule

```powershell
New-NetFirewallRule -DisplayName "Allow HTTP 80" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Any
```

`-Profile Any` matters — a rule scoped only to `Domain`/`Private` won't
apply if the VPS's active network adapter is on the `Public` profile,
and the rule will silently do nothing.

Verify it's really active:

```powershell
Get-NetFirewallRule -DisplayName "Allow HTTP 80" | Select-Object DisplayName, Enabled, Direction, Action, Profile
```

Check for conflicting/duplicate rules on the same port, which can behave
unpredictably:

```powershell
Get-NetFirewallRule -Direction Inbound | Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -eq 80 }
```

Re-test from Postman. This resolved it last time.

---

## 5. If raw TCP itself fails (Step 3 failed)

Check, in this order:

1. **VPS provider's firewall/security group** (AWS security groups,
   Azure NSGs, DigitalOcean/Vultr cloud firewall, etc.) — a layer
   outside Windows entirely. Confirm inbound TCP 80 is allowed from your
   IP (or from anywhere, while testing) in the provider's dashboard.
2. **The app's bind address** — confirm `config.ip` in `config.json`
   matches an address actually assigned to the VPS's NIC:
   ```powershell
   ipconfig
   ```
3. **Another process already on port 80** — this app won't start if
   something else has already claimed the port. Check for it before
   assuming networking is the issue:
   ```powershell
   netstat -ano | findstr ":80"
   ```

---

## 6. If the request reaches the app but still fails

Check `webhook.log` for the specific rejection reason logged right after
the "Incoming ..." line:

- `Rejected request: invalid JSON body` → body sent wasn't valid JSON
- `Rejected request: GUID mismatch` → GUID in the request doesn't match
  `config.json`
- `Telegram send failed: ...` → the app reached the request fine, but
  the outbound call to Telegram's API failed or timed out (check VPS
  outbound internet access / outbound firewall rules to
  `api.telegram.org`)

---

## 7. Third-party security software (if nothing above explains it)

Some VPS providers pre-install endpoint protection or intrusion
prevention agents that can transparently intercept and reset inbound
connections on common ports, independent of Windows Firewall. If none of
the above resolves it, check what security software is installed on the
VPS beyond Windows Firewall itself.

---

## 8. Switching between testing (broad) and production (scoped) firewall rules

Use the **broad rule** (any source IP) while actively testing with
Postman/curl from your own machine. Switch to the **scoped rule**
(TradingView's published IPs only, plus your own) once testing is done
and the alert is live, to reduce exposure to internet scanning noise and
unauthorized requests.

Only one of these two should be active on port 80 at a time — having
both enabled simultaneously doesn't combine their restrictions; the
broader "Allow Any" rule silently permits everything regardless of the
scoped rule also being present. Always confirm only one is `Enabled:
True` after switching (see the check at the end of this section).

### 8a. Testing mode (broad rule)

```powershell
Set-NetFirewallRule -DisplayName "Allow HTTP 80" -RemoteAddress Any -Enabled True
```

If a separate scoped rule already exists from a previous production
period, disable it so it isn't redundantly active:

```powershell
Get-NetFirewallRule -DisplayName "Allow HTTP 80 - TradingView Only" -ErrorAction SilentlyContinue | Disable-NetFirewallRule
```

Test as normal from Postman/curl.

### 8b. Production mode (TradingView-scoped rule)

TradingView's published webhook-sending IPs (see
https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/
— recheck this page periodically, as the list isn't guaranteed
permanent):

```
52.89.214.238
34.212.75.30
54.218.53.128
52.32.178.7
```

Scope the existing rule down to just these, plus your own IP (so you can
still reach it directly if needed):

```powershell
Set-NetFirewallRule -DisplayName "Allow HTTP 80" -RemoteAddress 52.89.214.238,34.212.75.30,54.218.53.128,52.32.178.7,<your-ip> -Enabled True
```

If you'd rather keep testing and production as two separate named rules
instead of editing one rule back and forth, create the scoped rule once:

```powershell
New-NetFirewallRule -DisplayName "Allow HTTP 80 - TradingView Only" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Any -RemoteAddress 52.89.214.238,34.212.75.30,54.218.53.128,52.32.178.7,<your-ip>
```

then toggle between the two with `Enable-NetFirewallRule` /
`Disable-NetFirewallRule` on each by name instead of editing scope each
time:

```powershell
# Switch to production (scoped):
Disable-NetFirewallRule -DisplayName "Allow HTTP 80"
Enable-NetFirewallRule -DisplayName "Allow HTTP 80 - TradingView Only"

# Switch back to testing (broad):
Disable-NetFirewallRule -DisplayName "Allow HTTP 80 - TradingView Only"
Enable-NetFirewallRule -DisplayName "Allow HTTP 80"
```

### 8c. Verify only one rule is active

```powershell
Get-NetFirewallRule -Direction Inbound | Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -eq 80 } | Select-Object DisplayName, Enabled, Action
```

Exactly one row should show `Enabled: True` for port 80 — whichever mode
you intend to be in.
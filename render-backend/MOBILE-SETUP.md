# Same account on mobile — V1.66

The laptop runs one Binance Demo bot. The phone displays that same account, balances, positions, scan results and controls. API keys are entered only on the laptop. The phone does not start a second bot.

## One-time connection

1. Update `demo-execution` and `render-backend` together, preserve existing journals, and run `START-LAPTOP.cmd`. Reconnect Binance on the laptop. Do not reset the account or clear browser storage.
2. Keep Tailscale connected on the laptop and phone using the same private network. If not configured yet, run `ENABLE-MOBILE.cmd` on the laptop once and complete its HTTPS setup. The dashboard picks up the private address automatically. The address field is a fallback only.
3. On the laptop dashboard, choose **Mobile — same account**. If the browser currently runs trading, use **Connect laptop / reconnect controls** once to move its matching journal into the background bot. The current local token is reused when available. Unlock saved keys on the laptop if requested; no keys are entered on the phone.
4. Choose **Create phone link — once**, then **Copy phone link**. Open it in the phone browser used for your app, with Tailscale connected. The link lasts two minutes and can be used once. A QR is optional; there is no mandatory scan or typing of API keys.
5. Save the private controller to the home screen, or reopen the existing public app in the same browser/storage context. The public app remembers the private laptop address and opens its controller automatically. Separate browser profiles or standalone storage may need the link opened in that context once.

The phone shows the actual laptop engine version. Refreshing a public website cannot update the laptop's running code. Reconnect and Start once after a connector update; existing recoverable-error retries preserve that Start intent afterward.

## Everyday use

Open the saved phone app. No repeated token, API-key entry or QR scan. The phone refreshes status every three seconds and immediately when it returns to the foreground or regains network access. Closing the phone page does not send Stop. Keep the laptop awake, online, and its connector window open. The phone does not keep the engine alive if the laptop is off.

After a laptop restart, reconnect the same Binance account on the laptop. Remembered phones remain authorized and show that account as soon as it reconnects. API signing keys stay in process memory and are cleared by restart; phone trust does not store or recover them.

## Access and recovery

- Phone authorization uses a Secure, HttpOnly, SameSite=Strict cookie, valid for 30 days and renewed while used. The laptop stores only hashed phone session identifiers, CSRF secrets, expiry, private origin and an account fingerprint in `trusted-phones.json` under the current Windows user's `.btc-demo-laptop` directory. Do not commit or share this directory.
- **Revoke all phones**, explicit laptop Disconnect, a different Binance API key, or a different private origin removes remembered phone access. Revocation is persisted across restarts and does not itself stop trading.
- If access expires or browser cookies are cleared, create a new one-time phone link. A link is a temporary authorization: share it only with your own phone. API keys and the laptop token are never included.
- To stop a public browser from reopening the saved private address, open the public `demo-connect.html?local=1` page in that same browser. This forgets the address only; it does not revoke private phone access or stop the laptop.
- A lost phone connection does not confirm a stop; the laptop may still trade. Commands retain unique request IDs. An unknown result must be synced/reconciled before repeating a close.

The connector binds to `127.0.0.1:10000`. Tailscale Serve supplies private HTTPS; no public Funnel or router port opening is needed. This does not bypass Binance regional restrictions. The public app stores only the validated private address; sensitive state and commands are not cached by its service worker.

Validation: `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs`. Automated tests use fake accounts and do not place exchange orders.


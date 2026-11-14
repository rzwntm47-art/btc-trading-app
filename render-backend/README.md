## V1.78 — small net profits toward the $20 session target

The V1.77 report showed 962 checks, 102 preliminary setups, 102 app-filter skips and no entry submissions. A recorded TAKEUSDT candidate reached the final live-quote check but failed because bid and ask stayed unchanged over a few seconds. This version accepts two fresh, timestamp-advancing quote updates that are stable or favorable when the closed candle confirms direction. It still rejects reversals, widening spreads, stale data, opposing forming candles and late price chases. Compare the candle trade price with the quote midpoint; all order economics still use executable prices. This removes that recorded filter failure without treating every gainer or loser as an entry.

Both entry paths now close the remaining position at **$1 estimated total trade net or more**; $2/$3 seen on a later check also trigger a close. There is no wait for a $5 profit or a pullback. Re-read current position, matched fills/fees and executable closing price before submission; hold if the fresh estimate falls below $1. Paid commissions, realized partial results, funding, depth when required and expected closing fees remain included. The reference-target minimum net is reduced from $5 to $1. Fee-ratio, margin, leverage and volatility limits remain.

Existing bot positions migrate to `rulesVersion: 13`, `exitPolicy: 'small-net-profit'` on reconciliation without changing size, ownership or leverage. Keep $2–$6 adverse-move exits, the normal $6 loss decision, $12 exchange backup, the $20 session close/stop, counter reset and order-recovery protections. Unknown close results remain journaled and cannot be blindly repeated. The engine must stay running for small-profit exits. Estimates and market fills can differ; tests do not demonstrate profitable performance.

Install both `demo-execution` and `render-backend`, run `START-LAPTOP.cmd`, reconnect, then **Sync Binance → Start / Resume Demo**. Check both page and laptop engine show **V1.78**. Publishing this update does not replace files in an already-running laptop connector. No trade history deletion or counter reset is required to install it.

## V1.77 — additional trend-continuation entries

The scanner previously considered only Bollinger/Williams %R rebounds. V1.76 diagnostics confirmed successful scanning but all preliminary setups were filtered. Add a separate continuation candidate for the same current gainers and losers: aligned closed 1m/5m trends, a directional 1m candle, relative volume, and no overextended candle. Keep all 14 Bollinger timeframes and their existing rules. Both paths share the existing candle datasets; a trend data failure does not suppress an otherwise valid band setup.

Recheck fresh 1m and 5m candles for a selected trend entry and require the existing advancing bid/ask confirmation immediately before dispatch. Keep $300 margin, select lower leverage when needed for one 1m ATR plus spread and fees to fit the $6 entry-risk budget, and retain commission limits and at least $5 estimated net at the reference move. The trend reference is two observed 1m ATRs from the setup; it is a cost-screening scenario, not a forecast or a fixed take-profit.

Both entry paths use the existing $2–$6 adverse-move exit, normal $6 loss decision, $12 exchange backup, $5/$8/$11/+3 net profit pullbacks, and $20 net session close/stop. Manual Stop, duplicate-order prevention, reconciliation and counter reset remain. Tests use simulated exchange responses and do not establish profitable performance.

Install both `demo-execution` and `render-backend`, run `START-LAPTOP.cmd`, reconnect and use **Sync Binance → Start / Resume Demo**. Verify laptop engine and page show V1.77. The setup list and trade diagnostics identify which entry path was selected.

## V1.76 — release startup after confirmed flat Binance state

A saved FILLED entry could still block startup forever in V1.75 when execution history did not show its complete closing fills. The scanner had checked zero coins, even while all Binance reads succeeded.

The existing exact-fill recovery remains. If closing history is incomplete, an entry settled for at least 60 seconds can also be archived after two fresh checks at least 5 seconds apart confirm the same FILLED order, zero exposure in both account and symbol-position responses, and no basic or conditional orders on that symbol. A final account/position/order recheck is required. Inconsistent, failed or slow reads reset confirmation; live positions retain their bot ownership and protection. No entry is replayed and no exchange order is canceled by this recovery.

The journal retains the record with `closingHistoryConfirmed: false` and `closingTimeKnown: false`; its archival time starts the existing 10-minute same-symbol cooldown. No realized profit/loss is invented, and the result counter is not reset. Explicit Start resumes normal scanning after all checks pass; manual Stop remains stopped. Copy scan diagnostics now includes pending record reasons and recent recovery evidence.

Install both `demo-execution` and `render-backend`, run `START-LAPTOP.cmd`, reconnect, then **Sync Binance → Start / Resume Demo**. Verify both page and laptop engine show V1.76. The $20 target, gainers/losers selection and all strategy/risk rules are unchanged.

## V1.75 — filled-entry reconciliation

Update both code folders and restart START-LAPTOP.cmd to load the fix for FILLED entries that closed before the engine observed an open position. Reconnect, Sync Binance, then Start / Resume if stopped. Recovery verifies matching entry and closing fills and fresh flat/no-order state, preserving the trade journal. It never replays the entry. No new relay endpoints or trading rules are added. The $20 target and counter-reset behavior are unchanged.

## V1.74 — reset the counter without clearing trading state

The new `resetResult` command reads account/position data, saves a fresh result window and opening unrealized baseline, and returns a sequence/time confirmation. It preserves all existing records and protection, so open positions or protective orders do not block this counter action. Auto remains stopped. The command is available to authenticated laptop and paired-phone controllers and retains command-ID deduplication. The older full-journal `reset` command remains host-only.

Status explicitly advertises counter reset support. The website will show the actual running version and installation steps when the connector has not been updated. Install both code folders, run START-LAPTOP.cmd and reconnect; refreshing only the website cannot update local code.

## V1.73 — zero the result when Reset succeeds

Update `demo-execution` and `render-backend` together, run `START-LAPTOP.cmd`, and reconnect. **Reset result to $0** saves a fresh session boundary and broadcasts the zero result to laptop and phone immediately. Previous bot records stay archived, the wallet is unchanged, and Auto stays stopped. Existing flat-position and pending-order checks remain. Later refreshes query only the new result window; late responses cannot restore the prior loss. The $20 target and all trading rules are unchanged.

## V1.72 — laptop restart and reconnection

Run `START-LAPTOP.cmd` from the fully extracted project. It checks Node.js 22+ and companion folders before restarting anything. If a V1.72 connector already owns port 10000, the launcher authenticates it with the existing local token, pauses background Auto, waits up to 30 seconds for connecting/pending engine work and accepted relay requests, saves the journal, and starts a fresh connector. It never kills unrelated processes. A timeout or save error leaves the existing connector open with background Auto stopped.

**One-time upgrade from V1.71 or older:** Stop Auto, wait for pending actions, close the old connector window, update `demo-execution` and `render-backend` together, and run `START-LAPTOP.cmd`. Those older running processes do not support the new restart endpoint. Refreshing the website alone cannot update them.

After restart, open the laptop dashboard, choose **Mobile — same account**, enter your saved-key password (or enter Demo keys in **Connect Binance Demo**), then click **Connect laptop / reconnect controls**. Click **Start / Resume Demo** after account checks finish. The dashboard now reveals the reconnection fields and reports the connector version even before Binance connects. API keys remain memory-only; restarting does not start orders automatically.

The profile data in `.btc-demo-laptop`, stable local token, journals, armed exit levels, $20 session latch and remembered phone trust are preserved. Do not reset history or clear saved browser credentials. Restarting cannot resume a session already stopped at its $20 target; the existing New $20 session action still applies when flat.

# Binance Demo backend — Render Free

Deploy this directory as a Node web service. Root directory: `render-backend`. Build command: `npm test`. Start command: `npm start`. No dependencies or Binance secrets are required.

Set `RELAY_TOKEN` using Render's Generate button (at least 32 random characters). Do not commit it or paste it in chat. The health endpoint reports whether it is configured without exposing it.

After deployment, visit `/check-binance`. `ok: true` confirms only the public time endpoint works from the server. Account permissions, open orders and trade protection must still be tested before starting automation. Share only the public Render service URL, not tokens.

The existing dashboard is not yet wired to this service: its assigned URL is needed first. This backend does not autonomously trade. It relays already signed requests only to the fixed Binance Demo host. It never accepts the Binance secret, arbitrary destinations or redirects. Private requests require the backend token; origin checking alone is not authentication. Requests and responses are not logged by this code. Signed query strings are sent to the relay in a POST body, not the browser URL. Rotate the backend token if disclosed.

The free service can sleep/restart and has no durable storage. No unattended 24-hour trading guarantee. Exchange order reconciliation must precede any retry after an ambiguous write failure. Do not use live account credentials.

## V1.66 remembered mobile access

Update both code folders together and restart the connector once. Reconnect Binance on the laptop, then use **Mobile — same account → Create phone link → Copy phone link** once for the phone. No phone API keys or mandatory QR scan. The private address is read automatically after ENABLE-MOBILE setup. The saved app then shows the laptop's same account, positions and scan results. Tailscale must remain connected on both devices.

Phone trust now survives ordinary connector/Windows restarts, with a 30-day renewable cookie and a restricted server file containing hashed session IDs, CSRF secrets and an account fingerprint. Reconnect the same Binance account on the laptop after restart; phone pairing need not repeat. Revocation, explicit disconnect, account changes and expiry still remove phone access. API credentials are not persisted by this change. See MOBILE-SETUP.md for the one-time flow and recovery.

V1.66 also fixes rejected candles being treated as traded, tries other qualified timeframes after a sizing failure, caches confirmed fee reads briefly, and labels the source of skipped entries. Trading thresholds remain V1.65's.

## V1.65 Auto continuity and fee checks

Update `demo-execution` and `render-backend` together, then restart `START-LAPTOP.cmd`. Refreshing the website alone does not update a running laptop engine. Preserve journals and saved credentials. Reconnect and Start once after installation; later recoverable errors retain that Start intent.

New entries wait during reconciliation without disabling Auto. Position checks run before account income summaries and continue during entry-only backoff; Binance-wide rate limits and outages can still delay them. A failed symbol does not prevent checking other positions unless the error is account-wide. Manual Stop stops new entries while connected position management continues. Unknown writes, unverified exits and unmanaged orders still block entry; they are never blindly retried or adopted. The $100 net session stop remains.

High commission is assessed across all coins: commission must be at most 25% of the gross reference target move and leave at least $5 net at that target, with current round-trip commission no more than half the normal $6 loss budget. Retain $300 margin and reduce leverage as needed. This is an estimate, not a profit guarantee; existing profit/loss exit rules are unchanged. The cancelled V1.64 blanket $1 commission cap is not included.

## V1.63 strategy and connector update

Update this folder and `demo-execution` together, then restart the Windows connector with `START-LAPTOP.cmd`. Keep the existing laptop journal data. Refreshing only the website cannot replace the loaded backend or background engine.

V1.63 checks 1–10m, 15m, 20m, 30m and 60m Bollinger / Williams %R signals from Futures gainers and losers, after-fee profit floors $5 / $8 / $11 / +$3, a normal $6 loss exit, and a $12 maximum loss target requiring fresh recovery evidence beyond $6 with $300 margin at the highest Binance-accepted leverage that fits that size, available margin and the $6 after-fee stop. The one-hour experiment is replaced. Snapshots report the actual engine version, `bandRules` and policy so the web/mobile controls can display the correct rules. Updating/restarting does not resume stopped Auto by itself; reconnect and Start once.

V1.62 retains exchange conditional-order IDs, repairs stale invalid-ID records after fresh verification, and preserves Auto through temporary Start/Sync read failures. Manual Stop cancels retries. Both source folders must be updated; no account reset or journal deletion is required.

The relay permits signed Demo-only `GET /fapi/v1/userTrades` for paid commissions and realized partial-close results and `GET /fapi/v1/leverageBracket` for exchange leverage limits. Older relays reject these reads. Fee-history preflight blocks entries with an actionable update warning; missing costs are never invented. An unavailable bracket read can fall back to confirmed leverage-setting responses. Temporary read errors retry automatically while preserving explicit Stop. Unknown writes and authentication errors still require resolution.

No live host or new Binance write endpoint is enabled. Replace both folders, preserve journals, and restart; a GitHub Pages refresh alone is insufficient.

V1.63 installs a $12 Binance backup stop. The $6 recovery decision and profit floors need this engine running. It closes at the next fresh observation at or below an armed floor, without closing just because profit first rises through a level. Restart preserves the new peak/floor. Existing positions migrate without adding margin or changing leverage; prior fees and partial results still count. Slippage, gaps and fees can exceed exit targets.


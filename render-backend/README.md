# Binance Demo backend — Render Free

Deploy this directory as a Node web service. Root directory: `render-backend`. Build command: `npm test`. Start command: `npm start`. No dependencies or Binance secrets are required.

Set `RELAY_TOKEN` using Render's Generate button (at least 32 random characters). Do not commit it or paste it in chat. The health endpoint reports whether it is configured without exposing it.

After deployment, visit `/check-binance`. `ok: true` confirms only the public time endpoint works from the server. Account permissions, open orders and trade protection must still be tested before starting automation. Share only the public Render service URL, not tokens.

The existing dashboard is not yet wired to this service: its assigned URL is needed first. This backend does not autonomously trade. It relays already signed requests only to the fixed Binance Demo host. It never accepts the Binance secret, arbitrary destinations or redirects. Private requests require the backend token; origin checking alone is not authentication. Requests and responses are not logged by this code. Signed query strings are sent to the relay in a POST body, not the browser URL. Rotate the backend token if disclosed.

The free service can sleep/restart and has no durable storage. No unattended 24-hour trading guarantee. Exchange order reconciliation must precede any retry after an ambiguous write failure. Do not use live account credentials.

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

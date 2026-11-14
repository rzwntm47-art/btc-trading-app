## V1.83.1 — $150 minimum total position value; V1.83 strategy retained

This is a sizing-only patch. Each new order must have a **planned total position value of at least $150 after leverage**, calculated as quantity × final executable entry price. It is not a $150 margin requirement: $3 margin at 50× or $1.50 margin at 100× both represent $150 before trading costs. Orders already larger than $150 remain eligible; the exchange minimum takes precedence if higher.

Apply the floor during initial sizing, leverage/capacity fallback and the final quote check. The existing fee, spread, volatility, available-funds and exchange limits remain; if no valid size reaches the floor, explain the sizing conflict and continue scanning without sending a smaller order or widening the stops. Actual market fills may differ from the planned value. Do not top up existing positions or alter their leverage.

The V1.83 signal rules, removed discretionary filters, $1 net-loss trigger, $1.50 backup, uncapped net-profit trail and $20 booked session goal are unchanged. Tests compare the complete policy against V1.83 with only the new minimum added, and verify both directions, leverage/margin arithmetic, fees, lot rounding, capacity fallback, final quote/volatility changes and existing-position handling.

Update both `demo-execution` and `render-backend`, restart `START-LAPTOP.cmd`, then **Sync Binance → Start / Resume Demo**. Confirm connected engine **V1.83.1** and **minimum planned position value $150 after leverage**. The patch version distinguishes the updated connector; the trading strategy remains V1.83. No reset or history deletion is needed.

## V1.83 — remove discretionary entry gates

The current entry policy uses recent 1m price direction and a fresh directional quote. Candle body/close-strength thresholds, minimum volume, moving-average alignment and the separate 0.75-ATR chase distance no longer reject current entries. Small pullbacks, spread changes and a fresh quote without a second advancing timestamp are allowed when executable-price sizing and protection still fit. The live price must remain on the intended side of the current candle open, or the latest completed candle open when forming data is absent.

The hypothetical reference target is now advisory: there is no $1 reference-net minimum or 25% commission-to-reference cap. A position can qualify even if that reference estimate is smaller or the reference price has already been passed. This is not a profit prediction. Actual opening/closing fees, spread and adverse mark difference still determine size; their budget remains half the $1 normal loss trigger, and one recent 1m ATR plus costs must fit the $1.50 backup budget. Binance minimums and valid available funds still apply.

The $1 net-loss trigger, fee-adjusted $1.50 exchange backup, uncapped profit trail from $1 net, flexible margin and $20 booked session goal remain. Protection must be confirmed for filled orders. Manual Stop, ownership checks and journaled reconciliation of uncertain orders remain active. The same filled candle is not replayed. These rules do not guarantee a fill, profit or maximum realized loss.

Regression tests reproduce previously filtered BUY and SELL entries with small candle bodies, low volume, opposing averages, minor quote pullbacks, widened spreads, passed reference prices and reference net below $1. They also verify valid stop protection, stale/reversing quote rejection, invalid-data/minimum-size handling, manual Stop and uncertain-order deduplication. Tests simulate exchange responses and do not demonstrate profitability.

Update both `demo-execution` and `render-backend`, restart `START-LAPTOP.cmd`, reconnect, then **Sync Binance → Start / Resume Demo**. Confirm the page and connected engine show **V1.83**. Publishing the website cannot update a running laptop connector. No reset or history deletion is needed.

## V1.82 — immediate 1m entries and uncapped net-profit trailing

New entries first check recent 1m momentum and fresh executable quotes. A qualifying fast setup returns immediately without fetching 5m confirmation; it can submit while the current 1m candle is forming. The 24h gainers/losers list supplies candidates, but actual 1m direction determines BUY or SELL. If the fast path does not qualify, the existing 14 Bollinger frames and 1m / 5m continuation remain available. Per-symbol cooldown is 30 seconds after close, with a fresh untraded candle still required. Uncertain orders, existing positions, stale/reversing quotes and exchange constraints remain protected.

The normal loss exit is **$1 estimated total net loss**, including paid commission, realized partial results, funding and expected closing fees. An exchange **$1.50 backup target** is installed immediately from the confirmed fill and adjusted from actual accounting. Position checks target one second for this policy; network delays, gaps and market fills can exceed either trigger. There is no recovery extension.

Profit is no longer closed automatically at $1. At $1 net, arm a trailing floor equal to the highest observed net minus the larger of **$0.50 or 10% of that peak**. Examples: $2 → $1.50, $12 → $10.80, $20 → $18, $30 → $27. Floors never fall; fresh fees and executable quotes are checked again before closing. A gap below the floor still exits instead of waiting for recovery. There is no profit ceiling.

The $20 session goal uses **booked net**, with the existing opening session adjustment. Unrealized peaks do not trigger a forced close. Once booked net reaches $20, new entries pause and pending entry remainders are cancelled; open bot positions keep trailing and loss management. This decision stays latched until a new session is started while flat. Final net can change while open positions finish.

Margin remains flexible up to $300 per order, within the $5,000 total margin budget and exchange/100× leverage ceiling. Fees and spread may use at most half the normal $1 loss budget; one recent 1m ATR plus costs must fit $1.50. Reference net must be at least $1 and commission within 25% of the reference move. These cost checks do not predict profit. No mandatory $15/$25 margin, top-ups or changes to existing leverage.

Update both `demo-execution` and `render-backend`, restart `START-LAPTOP.cmd`, reconnect, then **Sync Binance → Start / Resume Demo**. Verify the page and connected engine both show **V1.82**. Updating the website alone cannot replace a running laptop engine. History and session results remain saved; no reset is required. Regression tests use simulated exchange responses, not a profitability backtest.

## V1.81 — flexible margin without mandatory tiers

The $15 at 100× and $25 at 50× examples are no longer mandatory entry sizes. New entries use flexible margin up to $300, sized to available funds, fees, spread and recent movement. All integer leverage values up to the lower of the Binance ceiling and 100× are available. A valid smaller order may proceed instead of being rejected for missing a margin tier. Final quotes, volatility and exchange capacity can reduce the quantity again before submission; Binance minimums and all other entry checks still apply.

The existing 14 Bollinger / Williams %R frames (1–10m, 15m, 20m, 30m, 60m) and independent 1m / 5m trend continuation remain active. The $0.50 estimated net-loss exit, $1 exchange backup target, $1 estimated net-profit exit and $20 session target remain. Existing positions are not topped up or releveraged. Stops are triggers, not guaranteed execution prices. Profit or completion time is not guaranteed.

Regression tests reproduce eligible BUY and SELL orders blocked by the historical margin floor, then verify submission under the current policy. They cover limited funds, exchange capacity, intermediate leverage, the 100× ceiling, final volatility resizing, loss/profit exits, exchange minimums, manual Stop and uncertain-order deduplication. Exchange responses are simulated; these are correctness tests, not a profitability backtest.

Install both `demo-execution` and `render-backend`, run `START-LAPTOP.cmd`, reconnect, then **Sync Binance → Start / Resume Demo**. Verify both the page and laptop engine show **V1.81**. Updating the website alone does not update a running connector. No reset or history deletion is needed.

## V1.80 — requested margin with leverage fallback

New entries try **$15 margin at 100×**, then **$25 at 50×**, within the exchange leverage ceiling. If those sizes do not fit costs or volatility, try **$25 margin at lower integer leverage below 50×**. Do not select intermediate 51–99× leverage or exceed 100×. Retain the requested margin when checking exchange capacity and available funds; skip if no valid order fits. Round to the exchange quantity step and revalidate final quotes; actual fills may change the displayed margin.

The user delegated the fee/stop conflict decision. Preserve the **$0.50 total net-loss target including fees**, the **$1 exchange backup**, $1 net-profit exits and the $20 session target. Estimated immediate costs remain limited to $0.25; one 1m ATR plus costs must fit $1. At a hypothetical 0.05% taker fee each way, the requested high tiers would cost roughly $1.25 or $1.50 for opening plus closing, so the bot must select lower leverage or skip. It does not silently expand the stop or send a smaller-margin order. Increasing allocated margin can leave exposure similar when leverage falls and cannot guarantee $20 within minutes.

Both entry signal paths and quote confirmation remain. Existing positions are managed under their current exits and are not topped up or releveraged. Position cards show actual initial margin, trade value, recorded entry leverage and requested margin. Reports retain the requested margin separately from the estimated filled margin. Stop/Resume, unknown-order journaling, protection recovery and reset behavior remain.

Install both `demo-execution` and `render-backend`, run `START-LAPTOP.cmd`, reconnect, then **Sync Binance → Start / Resume Demo**. Verify both page and laptop engine show **V1.80**. Updating the website alone does not update a running connector. No history reset is needed. Tests use simulated exchange responses, not a profitability backtest.

Fee reference: [Binance Futures fee calculations](https://www.binance.com/en-AE/support/faq/detail/360033544231). Actual signed commission-rate responses remain authoritative for entry sizing.

## V1.79 — $0.50 net-loss exit and $1 exchange backup

Keep both Bollinger/Williams %R and trend-continuation entry paths, fresh stable-quote confirmation, the $1 net-profit close and the $20 account-wide session target. Replace the $6 loss decision and recovery extension toward $12 with a normal close at **-$0.50 total trade net** and a **-$1 fee-adjusted exchange backup target**. Re-read position, matched execution fees and the executable quote before a normal close. If price recovers above the threshold, keep monitoring; do not research or grant recovery extensions below it.

The old fixed $300 margin could spend much of the new stop on fees alone. New trades therefore use **up to $300 margin**, with quantity reduced for current fees, spread, mark-price difference and one-minute volatility. Estimated immediate costs may use at most $0.25; one observed 1m ATR plus costs must fit $1. Round down, respect exchange minimums and caps, and keep the existing commission-to-reference-move limit and $1 minimum reference net. Recalculate the size on the final quote; skip when a minimum order or its costs do not fit. These are sizing checks, not forecasts or guaranteed loss caps.

Existing positions migrate to `rulesVersion: 14`, `lossExit: 'tight-net-stop'`, without changing quantity, leverage or ownership. Close positions already past -$0.50 when accounting and price are confirmed. Install/confirm the new $1 backup before cancelling an older wider stop; a definite protection failure closes the remaining position. Missing accounting retains or installs the exchange backup, while ambiguous writes remain journaled and cannot be duplicated. Manual Stop still manages owned positions; session reset and duplicate-entry protection remain.

Install both `demo-execution` and `render-backend`, run `START-LAPTOP.cmd`, reconnect, then **Sync Binance → Start / Resume Demo**. Verify the page and laptop engine show **V1.79**, with **$0.50 / $1.00 targets** on position cards. Publishing does not update an already-running laptop connector. No history reset is required. The engine must run for the $0.50 net exit; slippage, gaps, fees and delays may exceed both targets. Tests use simulated exchange responses and do not demonstrate profitability.

API reference: [Binance conditional-order documentation](https://binance.github.io/binance-connector-js/classes/_binance_derivatives-trading-usds-futures.DerivativesTradingUsdsFuturesRestAPI.RestAPI.html). The backup uses STOP_MARKET, closePosition and MARK_PRICE; it does not combine closePosition with quantity or reduceOnly. Immediate closes use reduceOnly market orders.

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


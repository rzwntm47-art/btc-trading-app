# Binance Demo execution module — V1.57

This module sends USDⓈ-M orders exclusively to `https://demo-fapi.binance.com`. It has no live endpoint, withdrawal or transfer capability.

Build with `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Run `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs` for engine, controls, mobile and backend checks.

## Normal exit policy

- The profit basis is the entire tracked trade: realized partial-close P&L minus commissions already paid, plus funding, plus remaining unrealized P&L at the executable closing price, minus estimated closing taker commission. Actual paid amounts come from matched Binance `userTrades`, paginated by trade ID, and funding income. Quantity must reconcile with the live position. This fixes the previous remaining-quantity estimate that omitted realized trim losses. Unknown costs are not silently zeroed.
- Profit floors arm after net exceeds $2, $4, $6, $8, $10, then $15, $20, $25, etc. Hold rising profit and request a reduce-only close on pullback. Recheck actual fees and executable prices before dispatch. Do not deliberately submit a profit exit below $2 estimated total trade net. If a gap falls below $2, wait for recovery or the loss rule; neither $2 nor a floor is a guaranteed fill.
- At -$3 total trade net, reduce 25% once, rounded down to Binance's quantity step. At -$5, close that trade's remaining quantity and keep managing/scanning other symbols. The -$5 rule takes priority over the -$3 trim and profit trailing. Partial-close losses and fees remain in the total, so the allowance does not reset after trimming. No loss timer.
- Install an exchange STOP_MARKET backup targeting -$5 estimated total trade net. Confirm its replacement before cancelling older bot SL/TP/floor orders. Update the stop after reductions using the remaining quantity and booked net. For a long whose calculated stop falls below the exchange minimum price, use that minimum price (a closer stop). Stops trigger on mark price and can differ from executable-price checks; slippage/gaps can produce a loss beyond the target.
- Persist reduction IDs before dispatch, reconcile uncertain outcomes, and never blindly repeat a trim. Terminal partial execution counts as the one reduction. Definite rejection/quantity violations are shown without repetitive submissions. Manual/full-session closes confirm cancellation of a pending trim before closing the remainder. Prior completed reductions survive upgrades/restarts.
- At $100 estimated account-wide session net **after expected closing fees**, close all bot positions and stop new entries, including losing positions. Replace overlapping posted income with matched execution totals for active trades to avoid both missing and double-counted costs while income settles. The goal decision stays latched during closure. Final booked result may differ. Unmanaged positions are not adopted or closed.

Current records use rules version 8, `lossLimit: 5`, `takeProfit: null`, and `exitPolicy: 'net-trailing'`. `trailPeak` and `profitFloor` persist across restarts; migration resets obsolete profit peaks but preserves loss-reduction history. `protected`/`exitsReady` require a confirmed loss stop. Profit trailing, partial reductions and session checks require a running engine; accepted exchange stops remain active independently.

Execution history is cached for 30 seconds when quantity/entry/session are unchanged and refreshed before profit/session exits. A missing history, replaced position, unsupported commission currency or unmatched quantity defers accounting-dependent exits and displays a reason while the fee-estimated exchange loss stop remains. No profitability or exact-fill guarantee is made.

## Normal entry behavior

The signal strategy remains movers plus momentum/breakout confirmation. Prioritize the top 10 eligible Futures demo gainers for BUY and top 10 losers for SELL, then rotate through other USDT perpetuals. Coins repeat. Rankings are past price changes, not predictions. Use completed 1–5m, 10m, 15m, 20m, 30m or 60m candles. The strongest agreement tier is not required, but no calibrated win probability is claimed.

Momentum requires aligned 5/20 means, confirming 5m direction, a directional candle and close, body at least 40% of range, directional close strength at least 65%, volume at least 0.8 times its recent average, and no extension beyond two ATRs. All qualifying same-direction timeframes remain candidates; an earlier failing candidate cannot hide a later valid one.

Target $300 margin per new entry, rounded up to the quantity step. Adaptive leverage stays within 1–10× and exchange capacity; no fixed position-count cap, one position per symbol, $5,000 total margin budget, Cross. Different symbols can enter consecutively with serialized writes. The same symbol has a 10-minute cooldown after closing.

The existing $20 one-ATR-and-fees allowance remains an entry sizing check only. It can reduce leverage or skip excessive exposure; it is not a stop-loss or maximum loss. New trades also need a workable $5 stop after fees and exchange tick rounding. A spread or fee burden already consuming that allowance rejects the entry. Fresh spread/mark movement is included in the entry exposure estimate. The selected timeframe must still clear the existing commission screen. The obsolete fixed $20 take-profit fee check is removed; the separate $20 entry sizing allowance remains.

Entries tolerate up to 0.75 ATR drift from the selected close and up to a 0.10 ATR breakout retest, while momentum boundaries and fresh direction remain required. Stale, reversed or unworkable quotes skip the candidate. Temporary candidate-only GET failures, HTTP 400/404 reads and definite order/price-filter rejections keep scanning. Known leverage restrictions are handled before order dispatch. Unknown writes and access/signature errors still stop new entries for reconciliation.

## One-hour Demo experiment

Start explicitly with **Start 1-hour experiment**, from a connected browser or authenticated laptop/mobile controller. The one-hour UTC deadline is persisted; Stop/Resume, reload and duplicate clicks do not extend it. Stop cancels queued activation. Expiry is checked again immediately before dispatch. At expiry or **Return to normal entries**, normal entries resume only if Auto remains enabled. New experiment records retain their experiment exits until closed; normal positions are not converted. No timer starts on deployment.

- V1.57 replaces the every-directional-candle experiment with confirmed momentum or breakout setups on 1m, 3m, 5m, 15m, 30m, 1h, 2h or 4h. Require trend agreement, candle body/close, volume, and price validity using the same qualification functions as normal mode. Mover-priority candidates must match the mover direction. Recheck current 1m direction and candidate-specific movement relative to round-trip fees before configuring leverage; later valid timeframes are retained if the first candidate fails. No prediction or calibrated win probability is claimed.
- Read Binance Demo leverage brackets and request the highest available initial leverage, capped at 150×. An unavailable bracket route (HTTP 400/404) falls back to explicit leverage-setting responses and temporarily suppresses the failed bracket read. Only a confirmed leverage and notional-cap response can authorize the final order; no test trade is placed. Authentication, signature, rate-limit and uncertain-write errors do not use this fallback. Account-specific leverage rejection falls back to the highest accepted lower integer. Use **up to $300 margin**, rounding down and reserving estimated opening/closing fees. Reduce size to exchange notional/quantity capacity. Retain the $5,000 total margin budget and one position per symbol. A candle gets one entry; a newly closed candle may re-enter without the normal ten-minute cooldown.
- Per the selected clarification, **any negative estimated total trade net closes immediately when detected**, including fees. There is **no 30-second timer**. This can close a trade immediately after entry with a fee loss exceeding $1, even at an unchanged price. It is not a guaranteed $1 cap. A planned $1 exchange STOP_MARKET backup is installed if the position remains open; an already crossed threshold closes instead.
- Positive positions use net pullback floors **$2, $4, $8, $10, $15, $20, then +$5**. Strictly exceed a floor to arm it. Recheck actual commissions and current executable closing price before dispatch. A positive pullback below $2 waits for recovery; any negative net exits. Rising profit stays open. No 25% reduction applies to experiment positions.
- The normal $100 estimated account-wide net session target remains active and closes all bot positions, including losers, after expected closing fees are deducted.
- Position checks target one second while an experiment position is open, but serialized API calls, other positions, network delays, rate limits, accounting lag and fill slippage can delay closure. The engine must stay running and connected. No exchange-linked test or profitability backtest has been performed.

Experiment records have `rulesVersion: 9`, `exitPolicy: 'trial-net-trailing'`, a `oneHourTrial` policy snapshot and `lossLimit: 1` for the backup stop. The journal-level `oneHourTrial` controls entry expiry only; normal rules remain version 8. Reports expose the trial deadline and recorded policy.

## Recovery and connector compatibility

The V1.56 screenshot error was a failed signed `GET /fapi/v1/leverageBracket`, not a rejected trade order. Previously HTTP 400 escaped the entry-read handler and stopped Auto. The new fallback validates leverage through Binance settings, while the general candidate-read handler skips safe pre-entry failures without turning Auto off.

A successful `GET /fapi/v1/userTrades` preflight is now required before new entries (cached five minutes). Old relays rejecting this route cannot support after-fee exits: show an explicit update/restart message, submit no order, retain Auto intent and recheck after 30 seconds. Do not open a position that will immediately fail its accounting solely because the relay is obsolete. Actual matched execution history is still required after entry.

Transient GET/network failures and read-rate cooldowns use automatic backoff while Auto remains enabled. Retry after 5 seconds, exponentially up to 60 seconds, and honor any longer Binance `blockUntil`. On recovery, refresh account/positions and reconcile before scanning again. No entry writes run during the wait. Manual Stop clears retry intent; the retry code never changes `auto` from false to true. Uncertain entries/closes, pending reductions, authentication/signature failures, unmanaged positions/orders and the $100 session stop retain their existing blocking behavior. No automatic blind order retry is introduced.

Local relay unsupported-route errors are labeled as local-backend failures instead of being called Binance trade rejections. Read-only request errors carry method/path metadata; a failed GET is not an uncertain order submission.

## Accounting, controls and deployment

Net session result includes USDT realized trading P&L, commission, funding and the change in unrealized P&L from the opening snapshot. It differs from Binance unrealized P&L alone. A new $100 session requires an explicit action while flat.

Copy scan diagnostics works with zero trades, busy work or disconnected snapshots, without account requests or credentials/balances. Three public scan workers, caching, serialized order writes, responsive Stop controls and exit checks during scanning remain.

Browser mode needs the page running for profit trailing, loss reductions and the account-wide $100 close. Accepted exchange loss stops can remain when the page closes. Pair Mobile/background mode uses laptop files and needs the laptop awake and connector running. Publishing a website does not replace that loaded engine: update its files and restart it. A browser using only the local relay loads the engine from the website. The UI reports the actual engine version and exit policy so an old engine is not presented as running the new rules.

Start requires One-way and Single-Asset Mode. Account modes are not changed automatically. Credentials remain in memory or the explicitly saved encrypted vault. Use one execution owner per demo account.

V1.57 also updates `render-backend/server.cjs` to allow the signed Demo-only `GET /fapi/v1/userTrades` fee read and `GET /fapi/v1/leverageBracket` experiment leverage read. Replace the backend files and restart the Windows connector, even when using only the local relay. An old relay rejects this new read and cannot support the new fee calculation. Pair Mobile/background engines additionally need the updated engine and generated page. A website refresh alone does not update running laptop code.

Validation: automated engine, control, relay and mobile tests cover net trailing levels, $3/$5 priorities, actual paid fees, partial realized losses, funding, pagination, unknown/partial/rejected reductions, stop replacement, exact quantity reconciliation, depth/freshness checks, session exit fee reserves, and version/UI reporting. Build checks syntax and DOM bindings. No account-connected trading or profitability backtest was performed.

Official API reference: [USDⓈ-M orders, reduce-only and order queries](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

Experiment validation also covers expiry at dispatch, restart persistence, stop/start races, remote command deduplication, leverage fallback, capacity/fee sizing, fee-only immediate losses, strict trailing floors, isolation of existing positions, stale candles and same-candle deduplication.

V1.57 regression checks include HTTP 400/404 leverage fallback with a 20× exchange cap, exact confirmed settings before a single entry, rejected-order scanning, fee-history preflight, weak/reversed setups, cooldown deadlines, automatic read recovery and manual-Stop precedence.

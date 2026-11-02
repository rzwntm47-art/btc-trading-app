# Binance Demo execution module — V1.63

USDⓈ-M orders go exclusively to `https://demo-fapi.binance.com`. No live endpoint, withdrawals or transfers.

Build: `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Verify with `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs`.

## Strategy

V1.63 preserves multi-timeframe Bollinger / Williams %R entries and replaces Profit pullback exits with the user-confirmed after-fee $5 / $8 / $11 / +$3 pullback ladder. The normal loss exit is $6; fresh recovery evidence can permit holding toward a $12 backup target. The one-hour experiment remains disabled. Defaults are Bollinger 20-close SMA ± 2 population standard deviations and Williams %R 14, because the provided transcript omitted settings.

- Refresh eligible demo Futures 24h rankings once per minute. Check up to 20 gainers for LONG and 20 losers for SHORT, rotating eight slots plus recent candidates with three public workers. Recheck continuously; do not enter unrelated full-market coins. Rank is historical movement, not a forecast.
- LONG: last or previous completed candle on that timeframe touches the lower band, one of their WR values is ≤ -80, then the latest candle closes bullish, above the previous close and lower band, with rising WR, still below the middle. SHORT mirrors this at the upper band with WR ≥ -20. Validate candle continuity, OHLC, freshness and positive ATR. Williams %R is a price-range oscillator, not buyer/seller percentages.
- Require room to the middle exceeding twice estimated round-trip fees per unit. Fresh executable quotes, mark, spread, current 1m reversal checks, balance, existing orders and exchange filters still apply. A 1m Bollinger candidate revalidates the same reversal, never the incompatible trend-above-middle momentum rule. Price drift stays within 0.75 selected ATR. A failed setup is shown with a reason; it is not a rejected exchange order.

Check 1m, 2m, 3m, 4m, 5m, 6m, 7m, 8m, 9m, 10m, 15m, 20m, 30m and 60m independently. Two shared reads (250 native 1m bars and 300 native 5m bars) supply them. Synthetic frames use complete UTC-aligned groups, never forming candles. Keep all qualified same-direction candidates; an earlier failure does not discard a later timeframe. Ordinary data errors on one dataset do not discard valid candidates from the other. Rate/authentication errors still block entry. Store the selected interval for exits; older Bollinger positions retain 5m targets.

## Size and leverage

Each new trade targets $300 margin, rounded up to the exchange quantity step. Retain a $5,000 total margin budget, USDT collateral, Cross, one position per symbol and ten-minute same-symbol cooldown. Do not top up or change leverage on existing positions.

Read the symbol leverage ceiling and confirm the highest accepted integer setting that permits the full $300-margin position under Binance notional and quantity limits (supported ceiling 150×). If the highest setting is rejected or lacks capacity, search lower settings and reconfirm the final choice. An unavailable bracket read can use confirmed setting responses. First evaluate every integer leverage locally against executable spread, actual commission rate, mark price, tick-rounded $6 stop and margin plus fees. Select the highest feasible setting, then confirm exchange capacity. Reduce leverage when needed; do not reduce the $300 margin target. Round quantity at the final quote and verify margin plus fees, lot steps, notional limits and the $6 stop before sending one order.

The prior 1.5-ATR risk sizing, $1 fee sizing cap and $20 volatility sizing veto no longer apply to these entries. The existing Bollinger signal and price checks remain. Fees and spread must still allow an untriggered $6 after-fee loss stop. If no supported leverage leaves room, show the conflict and skip while Auto keeps scanning. The full amount plus fees must be available; no smaller order is sent. Actual market fills can change margin and stop results.

## Exits and migration

Current records use `rulesVersion: 12`, `lossLimit: 6`, `maxLossLimit: 12`, `exitPolicy: 'stepped-net-trailing'`. Entry bands and timeframe remain evidence; they no longer determine profit exits.

- Total trade net includes actual paid entry/partial-close commissions, realized partial-close results, funding, executable remaining P&L and estimated closing fees. Actual matched Binance fills are required. Do not use gross green unrealized P&L alone to submit a profit exit.
- Profit floors: no floor at net ≤ $5. Arm each level only after net exceeds it: $5, $8, $11, $14, $17, $20, continuing by $3. A peak of exactly $20 gives a $17 floor; $20.01 gives $20. Hold rising profits; close at the next fresh observation at or below the floor. Persist the peak and floor; never lower either on ordinary checks or restart. Requote with paid/estimated costs before submission. A gap through the floor still closes at available market prices, even below the intended profit. No unconditional take-profit order or Bollinger-band exit.
- At total net ≤ -$6, hold only if a completed 1m candle since entry and fresh 1m/5m trends support recovery. Both trends require close above SMA5 above SMA20 (LONG) or below them (SHORT), with directional close-to-close movement. The 1m candle requires body ≥40% of its range, directional close in the outer 35%, and volume ≥1.2 times the prior 20-bar mean. Current executable price must remain within 0.25 ATR of that candle in the adverse direction. Missing, stale, pre-entry or conflicting evidence cannot authorize extension. Recheck every loss evaluation and requote after the candle reads; close if support disappears. Recovery evidence is a rule, not a probability or guarantee.
- At net ≤ -$12, close without waiting for candle analysis. Install and confirm an independent Binance STOP_MARKET backup targeting -$12 before cancelling older exits, adjusted for booked results, paid fees and remaining quantity. The normal -$6 exit and trailing profits need the engine running. During an outage the exchange backup targets -$12. Mark-price and executable-price thresholds differ; gaps, slippage and fees can exceed all targets. No loss timer, add-on, leverage change or new partial-loss reduction.
- Existing owned positions migrate on reconciliation. Preserve quantity, leverage, fees, earlier reductions and history. Archive the previous exit policy/peak, initialize the new peak from current net (never infer a historical peak), and persist it thereafter. Confirm the $12 backup before cancelling older stops. Pending writes reconcile first; cancelled legacy exit intents recheck current conditions. Closed records remain unchanged.
- The $100 estimated account-wide after-cost session goal remains: close bot positions, including losers, then stop new entries. Unmanaged positions are not closed. The goal latches through unresolved orders. Manual close remains available.

Legacy exit/entry branches remain for historical compatibility regression tests, but the default browser and desktop engine uses `bandRules: true`. Both engine policy and version are included in remote snapshots. Profit floors, $6 recovery decisions and session exits need the engine online; accepted exchange loss stops persist independently. No live-account trading or profitability backtest has been performed.

## V1.62 continuous Auto and conditional-order recovery

The reported `GET /fapi/v1/algoOrder` error `-4015` indicates an invalid client-order identifier. Earlier code discarded the exchange `algoId`, built exit IDs by appending to the entry ID, and repeatedly queried/cancelled failed references during flat-position cleanup. A screenshot cannot identify the exact saved ID or prove it was overlength.

New protective IDs are independent 28-character values journaled before submission. Retain Binance's `algoId` as a precision-safe string and prefer it for lookup/cancellation. Validate returned order identity. For old `-4015` references, read fresh symbol-scoped open algo orders and match the full saved ID exactly; never truncate IDs or guess ownership from symbol/price. A matched open order supplies its numeric ID. A definite identifier rejection permits one cancellation retry using that recovered ID; ambiguous writes never get blind retries.

Retire an absent stale stop only after fresh Binance position data confirms an already-observed, settled trade is flat, or a replacement close-all STOP_MARKET is freshly verified. Preserve unrelated/manual orders, history, balances and credentials. Unknown or live exposure is not labeled flat. Failed inventory reads defer recovery. Missing/unconfirmed live protection remains a blocking condition.

An explicit Start survives temporary GET failures with backoff and reruns the complete startup checks before any entry. Manual Stop cancels the pending start/retry. Temporary Sync read failures also preserve running Auto in browser and laptop modes. Authentication failures, uncertain writes, missing protection and the $100 session goal retain their blocking behavior. Refreshing or restarting does not automatically enable a previously stopped bot.

References: [Binance conditional-order API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade). Client IDs are limited to 36 supported characters; query/cancel can use the exchange `algoId`.

## Recovery and connector compatibility

The V1.56 screenshot error was a failed signed `GET /fapi/v1/leverageBracket`, not a rejected trade order. Previously HTTP 400 escaped the entry-read handler and stopped Auto. The new fallback validates leverage through Binance settings, while the general candidate-read handler skips safe pre-entry failures without turning Auto off.

A successful `GET /fapi/v1/userTrades` preflight is now required before new entries (cached five minutes). Old relays rejecting this route cannot support after-fee exits: show an explicit update/restart message, submit no order, retain Auto intent and recheck after 30 seconds. Do not open a position that will immediately fail its accounting solely because the relay is obsolete. Actual matched execution history is still required after entry.

Transient GET/network failures and read-rate cooldowns use automatic backoff while Auto remains enabled. Retry after 5 seconds, exponentially up to 60 seconds, and honor any longer Binance `blockUntil`. On recovery, refresh account/positions and reconcile before scanning again. No entry writes run during the wait. Manual Stop clears retry intent; the retry code never changes `auto` from false to true. Uncertain entries/closes, pending reductions, authentication/signature failures, unmanaged positions/orders and the $100 session stop retain their existing blocking behavior. No automatic blind order retry is introduced.

Local relay unsupported-route errors are labeled as local-backend failures instead of being called Binance trade rejections. Read-only request errors carry method/path metadata; a failed GET is not an uncertain order submission.

## Accounting, controls and deployment

Net session result includes USDT realized trading P&L, commission, funding and the change in unrealized P&L from the opening snapshot. It differs from Binance unrealized P&L alone. A new $100 session requires an explicit action while flat.

Copy scan diagnostics works with zero trades, busy work or disconnected snapshots, without account requests or credentials/balances. Three public scan workers, caching, serialized order writes, responsive Stop controls and exit checks during scanning remain.

Browser mode needs the page running for Profit pullback exits and the account-wide $100 close. Accepted exchange loss stops can remain when the page closes. Pair Mobile/background mode uses laptop files and needs the laptop awake and connector running. Publishing a website does not replace that loaded engine: update its files and restart it. A browser using only the local relay loads the engine from the website. The UI reports the actual engine version and exit policy so an old engine is not presented as running the new rules.

Start requires One-way and Single-Asset Mode. Account modes are not changed automatically. Credentials remain in memory or the explicitly saved encrypted vault. Use one execution owner per demo account.

The current `render-backend/server.cjs` allows the signed Demo-only `GET /fapi/v1/userTrades` fee read and `GET /fapi/v1/leverageBracket` leverage read. Replace the backend files and restart the Windows connector, even when using only the local relay. An old relay rejects this new read and cannot support the new fee calculation. Pair Mobile/background engines additionally need the updated engine and generated page. A website refresh alone does not update running laptop code.

## Validation and references

Deterministic tests cover mirrored LONG/SHORT qualification, fixed-margin maximum-leverage sizing, stepped profit exits, fresh recovery checks, $6/$12 loss exits, migration, paid fees, manual controls, leverage/capacity errors, read recovery, unknown writes, mobile snapshots and old-connector detection. These verify execution behavior, not profitability.

Indicator references: [John Bollinger's rules](https://www.bollingerbands.com/bollinger-band-rules), [Bollinger Bands calculation](https://www.bollingerbands.com/bollinger-bands), [Williams %R](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/williams-r).

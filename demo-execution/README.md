# Binance Demo execution module — V1.61

USDⓈ-M orders go exclusively to `https://demo-fapi.binance.com`. No live endpoint, withdrawals or transfers.

Build: `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Verify with `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs`.

## Strategy

The user selected Bollinger profit targets. V1.61 replaces the one-hour experiment and earlier dollar trailing/partial-loss policies with a permanent multi-timeframe Bollinger / Williams %R strategy. Defaults are Bollinger 20-close SMA ± 2 population standard deviations and Williams %R 14, because the provided transcript omitted settings.

- Refresh eligible demo Futures 24h rankings once per minute. Check up to 20 gainers for LONG and 20 losers for SHORT, rotating eight slots plus recent candidates with three public workers. Recheck continuously; do not enter unrelated full-market coins. Rank is historical movement, not a forecast.
- LONG: last or previous completed candle on that timeframe touches the lower band, one of their WR values is ≤ -80, then the latest candle closes bullish, above the previous close and lower band, with rising WR, still below the middle. SHORT mirrors this at the upper band with WR ≥ -20. Validate candle continuity, OHLC, freshness and positive ATR. Williams %R is a price-range oscillator, not buyer/seller percentages.
- Require room to the middle exceeding twice estimated round-trip fees per unit. Fresh executable quotes, mark, spread, current 1m reversal checks, balance, existing orders and exchange filters still apply. A 1m Bollinger candidate revalidates the same reversal, never the incompatible trend-above-middle momentum rule. Price drift stays within 0.75 selected ATR. A failed setup is shown with a reason; it is not a rejected exchange order.

Check 1m, 2m, 3m, 4m, 5m, 6m, 7m, 8m, 9m, 10m, 15m, 20m, 30m and 60m independently. Two shared reads (250 native 1m bars and 300 native 5m bars) supply them. Synthetic frames use complete UTC-aligned groups, never forming candles. Keep all qualified same-direction candidates; an earlier failure does not discard a later timeframe. Ordinary data errors on one dataset do not discard valid candidates from the other. Rate/authentication errors still block entry. Store the selected interval for exits; older Bollinger positions retain 5m targets.

## Size and leverage

Each new trade targets $300 margin, rounded up to the exchange quantity step. Retain a $5,000 total margin budget, USDT collateral, Cross, one position per symbol and ten-minute same-symbol cooldown. Do not top up or change leverage on existing positions.

Read the symbol leverage ceiling and confirm the highest accepted integer setting that permits the full $300-margin position under Binance notional and quantity limits (supported ceiling 150×). If the highest setting is rejected or lacks capacity, search lower settings and reconfirm the final choice. An unavailable bracket read can use confirmed setting responses. First evaluate every integer leverage locally against executable spread, actual commission rate, mark price, tick-rounded $6 stop and margin plus fees. Select the highest feasible setting, then confirm exchange capacity. Reduce leverage when needed; do not reduce the $300 margin target. Round quantity at the final quote and verify margin plus fees, lot steps, notional limits and the $6 stop before sending one order.

The prior 1.5-ATR risk sizing, $1 fee sizing cap and $20 volatility sizing veto no longer apply to these entries. The existing Bollinger signal and price checks remain. Fees and spread must still allow an untriggered $6 after-fee loss stop. If no supported leverage leaves room, show the conflict and skip while Auto keeps scanning. The full amount plus fees must be available; no smaller order is sent. Actual market fills can change margin and stop results.

## Exits and migration

Current records use `rulesVersion: 11`, `lossLimit: 6`, `exitPolicy: 'bollinger-targets'`. They store entry band evidence and `bandTargets` with middle, before-outer target stage and entry intervalMs.

- Total trade net includes actual paid entry/partial-close commissions, realized partial-close results, funding, executable remaining P&L and estimated closing fees. Actual matched Binance fills are required. Do not use gross green unrealized P&L alone to submit a profit exit.
- Middle band first. A positive-net trade closes there unless a fresh closed 1m candle since entry confirms momentum beyond the middle and current entry-timeframe WR is on the directional side of -50. Only then extend toward 90% of the distance from middle to opposite outer band. Freeze targets on extension; close before the outer band or on a pullback to the middle while fresh net remains positive. Before extension, refresh bands from completed candle on that timeframes. If momentum cannot be confirmed at a reached positive target, close rather than extend. Recheck actual costs and executable price before dispatch. No dollar profit ladder.
- At ≤ -$6 estimated total trade net, close the remaining position. Install and confirm a Binance STOP_MARKET backup before cancelling older bot exits; adjust it for booked results and remaining quantity. A fee-only negative estimate above -$6 does not close a new trade. No loss timer, no new 25% loss reduction. Mark-price stops and executable-price estimates can trigger at different times; losses can exceed $6 through gaps, slippage, costs or delays.
- Existing owned records migrate on reconciliation, retaining previous reductions/booked results and Bollinger targets. Existing $2 stops are replaced only after the $6 stop is confirmed. Pending writes reconcile before replacement. Old experiment negative-net exit intents cannot reapply the obsolete fee-only close rule. The old journal experiment is ended; its historical metadata is retained. The experiment start command refuses activation with a replacement message.
- The $100 estimated account-wide after-cost session goal remains: close bot positions, including losers, then stop new entries. Unmanaged positions are not closed. The goal latches through unresolved orders. Manual close remains available.

Legacy exit/entry branches remain for historical compatibility regression tests, but the default browser and desktop engine uses `bandRules: true`. Both engine policy and version are included in remote snapshots. Profit targets and session exits need the engine online; accepted exchange loss stops persist independently. No live-account trading or profitability backtest has been performed.

## Recovery and connector compatibility

The V1.56 screenshot error was a failed signed `GET /fapi/v1/leverageBracket`, not a rejected trade order. Previously HTTP 400 escaped the entry-read handler and stopped Auto. The new fallback validates leverage through Binance settings, while the general candidate-read handler skips safe pre-entry failures without turning Auto off.

A successful `GET /fapi/v1/userTrades` preflight is now required before new entries (cached five minutes). Old relays rejecting this route cannot support after-fee exits: show an explicit update/restart message, submit no order, retain Auto intent and recheck after 30 seconds. Do not open a position that will immediately fail its accounting solely because the relay is obsolete. Actual matched execution history is still required after entry.

Transient GET/network failures and read-rate cooldowns use automatic backoff while Auto remains enabled. Retry after 5 seconds, exponentially up to 60 seconds, and honor any longer Binance `blockUntil`. On recovery, refresh account/positions and reconcile before scanning again. No entry writes run during the wait. Manual Stop clears retry intent; the retry code never changes `auto` from false to true. Uncertain entries/closes, pending reductions, authentication/signature failures, unmanaged positions/orders and the $100 session stop retain their existing blocking behavior. No automatic blind order retry is introduced.

Local relay unsupported-route errors are labeled as local-backend failures instead of being called Binance trade rejections. Read-only request errors carry method/path metadata; a failed GET is not an uncertain order submission.

## Accounting, controls and deployment

Net session result includes USDT realized trading P&L, commission, funding and the change in unrealized P&L from the opening snapshot. It differs from Binance unrealized P&L alone. A new $100 session requires an explicit action while flat.

Copy scan diagnostics works with zero trades, busy work or disconnected snapshots, without account requests or credentials/balances. Three public scan workers, caching, serialized order writes, responsive Stop controls and exit checks during scanning remain.

Browser mode needs the page running for Bollinger profit exits and the account-wide $100 close. Accepted exchange loss stops can remain when the page closes. Pair Mobile/background mode uses laptop files and needs the laptop awake and connector running. Publishing a website does not replace that loaded engine: update its files and restart it. A browser using only the local relay loads the engine from the website. The UI reports the actual engine version and exit policy so an old engine is not presented as running the new rules.

Start requires One-way and Single-Asset Mode. Account modes are not changed automatically. Credentials remain in memory or the explicitly saved encrypted vault. Use one execution owner per demo account.

The current `render-backend/server.cjs` allows the signed Demo-only `GET /fapi/v1/userTrades` fee read and `GET /fapi/v1/leverageBracket` leverage read. Replace the backend files and restart the Windows connector, even when using only the local relay. An old relay rejects this new read and cannot support the new fee calculation. Pair Mobile/background engines additionally need the updated engine and generated page. A website refresh alone does not update running laptop code.

## Validation and references

Deterministic tests cover mirrored LONG/SHORT qualification, fixed-margin maximum-leverage sizing, middle and outer target exits, fresh continuation, loss exits, migration, paid fees, manual controls, leverage/capacity errors, read recovery, unknown writes, mobile snapshots and old-connector detection. These verify execution behavior, not profitability.

Indicator references: [John Bollinger's rules](https://www.bollingerbands.com/bollinger-band-rules), [Bollinger Bands calculation](https://www.bollingerbands.com/bollinger-bands), [Williams %R](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/williams-r).

# Binance Demo execution module — V1.51

This module sends USDⓈ-M orders exclusively to `https://demo-fapi.binance.com`. It has no live endpoint, withdrawal or transfer capability.

Build with `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Run `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs` for engine, controls, mobile and backend checks.

## V1.51 behavior

New bot entries receive a planned **$4 net loss stop**, including estimated fees. Profits are closed manually: no automatic take-profit, profit-pullback floor, timed loss exit or recovery extension. Different symbols can enter consecutively after their checks, with serialized order submissions; the global one-minute entry delay is removed.

Small movement after a signal no longer rejects an otherwise valid setup immediately. Entry prices may move up to 0.75 of the selected candle ATR from its close. Breakouts may retest their boundary by up to 0.10 ATR. Momentum entries still need to remain beyond their trend boundary, and fresh directional confirmation remains required. Larger reversals, stale quotes and unworkable costs still skip the entry.

Temporary failures while reading a candidate's candles, quote, mark, commission or order inventory skip that candidate and continue scanning. This recovery is limited to explicit GET requests before an entry is dispatched. Definite Binance price-filter rejections (-4016, -4024 and -4131) also skip the candidate without retrying the order. Unknown write outcomes, authentication/signature errors, rate limits and protection failures retain their existing reconciliation or pause behavior.

## Current entry rules

- Prioritize the top 10 eligible Futures demo gainers for BUY and top 10 losers for SELL, then rotate through other USDT perpetuals. Previously checked coins repeat. Rankings are past 24-hour price changes, not predictions.
- Accept confirmed breakouts or momentum continuation on completed 1–5m, 10m, 15m, 20m, 30m or 60m candles. The strongest agreement tier is not required. These rules do not produce a calibrated win probability; “50% good” cannot be asserted from them.
- Momentum continuation requires aligned 5/20 means, the 5m trend in the same direction, the latest candle and close moving in that direction, body at least 40% of range, directional close strength at least 65%, and volume at least 0.8 times the prior 20-bar mean. Reject candles or extensions exceeding two recent ATRs. No new 20-candle high/low is required.
- Target $300 margin per new trade before fees, rounded up to Binance's quantity step. Actual market fills and partial fills can differ. Do not send an undersized order when margin plus fees cannot fit. Existing positions are not resized.
- Leverage ceiling is 3×, 5× or 10× according to observed rule agreement. Mixed, unavailable or opposing closed BTC 5m context caps it at 3×. Volatility, fees, tick sizes and exchange limits can lower it to 1×.
- Fresh 1m direction and executable quotes must confirm the setup. Require one recent 1m ATR plus estimated round-trip costs to fit the $4 planned loss target. The selected setup timeframe supplies the commission screen: two observed ATRs must exceed three times estimated round-trip fees per unit. This is a cost screen, not a price forecast.
- Retain every qualifying same-direction timeframe from shared candle responses. If an earlier candidate fails price, freshness or commission checks, consider the next before any order is submitted. Longer-timeframe fee screening is not limited to a single 1m move.
- Cross margin, $5,000 total margin budget, no fixed position-count cap, one position per symbol. Keep the 10-minute same-symbol cooldown after close. Different symbols have no global entry delay.

## Stops, manual profits and accounting

Accepted fills receive a $4 planned net stop immediately. Exchange protection is separate from entry; failures attempt a reduce-only close. Stop fills can exceed the target through gaps, slippage, fees or delays.

Existing bot positions adopt the new exit policy during reconciliation. A replacement $4 exchange stop is confirmed before old bot stop, take-profit or profit-floor exits are cancelled. Existing quantities and leverage remain unchanged. If the position already breaches the loss target, the engine attempts a reduce-only close. Manual positions are not adopted or closed.

At an observed $100 account-wide net session result, new entries pause and remain latched off. This target does not close profitable positions; manual profit control and existing loss protection remain active. A new session requires an explicit action while flat. Net includes USDT realized trading P&L, commission, funding and the change in unrealized P&L from the opening snapshot, so it differs from Binance's unrealized P&L alone.

## Diagnostics and deployment

Entry status and Copy scan diagnostics work with zero trades. Copying is snapshot-only, does not wait for the engine queue or call signed account endpoints, and remains available when disconnected. It includes engine version, Auto/readiness state, check/setup/accepted-entry/error counts, per-timeframe reasons and elapsed times. It excludes credentials and account balances. Trade result export retains its separate fresh-account requirement.

Three public scan workers, candle caching, serialized order writes, responsive controls and risk checks during scanning are retained. Browser mode needs the page running. Pair Mobile/background mode uses the engine loaded from laptop files and requires the connector running and laptop awake. Publishing or refreshing the website does not update that loaded engine: update its files and restart it. The controller displays the actual engine version and entry policy, including its loss target and profit mode. A browser using only the local relay loads the engine from the website.

Start requires One-way and Single-Asset Mode. Account-wide modes are not changed automatically. API credentials remain in memory or the explicitly saved encrypted browser vault. The local order journal contains no secret. Use one execution owner for a demo account.

Validation: 233 automated checks passed with synthetic credentials and mocked exchange responses. Coverage includes bounded BUY/SELL movement, unsafe reversal rejection, temporary candidate reads, definite rejections followed by another accepted entry, unknown writes, $4 exchange protection, old-exit migration, manual profits, the $100 pause, controls, diagnostics and mobile version reporting. Build checks JavaScript syntax and DOM bindings. No account-connected trading or profitability backtest was performed; a qualifying signal does not guarantee a fill or profit.

Official references: [Binance USDⓈ-M error codes](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/error-code) and [HTTP and execution-status handling](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info).

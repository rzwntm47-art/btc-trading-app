# Binance Demo execution module — V1.50

This module sends USDⓈ-M orders exclusively to `https://demo-fapi.binance.com`. It has no live endpoint, withdrawal or transfer capability.

Build with `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Run `node --test demo-execution/*.test.cjs render-backend/*.test.cjs` for engine, controls, mobile and backend checks.

## V1.50 entry-path repair

Previously the scanner returned its first qualifying setup; entry-price or commission rejection then hid later qualifying timeframes. It now retains every qualifying same-direction timeframe from the shared candle responses and selects the first fresh, untraded candidate that passes price and commission checks before submission. This is candidate selection, never a retry of an exchange order.

A 5m or longer setup uses its own observed ATR for the fee screen. It still requires fresh 1m directional confirmation and uses fresh 1m volatility for the $8 loss sizing check, but it no longer requires a single 1m move to clear the longer-horizon commission screen. One-minute setups retain that additional fresh 1m cost check.

Both entry-blocking cases were reproduced as failing V1.49 regression tests and pass after the repair. Live account behavior and profitability have not been verified.

Entry status and Copy scan diagnostics work with zero trades. Diagnostic copying is snapshot-only, does not wait for the engine queue or call signed account endpoints, and remains available when disconnected. It includes engine version, Auto/readiness state, check/setup/accepted-entry/error counts, per-timeframe reasons and request elapsed times. It excludes credentials and account balances. Trade result export retains its separate fresh-account requirement. Older laptop engines are identified explicitly; updating the web page does not replace a running laptop engine.

## Current entry rules

- Prioritize the top 10 eligible Futures demo gainers for BUY and top 10 losers for SELL, then continue rotating through other USDT perpetuals. Previously checked coins repeat. Rankings are past 24-hour price changes, not predictions.
- Accept confirmed breakouts or momentum continuation on completed 1–5m, 10m, 15m, 20m, 30m or 60m candles. The previous strongest-tier-only gate is removed; confirmation remains required.
- Momentum continuation requires aligned 5/20 means, the 5m trend in the same direction, the latest candle and close moving in that direction, body at least 40% of range, directional close strength at least 65%, and volume at least 0.8 times the prior 20-bar mean. Reject candles or extensions exceeding two recent ATRs. It does not require a new 20-candle high/low.
- Target $300 margin per new trade before fees, rounded up to Binance's quantity step. Actual market fills and partial fills can differ. Do not send an undersized order when margin plus fees cannot fit. Existing positions are not resized.
- Leverage ceiling is 3×, 5× or 10× according to observed rule agreement. Mixed, unavailable or opposing closed BTC 5m context caps it at 3×. Volatility, fees, tick sizes and exchange limits can lower it to 1×. There is no probability-of-profit estimate.
- Fresh 1m direction and executable quotes must still confirm the setup. Retain the commission screen and require one recent 1m ATR plus estimated round-trip costs to fit the $8 planned loss target. Reject stale, reversed, too extended or unworkable entries.
- Cross margin, $5,000 total margin budget, no fixed position-count cap, one position per symbol. Preserve 60-second entry spacing and a 10-minute same-symbol cooldown after close.

## Unchanged exits and accounting

The planned net loss stop remains $8, including estimated fees. No timed loss exit and no recovery extension. Exchange stop placement is separate from entry; accepted fills receive protection immediately. Failures attempt a reduce-only close. Stop fills can exceed the target through gaps, slippage or delays.

Profit-floor activation is strictly above $4, $8, $16, $32, then $37, $42, $47 and further $5 increments. Pullback to or below the highest activated floor requests a close. Reaching a milestone exactly does not activate it. A position whose peak net profit was only $3 has no active profit floor and may return to zero. The UI now shows estimated net, highest observed net and floor status. This explains the rule, not the cause of an uninspected individual trade.

At an observed $100 account-wide net session result, close bot-owned positions and latch new entries stopped. Net includes USDT realized trading P&L, commission, funding and the change in unrealized P&L from the opening snapshot. It differs from Binance's unrealized P&L alone. The final realized result may differ from the observed target. Manual positions are not closed.

## Execution and updates

V1.47's three public scan workers, candle caching, serialized order writes, controls, timing diagnostics and risk checks during scanning are retained. Definite recoverable order rejections keep scanning; uncertain writes are reconciled without blind retries. Exchange access errors and rate limits can pause entries.

Browser mode needs the page running. Pair Mobile/background mode executes the engine loaded from laptop files and requires the connector running and laptop awake. A website refresh does not update the loaded laptop engine. The controller uses the actual engine's reported sizing policy; an older engine is explicitly shown as needing an update rather than being labelled with the new settings. Connection transport is unchanged in this strategy release.

Start requires One-way and Single-Asset Mode. Account-wide modes are not changed automatically. API credentials remain in memory or the explicitly saved encrypted browser vault. The local order journal contains no secret. Use one execution owner for a demo account.

Validation: 214 automated checks passed with synthetic credentials and mocked exchange responses, including momentum-only BUY/SELL fills, reversal rejection, leverage/capacity fallback, stops, profit-floor boundaries and mobile-version reporting. Build checks JavaScript syntax and DOM bindings. No account-connected trading or profitability backtest was performed. This is an unvalidated demo strategy; faster or more frequent entries do not establish a profitable edge.

Fee reference: [Binance Futures commission calculation](https://www.binance.com/en-AE/support/faq/detail/98488a516eb84e3eb34605683dffd554) uses notional value times the fee rate. The app reads the account's actual commission rate for each proposed entry.

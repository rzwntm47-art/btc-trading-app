# Binance Demo execution module — V1.53

This module sends USDⓈ-M orders exclusively to `https://demo-fapi.binance.com`. It has no live endpoint, withdrawal or transfer capability.

Build with `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Run `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs` for engine, controls, mobile and backend checks.

## Current exit policy

- No bot stop-loss, timed loss exit, recovery extension or profit-pullback floor.
- Each bot position receives a TAKE_PROFIT_MARKET order targeting $20 estimated net profit after opening and expected closing taker fees. The engine also requests a reduce-only close when its observed net estimate reaches $20. It does not wait for a pullback. Actual fees, funding, price ticks, fills and slippage can change the result.
- At an observed $100 account-wide net session result, latch new entries stopped and close every bot-managed position, including losers. Manual/unmanaged positions are not adopted or closed. Finish unresolved closes on later passes even if P&L falls below the target. The final booked result is not guaranteed to equal $100.
- The session target is checked before individual profit exits so an observed qualifying aggregate result is not lost during the conversion from unrealized to realized P&L. Pending or partially filled entry orders must reach a verified terminal status before their positions close; this prevents a remaining entry quantity from refilling after the session stops. Unknown close outcomes are queried without blind order retries.
- Existing bot positions adopt the policy when the updated engine synchronizes. Confirm a fresh $20 TP before cancelling old journaled stop-loss, TP or profit-floor orders. Keep quantity and leverage unchanged. Repeated synchronization does not replace an already confirmed TP. If exit configuration fails, pause entries and attempt an emergency reduce-only close.
- The $100 profit target is not a loss limit. Losing positions can remain open, lose shared Cross collateral or be liquidated. The app does not set a maximum loss in this mode.

`lossLimit` is null, `takeProfit` is 20, `exitPolicy` is `profit-cap`, and records use rules version 6. `protected` remains false because there is no loss protection; `exitsReady` means the required TP is verified. Historical stop helpers remain for old test fixtures, but production `newRules=true` bypasses those exit branches.

## Entry behavior

The signal strategy remains movers plus momentum/breakout confirmation. Prioritize the top 10 eligible Futures demo gainers for BUY and top 10 losers for SELL, then rotate through other USDT perpetuals. Coins repeat. Rankings are past price changes, not predictions. Use completed 1–5m, 10m, 15m, 20m, 30m or 60m candles. The strongest agreement tier is not required, but no calibrated win probability is claimed.

Momentum requires aligned 5/20 means, confirming 5m direction, a directional candle and close, body at least 40% of range, directional close strength at least 65%, volume at least 0.8 times its recent average, and no extension beyond two ATRs. All qualifying same-direction timeframes remain candidates; an earlier failing candidate cannot hide a later valid one.

Target $300 margin per new entry, rounded up to the quantity step. Adaptive leverage stays within 1–10× and exchange capacity; no fixed position-count cap, one position per symbol, $5,000 total margin budget, Cross. Different symbols can enter consecutively with serialized writes. The same symbol has a 10-minute cooldown after closing.

The existing $20 one-ATR-and-fees allowance remains an entry sizing check only. It can reduce leverage or skip excessive exposure; it is not a stop-loss or maximum loss. New trades calculate no stop price and are not rejected for stop tick placement. Fresh spread/mark movement is included in the entry exposure estimate. The selected timeframe must clear the existing commission screen; fees cannot already consume the $20 profit target.

Entries tolerate up to 0.75 ATR drift from the selected close and up to a 0.10 ATR breakout retest, while momentum boundaries and fresh direction remain required. Stale, reversed or unworkable quotes skip the candidate. Temporary candidate-only GET failures and definite price-filter rejections keep scanning; uncertain writes, access errors and rate limits retain their reconciliation/pause behavior.

## Accounting, controls and deployment

Net session result includes USDT realized trading P&L, commission, funding and the change in unrealized P&L from the opening snapshot. It differs from Binance unrealized P&L alone. A new $100 session requires an explicit action while flat.

Copy scan diagnostics works with zero trades, busy work or disconnected snapshots, without account requests or credentials/balances. Three public scan workers, caching, serialized order writes, responsive Stop controls and exit checks during scanning remain.

Browser mode needs the page running. Accepted exchange TP orders can remain after the page closes; the account-wide $100 close requires a running engine. Pair Mobile/background mode uses laptop files and needs the laptop awake and connector running. Publishing a website does not replace that loaded engine: update its files and restart it. A browser using only the local relay loads the engine from the website. The UI reports the actual engine version and exit policy so an old engine is not presented as running the new rules.

Start requires One-way and Single-Asset Mode. Account modes are not changed automatically. Credentials remain in memory or the explicitly saved encrypted vault. Use one execution owner per demo account.

Validation: 246 automated checks passed using synthetic credentials and mocked exchange responses. Coverage includes long/short fee-aware TP pricing, no automatic loss/timer exits, migration from old $4/$8/$12/$20 stops, idempotent reconciliation, $100 closure of winners and losers, failed/unknown/partial closes, target priority during ticks, entry guards, controls, diagnostics and engine-version reporting. Build checks syntax and DOM bindings. No account-connected trading or profitability backtest was performed.

Official API reference: [USDⓈ-M New Algo Order and close-position behavior](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

# Binance Demo execution module — V1.54

This module sends USDⓈ-M orders exclusively to `https://demo-fapi.binance.com`. It has no live endpoint, withdrawal or transfer capability.

Build with `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Run `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs` for engine, controls, mobile and backend checks.

## Current exit policy

- Close a bot-managed position when fresh estimated closing net is strictly positive, including a profit below $1. No $20 cap or pullback wait. Use the executable bid for a long or ask for a short, weighted through up to 20 order-book levels if the best quote cannot fill the whole remaining position. Require valid prices and data no older than five seconds. Recheck position size and profitability immediately before dispatch.
- The estimate deducts proportional estimated opening and expected closing taker fees for the remaining quantity. It excludes funding and already realized portions; these appear in account-wide session income. It is separate from Binance mark-based unrealized P&L and may differ from the Binance close dialog and actual fills. Positive estimates do not guarantee profitable execution.
- When estimated net is negative, reduce 25% of the current position once, rounded down to the exchange quantity step. Fees alone may trigger this immediately after entry. Persist the client ID and quantity before the reduce-only market request. Query uncertain responses; never blindly submit another reduction. A terminal partial fill counts as the one reduction. A definite rejection or quantity below exchange limits is reported without repeatedly trying the same trim. The remaining position is not topped up.
- A 25% reduction realizes part of the loss and incurs commission. It reduces exposure and can release margin; it does not recover losses or cap the loss on the remainder. No stop-loss, loss timer, recovery extension or profit-pullback floor applies.
- Existing bot positions adopt the policy when the updated engine synchronizes. Cancel only old journaled bot SL/TP/floor orders. Create no standing exchange profit or stop orders under this policy. A failed cancellation blocks migration. A failed closing quote is displayed and retried on a later check; it must not cause an unwanted full loss close.
- At an observed $100 account-wide net session result, latch new entries stopped and close every bot-managed position, including losers. Manual/unmanaged positions are not adopted or closed. The session target has priority over individual exits. Confirm cancellation of pending entry/reduction remainders before full closes, and finish unresolved closes even if net falls below $100. The final booked result is not guaranteed to equal $100.
- These automated exits require the execution engine running. The $100 profit target is not a loss limit. Remaining positions can lose shared Cross collateral or be liquidated.

`lossLimit` and `takeProfit` are null, `exitPolicy` is `positive-estimate`, and records use rules version 7. `lossReduction` preserves the once-only order and result. `protected` remains false because there is no loss protection; `exitsReady` means migration to the app-managed policy completed. Historical stop helpers remain for legacy tests; production `newRules=true` bypasses those branches.

## Entry behavior

The signal strategy remains movers plus momentum/breakout confirmation. Prioritize the top 10 eligible Futures demo gainers for BUY and top 10 losers for SELL, then rotate through other USDT perpetuals. Coins repeat. Rankings are past price changes, not predictions. Use completed 1–5m, 10m, 15m, 20m, 30m or 60m candles. The strongest agreement tier is not required, but no calibrated win probability is claimed.

Momentum requires aligned 5/20 means, confirming 5m direction, a directional candle and close, body at least 40% of range, directional close strength at least 65%, volume at least 0.8 times its recent average, and no extension beyond two ATRs. All qualifying same-direction timeframes remain candidates; an earlier failing candidate cannot hide a later valid one.

Target $300 margin per new entry, rounded up to the quantity step. Adaptive leverage stays within 1–10× and exchange capacity; no fixed position-count cap, one position per symbol, $5,000 total margin budget, Cross. Different symbols can enter consecutively with serialized writes. The same symbol has a 10-minute cooldown after closing.

The existing $20 one-ATR-and-fees allowance remains an entry sizing check only. It can reduce leverage or skip excessive exposure; it is not a stop-loss or maximum loss. New trades calculate no stop price and are not rejected for stop tick placement. Fresh spread/mark movement is included in the entry exposure estimate. The selected timeframe must still clear the existing commission screen. The obsolete fixed $20 take-profit fee check is removed; the separate $20 entry sizing allowance remains.

Entries tolerate up to 0.75 ATR drift from the selected close and up to a 0.10 ATR breakout retest, while momentum boundaries and fresh direction remain required. Stale, reversed or unworkable quotes skip the candidate. Temporary candidate-only GET failures and definite price-filter rejections keep scanning; uncertain writes, access errors and rate limits retain their reconciliation/pause behavior.

## Accounting, controls and deployment

Net session result includes USDT realized trading P&L, commission, funding and the change in unrealized P&L from the opening snapshot. It differs from Binance unrealized P&L alone. A new $100 session requires an explicit action while flat.

Copy scan diagnostics works with zero trades, busy work or disconnected snapshots, without account requests or credentials/balances. Three public scan workers, caching, serialized order writes, responsive Stop controls and exit checks during scanning remain.

Browser mode needs the page running for positive-net closes, loss reductions and the account-wide $100 close. There are no standing exchange exits under this policy. Pair Mobile/background mode uses laptop files and needs the laptop awake and connector running. Publishing a website does not replace that loaded engine: update its files and restart it. A browser using only the local relay loads the engine from the website. The UI reports the actual engine version and exit policy so an old engine is not presented as running the new rules.

Start requires One-way and Single-Asset Mode. Account modes are not changed automatically. Credentials remain in memory or the explicitly saved encrypted vault. Use one execution owner per demo account.

Validation: 278 automated checks passed using synthetic credentials and mocked exchange responses. Coverage includes long/short fee-aware closing quotes, weighted depth, stale/invalid/insufficient quotes, revalidation before dispatch, once-only trims and quantity limits, migration from old stops/TP, persistence across reloads, unknown/rejected/partial orders, manual/session cancellation ordering, $100 closure of winners and losers, entry guards, controls, position-card P&L labels, diagnostics and engine-version reporting. Build checks syntax and DOM bindings. No account-connected trading or profitability backtest was performed.

Official API reference: [USDⓈ-M orders, reduce-only and order queries](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

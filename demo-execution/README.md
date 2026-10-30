# Binance Demo execution module

Build: `node demo-execution/build.cjs`

Tests: `node --test demo-execution/engine.test.cjs`

Publish the generated `demo-connect.html` at the repository root. The main paper dashboard remains independent; its Binance Demo dialog loads this page.

This module sends USD-M orders exclusively to `https://demo-fapi.binance.com`. It has no live endpoint or fallback, withdrawal or transfer capability. Authentication stays in memory. A browser Web Lock prevents concurrent writers in tabs of the same browser. A SHA-256 API-key fingerprint namespaces a local, non-secret order journal. Different browsers/devices are not coordinated: use one dedicated demo account and one instance.

Start requires One-way and Single-Asset Mode; account-wide modes are never changed automatically. Each symbol is configured for 15x isolated margin before entry. MARKET_LOT_SIZE and minimum notional filters are applied; a market entry is followed by close-position stop and take-profit conditional orders. These separate API calls are not atomic. Closing the page or losing connectivity during submission can leave a position awaiting protection; inspect Binance directly in that case. Known pending IDs are reconciled after reconnect, never blindly resubmitted. No exact fill, stop loss, or profit is guaranteed.

The 20-closed-candle 5m breakout strategy is retained as an unvalidated demo strategy. Rotating batches cover eligible crypto perpetuals. No profit assurance or inference of future candles is made. Combined balance is an estimate from the demo asset indices, not a constant copied from a screenshot. The session goal uses actual USDT income entries (realized P&L, commissions, funding) plus open USDT unrealized P&L. It excludes transfers and non-USDT asset revaluation; it is account-level, so do not mix other trading with this session. Open per-position exit estimates use taker fee rates; actual fills and funding may differ. Sessions older than seven days require review and a fresh session when flat.

Stop Auto prevents new entries and preserves management/protection. Reload stops entry automation and clears credentials. Exchange-accepted protective orders can remain while the page is closed. New entries, profit-floor activation and session-goal enforcement require the page running. There is no server-based 24/7 execution.

The test suite uses synthetic credentials, mock exchange responses and no network orders. Browser account access and signed order placement require validation with the user's private demo credentials. No live or demo exchange order was placed during development.

Official references: Binance USD-M REST trade API (order, algoOrder, leverage, marginType, positionRisk), account API (account, income, commissionRate, position mode), and market API (exchangeInfo, klines, premiumIndex, assetIndex).

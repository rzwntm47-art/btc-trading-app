## V1.75 — resolve a filled entry whose open position was never seen

A fast-closing trade could fill and close before the first position snapshot. Its journal had FILLED but no observedOpen flag, so reconciliation repeatedly blocked all new entries even while positions and orders were empty. The new recovery reads the exact entry fills, follows execution history from that entry, and requires complete entry/closing quantities to balance exactly. It then rechecks current positions and the symbol’s basic/conditional orders before marking that historical record closed. No order is placed, replayed or cancelled by this recovery.

A position that appears during either fresh check is retained and goes through normal protection. Missing/incomplete fills, another entry changing the position, unresolved closes, open orders, read errors or failed journal saves keep the hold. Flat display data or elapsed time alone cannot retire the record. Verification retries are paced, repeated stopped-bot waiting logs are suppressed, and the pending-trade panel shows the actual reconciliation reason. Reports retain closure evidence.

After installing both folders and restarting/reconnecting the laptop connector, use Sync Binance and Start / Resume Demo if stopped. A running Auto resumes scanning once all holds clear; manual Stop and the $20 session target remain in force. No history reset is needed.

API references: [account trade list](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Account-Trade-List), [query order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Query-Order), [position information](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Position-Information-V3).

## V1.74 — dedicated net-result counter reset

The previous button still invoked the full journal reset, which refuses existing positions or orders. The result panel now has its own **Reset result to $0** button, and both reset buttons call a dedicated counter action. It reads fresh account/position values, saves a new time window, preserves all trade records, orders, ownership and exit levels, and stops new entries. Existing unrealized PnL becomes the opening baseline, so subsequent changes and income count toward the same $20 target. It does not reset the wallet.

The panel shows a persistent pending, confirmed or failed result. Success requires the engine confirmation to match a freshly loaded saved window. An overlapping older status poll must finish before a new post-command read, preventing it from restoring an obsolete amount. Older laptop engines advertise no counter capability and receive a visible update instruction instead of a false success. The full journal reset remains available only through its existing host command; no automatic fallback invokes it.

Update the laptop code folders and run START-LAPTOP.cmd to load V1.74, then reconnect. A public website update does not replace a local engine.

## V1.73 — reset net trading result to $0.00

**Reset result to $0** now saves a new accounting window immediately and renders $0.00 after a successful reset. It verifies the account is flat with no pending orders, archives the previous bot records, clears the old target latch and closing estimate, and leaves Auto stopped. The wallet, entry/exit strategy and $20 target are unchanged.

The saved reset time survives page refreshes and connector restarts. Income reads use a fixed window, validate timestamps, exclude rows outside that window, and discard late responses belonging to an earlier session. The dashboard only displays income associated with its current session. Subsequent gains, losses and fees count normally from the reset time. Storage failures keep the previous session instead of claiming success.

For background mode, update both code folders and restart the laptop connector to load V1.73, then reconnect and use Reset result to $0. Existing exchange/account history is not erased.

## V1.72 — laptop connector restart

The launcher now performs an authenticated, graceful restart of an already-running V1.72 connector, waits for pending engine and relay work, preserves saved state, and rejects unsafe port conflicts or incomplete installations. Older connectors need their old window closed once after Stop Auto and pending actions finish. No force-kill or automatic order replay is used.

After restarting, the laptop dashboard reveals credential/reconnect controls, displays the loaded connector version before account connection, and keeps the $20 target visible. Reconnect the same Demo account, then Start / Resume. Phone access stays paired and API signing keys stay memory-only. Existing trading rules are unchanged. See `render-backend/README.md` for installation.

## V1.71 — fresh direction required before entry

The 24-hour movers list remains a candidate list. The prior longer-timeframe Bollinger check could permit a small opposing 1m candle, and the final order gate reused the earlier minute-candle assessment. V1.71 requires an aligned completed 1m candle for every Bollinger timeframe and reads uncached 1m candles again after exchange settings, before fetching the final bid/ask. This is a targeted entry change; existing position management, $300 margin, fee limits, leverage selection, $2–$6 early loss exit, $6/$12 loss rules, profit floors and $20 session target remain.

- A BUY needs the latest closed minute's close above its open and previous close; SELL mirrors this. Body must occupy at least 40% of the candle range, with the close in the directional 35% of that range. A 1m Bollinger entry must also retain its original reversal setup. No contradictory requirement to be above/below the Bollinger middle is added.
- Capture a baseline best bid/ask during initial direction checks. At final dispatch, both must have advanced at least the greater of two ticks or 5% of the recent 1m ATR. The baseline must be no more than 10 seconds old; the final quote no more than 5 seconds old, with a distinct later transaction time. The final quote cannot reverse against the intermediate quote used for sizing. Duplicate, out-of-order, invalid and stale observations skip the trade without an order or journal entry.
- The executable closing side of the final quote must not be adverse to the latest closed 1m close, or more than 0.75 ATR beyond it. If a forming 1m candle is returned, validate its OHLC and time and require its body and executable price to agree with the entry direction. The forming candle is a veto, never a replacement for completed-candle confirmation.
- Missing final candle/quote data skips the entry; authentication and rate-limit handling remain authoritative. Stop and queued manual actions still cancel dispatch. Recheck size, fees, spread, signal price boundaries and net target room using the final quote.
- Store `entryEvidence.liveDirection` in the trade report, show the entry confirmation on position cards, and include skipped-entry evidence in scan diagnostics. Existing positions and persisted trade history are not reset. Quotes are observations, not a forecast; spread and commissions can make a new trade net-negative, and subsequent prices/fills can still lose.

Validation uses synthetic market data and exchange mocks, including rising/falling prices, reversals during setup, stale and repeated quotes, spread-only moves, failed final reads, manual Stop and existing exits. These checks do not establish profitability or explain a specific historical loss without its trade report. No recent account report was available during this review.

Activation: refresh and reconnect browser mode. For laptop/background mode, replace the current code folders while preserving journals/data, restart `START-LAPTOP.cmd`, reconnect and verify the running engine shows V1.71. Publishing the site does not update a laptop process.

Market data fields: [Binance Futures market data documentation](https://developers.binance.info/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data).

## V1.70 — $20 net session target

The net trading result and automatic session close-and-stop target are now $20 after expected closing fees. Entry and exit strategies, $2–$6 early loss exits, session locks and history are unchanged. Refresh/reconnect browser mode; update the laptop files and restart START-LAPTOP.cmd for background mode. Older laptop connectors continue to show their actual target until updated.

## V1.69 — $25 net session target

The net trading result and automatic session close-and-stop target are now $25 after expected closing fees. Existing entry and exit strategies, $2–$6 early loss exits, session locks and history are unchanged. Refresh/reconnect browser mode; update the laptop files and restart START-LAPTOP.cmd for background mode. Older laptop connectors continue to show their actual target until updated.

## V1.68 — $30 net session target

The net trading result target is now $30. Once estimated session net after closing fees reaches $30, close all bot-owned positions and stop new entries using the existing session latch. Keep fees, funding, partial-order reconciliation, the current P&L window and all $2–$6 early exit / $6 recovery / $12 backup rules unchanged. Existing session locks and history are preserved; no automatic restart or balance reset is performed.

The heading, New $30 session button, diagnostics, reports and engine use the same target. A connected older laptop still displays its actual $100 target and the update banner until it is updated and restarted. Refresh/reconnect browser mode; replace the laptop folders and restart START-LAPTOP.cmd for background mode.

## V1.67 — additional early loss exit

V1.66 entries, margin/leverage sizing, fee filters, $6 normal loss/recovery rules, $12 exchange backup, stepped profit floors and $100 session stop are unchanged. Existing bot-owned open positions receive this extra check when the updated engine reconciles them; their quantity, leverage, journal and armed profit floors are preserved.

A trade with **at least $2 but less than $6 total net loss**, and negative price P&L, can close early when one of these conditions is confirmed:

- Three independent executable-price observations at least 1 second apart, all within 15 seconds, move strictly against the position. The latest observation must be within 5 seconds. Both the move from entry and the observed deterioration must reach the greater of two price ticks or 5% of the entry signal ATR. The final quote must still be at least as adverse as the last observation.
- A completed 1-minute candle **after entry**, no older than 75 seconds, shows either a sharp opposing body (at least 0.6 ATR and a close at least 0.3 ATR against the prior close), or sustained opposing momentum (opposing 5/20-close averages and a three-candle move of at least 0.8 ATR). The executable quote must not have recovered more than 0.1 ATR from that candle close; the same entry/noise allowance applies.

The $2 lower bound makes this extra exit eligible; it does not trigger a fixed $2 stop. Below $2 loss this additional exit holds, even if its adverse signals are present. At $6 loss or worse the unchanged normal/recovery/backup rules take over. The final pre-order check must still be in the $2–$6 window; recovering to less than $2 loss cancels the early close. Fees alone, a single tick, stale evidence and unavailable candle data do not trigger this additional exit. These are unvalidated deterioration heuristics, not forecasts or a guarantee of smaller losses. Spread changes, latency and market fills can affect outcomes. Existing normal/hard loss and armed-profit rules take precedence. Quote/position/fee checks run again before a reduce-only close; ambiguous writes retain the existing journal/reconciliation behavior. Evidence is shown per position and in the trade report under `earlyLossReview`; the close reason is `Early adverse-move exit`.

Activation: browser mode needs the refreshed V1.67 execution page and reconnection. Laptop/background mode needs updated `demo-execution` and `render-backend` folders, keeping the existing data/journals, followed by restarting `START-LAPTOP.cmd` and reconnecting. Mobile reflects the actual laptop engine version. A website refresh cannot change a running laptop process. No running account is remotely restarted by this code update.

Validation: `node demo-execution/build.cjs` and `node --test demo-execution/*.test.cjs render-backend/*.test.cjs`. Mocked tests check behavior and regression coverage; they are not a trading-performance backtest or a Binance execution test.

# Binance Demo execution module — V1.66

USDⓈ-M orders go exclusively to `https://demo-fapi.binance.com`. No live endpoint, withdrawals or transfers.

Build: `node demo-execution/build.cjs`, then copy `demo-execution/demo-connect.html` to the repository root. Verify with `node --test --test-timeout=10000 demo-execution/*.test.cjs render-backend/*.test.cjs`.

## V1.66 mobile continuity and skipped-entry fixes

Phone access is established once using **Mobile — same account → Create phone link → Copy phone link**. Opening that link on the phone remembers only its validated private `.ts.net` origin on the public app origin, then navigates to the laptop controller. Subsequent launches of the same public app/browser storage open that private controller. No Binance API key or pairing code is saved in public local storage; a Secure/HttpOnly/SameSite cookie authorizes the private session. Different browsers or a separately stored home-screen installation may require opening the link in that context once. `demo-connect.html?local=1` forgets the saved phone address for that public browser.

The laptop persists only hashed phone session IDs, CSRF secrets, expiry, private origin and an API-key fingerprint, under its restricted data directory. Existing trusted phones reconnect after a restart once the laptop account reconnects. Trust is revoked by explicit disconnect, Revoke all phones, changing the Binance key or changing the private origin. Unused trust expires after 30 days; active trust renews. API signing secrets remain in process memory, so this does not auto-login or auto-start the laptop after a shutdown. The private connection (Tailscale on both devices) is still required; there is no public trading relay or cloud account.

Entry fixes retain V1.65 thresholds and strategy. A definitely rejected order no longer marks its candle as traded or consumes the filled-trade cooldown. A 30-second per-symbol rejection delay precedes fresh balance/order/signal/quote checks. Filled or uncertain orders still block duplicates. Full local fee/sizing checks try subsequent qualified timeframes before skipping the symbol. Actual commission is cached for at most 60 seconds per account/symbol; failures defer that symbol for 30 seconds, never substitute zero or an expired value, and authentication/rate-limit failures remain account-wide. Scan rows explicitly label app filters, unavailable entry data, exchange-setting rejections and Binance order rejections. Counts and detailed timeframe reasons are included in diagnostics.

Validated with mocked exchange requests and restart/reconnection tests; this is not live profitability validation or a diagnosis of any unseen laptop log.

## V1.65 continuous management and entry costs

Built from restored V1.63, without the cancelled V1.64 $1 commission cap. Existing entry signals, $300 margin, gainers/losers selection, re-entry cooldown, $5 / $8 / $11 / +$3 profit floors, normal $6 loss/recovery checks, $12 backup and $100 net session stop remain.

- Auto stays enabled through recoverable reads and entry/protection reconciliation. `entryHold` blocks new dispatches until fresh account, inventory and protection checks pass. It does not cancel Start intent. Explicit Stop/disconnect/reset and the session goal still stop new entries. Pending or ambiguous writes must be queried and reconciled, never blindly retried. Initial connection remains stopped until requested Start.
- Position management runs before the account income summary. Entry-only retry delays do not skip position checks. One position's ordinary reconciliation error does not prevent checking others; account-wide rate/authentication failures stop that pass. Binance rate-limit deadlines are respected. Monitoring needs a reachable exchange and valid data: unavailable fees/funding can defer an accurate net exit, and exchange stops remain the outage backup. No browser or laptop process can run when closed or powered off.
- Fresh successful reconciliation automatically clears entry holds. Unmanaged positions/orders and unverified exits still block entries until resolved; the engine neither takes ownership of them nor cancels them. The UI reports entries waiting separately from position checks, with the last successful management-pass timestamp.
- For new Bollinger entries, the gross move to the middle-band reference must cover at least four times estimated opening-plus-target-closing commission (commission share ≤25%), with at least $5 left after those commissions. This is target headroom, not a predicted outcome or a new take-profit rule. Funding, future price changes and slippage can alter realized net.
- Retain $300 margin and choose the highest accepted leverage also fitting current round-trip commission within half the normal $6 loss budget, alongside existing spread, stop, margin and exchange limits. The final quote and rounded size must pass again before submission. No blanket $1 fee cap or coin blacklist. A high-fee coin can qualify only when both relative cost and risk-budget checks pass. Store final target-cost evidence in the trade report.

## Strategy

V1.63 preserves multi-timeframe Bollinger / Williams %R entries and replaces Profit pullback exits with the user-confirmed after-fee $5 / $8 / $11 / +$3 pullback ladder. The normal loss exit is $6; fresh recovery evidence can permit holding toward a $12 backup target. The one-hour experiment remains disabled. Defaults are Bollinger 20-close SMA ± 2 population standard deviations and Williams %R 14, because the provided transcript omitted settings.

- Refresh eligible demo Futures 24h rankings once per minute. Check up to 20 gainers for LONG and 20 losers for SHORT, rotating eight slots plus recent candidates with three public workers. Recheck continuously; do not enter unrelated full-market coins. Rank is historical movement, not a forecast.
- LONG: last or previous completed candle on that timeframe touches the lower band, one of their WR values is ≤ -80, then the latest candle closes bullish, above the previous close and lower band, with rising WR, still below the middle. SHORT mirrors this at the upper band with WR ≥ -20. Validate candle continuity, OHLC, freshness and positive ATR. Williams %R is a price-range oscillator, not buyer/seller percentages.
- Require room to the middle covering at least four times estimated round-trip fees per unit, plus at least $5 net target headroom at the proposed quantity. Fresh executable quotes, mark, spread, current 1m reversal checks, balance, existing orders and exchange filters still apply. A 1m Bollinger candidate revalidates the same reversal, never the incompatible trend-above-middle momentum rule. Price drift stays within 0.75 selected ATR. A failed setup is shown with a reason; it is not a rejected exchange order.

Check 1m, 2m, 3m, 4m, 5m, 6m, 7m, 8m, 9m, 10m, 15m, 20m, 30m and 60m independently. Two shared reads (250 native 1m bars and 300 native 5m bars) supply them. Synthetic frames use complete UTC-aligned groups, never forming candles. Keep all qualified same-direction candidates; an earlier failure does not discard a later timeframe. Ordinary data errors on one dataset do not discard valid candidates from the other. Rate/authentication errors still block entry. Store the selected interval for exits; older Bollinger positions retain 5m targets.

## Size and leverage

Each new trade targets $300 margin, rounded up to the exchange quantity step. Retain a $5,000 total margin budget, USDT collateral, Cross, one position per symbol and ten-minute same-symbol cooldown. Do not top up or change leverage on existing positions.

Read the symbol leverage ceiling and confirm the highest accepted integer setting that permits the full $300-margin position under Binance notional and quantity limits (supported ceiling 150×). If the highest setting is rejected or lacks capacity, search lower settings and reconfirm the final choice. An unavailable bracket read can use confirmed setting responses. First evaluate every integer leverage locally against executable spread, actual commission rate, mark price, tick-rounded $6 stop and margin plus fees. Also limit current round-trip commission to half the $6 normal loss budget and require $5 net target headroom. Select the highest feasible setting, then confirm exchange capacity. Reduce leverage when needed; do not reduce the $300 margin target. Round quantity at the final quote and verify margin plus fees, lot steps, notional limits and the $6 stop before sending one order.

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



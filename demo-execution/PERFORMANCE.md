# V1.47 scan and entry timing

The scanner uses three concurrent public-data workers. Results are handled as they finish, so a slow first coin does not hold every later candidate. Order submissions and position management remain serialized. Public scan reads are paced at least 100 ms apart in the production API client.

Completed 1-minute and 5-minute candle responses are cached only within the matching candle period. Empty, malformed or incomplete responses are not cached as fresh. The next candle boundary requires a new read. Entry-time momentum, executable quotes and mark prices are still checked separately.

While scanner reads are pending, open-position checks target a 5-second interval. Network delays, exchange cooldowns, pending order reconciliation and browser suspension can extend that interval. This is not a real-time or guaranteed-latency execution system.

Entry preparation reads fresh account and position data without duplicating all-market order inventories. It still checks the candidate's basic and conditional orders. Independent read requests overlap; order writes are never parallelized. Stop and queued manual controls prevent new entry dispatch. Recoverable candle errors affect their row; exchange rate-limit and access errors still stop the scan.

The existing $200 margin, adaptive leverage ceiling of 50, $8 loss target, profit ladder, entry-quality rules, 60-second entry spacing, 10-minute same-symbol re-entry delay and $100 session stop are unchanged. A rule-based WAIT is not a network error or evidence of a profitable missed trade.

## Measurements

Controlled Node simulation: 12 symbols, 250 ms per mocked public response, production request implementation and scan pacing enabled; no orders sent.

| Measurement | Previous scanner | V1.47 |
| --- | ---: | ---: |
| First pass | 6,038 ms | 2,553 ms |
| Same-candle repeat | 3,018 ms | 11 ms |
| First-pass candle reads | 24 | 24 |
| Repeat candle reads | 12 | 0 |
| Maximum concurrent public checks | 1 | 3 |

These numbers do not measure the user's connection or demonstrate profitability. Copy trade report now includes request elapsed times, entry-stage times, scan durations and recent check outcomes. Request time includes queueing, signing, transport and parsing; it is not a pure network ping. Query strings, signatures, API keys and secrets are excluded.

Validation: 192 automated engine, UI, mobile and backend tests passed. Build checks JavaScript syntax and DOM bindings.

## Loading the update

Browser-run mode: refresh the GitHub Pages dashboard and reconnect as needed.

Pair Mobile / laptop-background mode: the engine executes from the downloaded laptop files. A browser refresh alone does not replace that engine. Stop Auto, wait for pending work, close the connector, download/extract the updated repository, and run `render-backend/START-LAPTOP.cmd`. Reconnect and pair the phone again after the connector restart. The laptop token and account journals remain in the same Windows user's application data directory; do not delete them. Accepted exchange protective stops remain at Binance, but app-managed profit exits require the engine to be running. The remote status now shows the actual laptop engine version when available.

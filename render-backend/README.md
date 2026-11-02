# Binance Demo backend — Render Free

Deploy this directory as a Node web service. Root directory: `render-backend`. Build command: `npm test`. Start command: `npm start`. No dependencies or Binance secrets are required.

Set `RELAY_TOKEN` using Render's Generate button (at least 32 random characters). Do not commit it or paste it in chat. The health endpoint reports whether it is configured without exposing it.

After deployment, visit `/check-binance`. `ok: true` confirms only the public time endpoint works from the server. Account permissions, open orders and trade protection must still be tested before starting automation. Share only the public Render service URL, not tokens.

The existing dashboard is not yet wired to this service: its assigned URL is needed first. This backend does not autonomously trade. It relays already signed requests only to the fixed Binance Demo host. It never accepts the Binance secret, arbitrary destinations or redirects. Private requests require the backend token; origin checking alone is not authentication. Requests and responses are not logged by this code. Signed query strings are sent to the relay in a POST body, not the browser URL. Rotate the backend token if disclosed.

The free service can sleep/restart and has no durable storage. No unattended 24-hour trading guarantee. Exchange order reconciliation must precede any retry after an ambiguous write failure. Do not use live account credentials.

## V1.56 fee accounting and one-hour Demo experiment update

Update this folder and `demo-execution` together, then restart the Windows connector. V1.56 allows signed, Demo-only `GET /fapi/v1/userTrades` so the engine can read commissions and realized partial-close results. An older relay rejects this read; refreshing only the website does not update the running backend. It also allows the signed Demo-only `GET /fapi/v1/leverageBracket` read for the one-hour experiment. No live host or new Binance write endpoint is enabled. Authenticated desktop/mobile controls can start the experiment or restore normal entries; the deadline is persisted in the existing journal. Updating or restarting does not activate an experiment or resume stopped Auto by itself.

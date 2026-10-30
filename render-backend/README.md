# Binance Demo backend — Render Free

Deploy this directory as a Node web service. Root directory: `render-backend`. Build command: `npm test`. Start command: `npm start`. No dependencies or Binance secrets are required.

Set `RELAY_TOKEN` using Render's Generate button (at least 32 random characters). Do not commit it or paste it in chat. The health endpoint reports whether it is configured without exposing it.

After deployment, visit `/check-binance`. `ok: true` confirms only the public time endpoint works from the server. Account permissions, open orders and trade protection must still be tested before starting automation. Share only the public Render service URL, not tokens.

The existing dashboard is not yet wired to this service: its assigned URL is needed first. This backend does not autonomously trade. It relays already signed requests only to the fixed Binance Demo host. It never accepts the Binance secret, arbitrary destinations or redirects. Private requests require the backend token; origin checking alone is not authentication. Requests and responses are not logged by this code. Signed query strings are sent to the relay in a POST body, not the browser URL. Rotate the backend token if disclosed.

The free service can sleep/restart and has no durable storage. No unattended 24-hour trading guarantee. Exchange order reconciliation must precede any retry after an ambiguous write failure. Do not use live account credentials.

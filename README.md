# Unhold: an agent team that releases held PayPal money sooner

When a PayPal seller's sales jump, PayPal can hold the money for up to 21 days. Tracking uploaded to PayPal lets it release about 24 hours after delivery, but sellers rarely send it back. **Unhold** finds the held payments, explains why, matches carrier manifests to orders, asks a person to approve, uploads the tracking to PayPal, and checks that it worked.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## What is real and what is simulated

| | Status |
|---|---|
| Tracking upload (`POST /v2/checkout/orders/{id}/track`), order lookups, webhooks | **Real PayPal sandbox calls.** Four demo orders were paid by a sandbox buyer; each carries a tracker created by the app. |
| Seller hold history (106 holds, $5,235.24) | **Simulated.** The PayPal sandbox cannot create seller holds, so history is seeded and the cockpit says "Simulated seller history". Holds with no real PayPal order cannot be uploaded live. |
| Carrier tracking pages | A clearly labelled **demo carrier page**, because real carriers don't know synthetic tracking numbers. |
| Everything else (ledger, agents, approvals, search, logs) | Real, running on Supabase Postgres. |

## The agent team

A **Supervisor** runs `perceive → reason → plan → ask → (human approves) → act → verify → learn`, with three specialists:

| Agent | Job |
|---|---|
| Cash-flow | Finds matched parcels, builds the upload plan, uploads tracking |
| Payment Guard | Confirms each order is real on PayPal, checks price against the product catalog, reads trackers back after uploading |
| Buyer Assurance | Scans disputes and neutralises prompt-injection attempts in buyer messages |

Rules the code enforces: **no upload without an approval** (signed one-click links; a decision counts once); **the model explains, code decides** (the policy chooses what may be proposed, and model text is rejected if it contains a figure the tools did not return, with a deterministic fallback); every step is recorded, traced, logged and counted.

## Sponsor platforms, honestly

| Platform | Role | Where |
|---|---|---|
| **AG Grid** | Every screen of the cockpit (Enterprise: integrated charts, row grouping, master-detail, sparklines); "Ask the grid" turns plain English into grid state | `public/` |
| **Astropods** | The agent team packaged as a blueprint (`astropods.yml`, `AGENT.md`, `Dockerfile.astropods`): frontend agent, shared Postgres knowledge store, OpenTelemetry traces | repo root |
| **Zapier** | Approval requests and run results out (catch hook and Zapier MCP to Slack); carrier manifests and run triggers in (`/api/manifests/ingest`, `/api/agent/runs`) | `src/agents/`, `src/engine/` |
| **Elastic** | Semantic + keyword search over holds, audit, disputes and evidence | `src/search/elastic.ts` |
| **KERNEL** | A cloud browser reads the carrier page to confirm delivery | `src/engine/carrier_browser.ts` |
| **Channel3** | Product-graph price check on held items | `src/engine/product_lookup.ts` |
| **Bryntum** | Release timeline (Scheduler, trial package) | `public/timeline.js` |
| **Render** | Hosting; cron sweep defined in `render.yaml` | `render.yaml` |
| **Postman** | Collection in `postman_collection.json` | root |
| **APIMatic** | Orders v2 spec imported to a project; SDK generation not yet wired in | n/a |

## Production behaviour

- **Logs:** structured JSON (pino), secrets redacted, a request id on every call (`x-request-id`), warnings/errors and agent events persisted to Supabase and shown on the **Logs** screen.
- **Tracing:** OpenTelemetry spans for each run and step (`gen_ai.*` / `unhold.*` attributes) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, which Astropods injects.
- **Metrics and health:** `GET /metrics` (Prometheus), `/healthz`, `/readyz` (checks the ledger), graceful shutdown, stale-run recovery on start.
- **Safety:** unsigned PayPal webhooks are refused on a live account; approval links are signed per decision and need a POST to act.
- **Audit:** a SHA-256 hash chain of every state change, verifiable from the cockpit.

## Run it

```bash
npm install
cp .env.example .env      # fill in PayPal sandbox keys and DATABASE_URL (Supabase Postgres)
npm run build && npm start   # http://localhost:10000
npm test                  # 65 tests, hermetic: no network, no real credentials, in-memory Postgres
```

Key environment variables are listed in `.env.example`. Only `DATABASE_URL` and the PayPal sandbox credentials are required; each sponsor integration switches on when its key is set. `AG_GRID_API_KEY` is an AG Grid Enterprise + Charts trial key (the trial in this repo expires 10 Dec 2026; after that the grids keep working with an evaluation watermark).

To put real orders behind holds: `npm run seed:live -- 4` creates sandbox orders, waits while you pay them as a **US** sandbox buyer (an Indian buyer cannot pay the Indian sandbox seller), then links them to holds.

## Deploy

- **Render:** `render.yaml` (web service plus a 6-hourly sweep).
- **Astropods:** deployed (agent `unhold-agent-team`, running) with the image built by `.github/workflows/astropods-image.yml` and published to GHCR, so no local Docker is needed: `ast spec validate && ast blueprint push unhold-agent-team --no-build && ast blueprint deploy unhold-agent-team --vars-file <env file>`. Astropods puts sign-in in front of the cockpit, and OpenTelemetry traces go to its collector. Set `agent.image` in `astropods.yml` to the newly built image tag before each push.

## Known limits

- The Render deployment has no login; use the Astropods deployment (which has Astropods sign-in) for anything beyond a demo. Approval links still point at Render (`PUBLIC_BASE_URL`) so they work without an Astropods account.
- Free-tier services and the Elastic and AG Grid trials expire; see dates above.
- The "Ask the grid", reasoning and dispute-negotiation features call an LLM and fall back to rules when it is unavailable.

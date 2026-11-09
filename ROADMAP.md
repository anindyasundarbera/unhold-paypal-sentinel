# Unhold Product Build Roadmap & Execution Log

**Product:** Unhold (Autonomous Cash-Flow & Payment Protection for PayPal Sellers)  
**Active Branch:** `feat/unhold-paypal-system`  
**Current Checkpoint:** `CHK-P16-001`  
**Verified Evidence:** `EVD-044`  

---

## Step-by-Step Build Journey

### ✅ Step 1: Foundation, Local Ledger & PayPal Client (COMPLETED)
- [x] Project scaffold in `projects/unhold_paypal/` (Node 24, TypeScript, `node:sqlite`).
- [x] Canonical domain types defined in `src/types/ledger.ts` and `src/types/paypal.ts`.
- [x] SHA-256 tamper-evident cryptographic audit chain implemented in `src/audit/audit_chain.ts`.
- [x] Local SQLite Ledger database engine built in `src/db/ledger_db.ts`.
- [x] Canonical merchant dataset (106 holds totaling $5,235.24, 29 evidence items, 38 manifests) loaded via `src/seed/seeder.ts`.
- [x] Real PayPal REST Client built in `src/paypal/client.ts` with OAuth caching, `PayPal-Request-Id` idempotency, and negative testing header support.
- [x] Automated test suite passing (9/9 tests across 3 suites).
- [x] Evidence `EVD-044` stored and checkpoint `CHK-P16-001` registered in EIS State Store.

---

### ✅ Step 2: The Cash-Flow Engine (COMPLETED)
- [x] Implemented "Why Held" analyzer (`src/engine/why_held.ts`):
  - Sales surge detector (2.85x volume calculation).
  - Missing tracking penalty rule (-20 penalty).
  - Account Health Score calculation (53/100, "At risk" band).
  - Grounded diagnostic report generator citing verified transaction IDs.
- [x] Implemented Monte Carlo Release Forecasting Twin (`src/engine/monte_carlo.ts`):
  - 2,000 deterministic simulations (`mulberry32(20261109)`).
  - Transit curve modeling with holiday backlog shocks and lost scan boundaries.
  - Cash goal probability calculator (median jumps from $2,891 to $4,432+ with tracking upload).
  - Minimal action set planner ("Plan For Me") achieving >90% goal confidence.
- [x] Implemented Hold Waterfall Aggregator (`src/engine/waterfall.ts`):
  - Categorizes 106 holds into weekly release buckets (Nov 9–15, Nov 16–22, etc.).
  - Computes the $1,869.39 cash shift into earlier weeks under the expedited plan.
- [x] Automated test suite passing (14/14 tests across 4 suites).

---

### ✅ Step 2.5: Render Cloud Blueprint & Web Service Integration (COMPLETED)
- [x] Fastify Production Web Service (`src/server.ts`):
  - Preserved raw body buffer for PayPal webhook cryptographic signature verification.
  - Endpoints: `/health`, `/api/summary`, `/api/holds`, `/api/waterfall`, `/api/why-held`, `/api/cash-goal/plan`, `/api/manifests`, `/api/audit`, `POST /webhooks/paypal`.
- [x] Render Reconcile Sweep Service (`src/cron/reconcile_sweep.ts`):
  - Automated 6-hour cron sweep syncing PayPal Transaction Search API with SQLite ledger and appending signed audit blocks.
- [x] Infrastructure-as-Code Blueprint (`render.yaml` at root and in `projects/unhold_paypal/render.yaml`):
  - Web service `unhold-api` (Node runtime, Starter plan, auto-deploy, health check `/health`, persistent disk `/var/data`).
  - Cron service `unhold-reconcile-sweep` (Starter plan, schedule `0 */6 * * *`).
  - Optional managed database `unhold-postgres` (PostgreSQL 16 starter).
- [x] Production Dockerfile and `.dockerignore` for containerized deployments.
- [x] Automated test suite passing (23/23 tests across 5 suites).

---

### ✅ Step 3: AI Tracking Matcher & Batch Uploader (COMPLETED)
- [x] Multi-Tier Tracking Matcher (`src/engine/tracking_matcher.ts`):
  - Tier 1: Exact ID matching (`matched_order_id`, confidence 1.0, decision `auto`).
  - Tier 2: Deterministic Rule-Based matching (Name inversion "Last, First", capitalization, ZIP, timing within 4 days, confidence 0.98–0.99).
  - Tier 3: AI / Semantic Fuzzy matching (Nicknames e.g. "Ada" for "Adaeze", surname typos with Levenshtein $\le 2$, flat/address matches, joint names, confidence 0.82–0.93).
  - Evaluated on all 38 shipping manifests ($1,869.39 potential cash acceleration).
- [x] Batch Tracking Uploader (`src/engine/batch_uploader.ts`):
  - Calls PayPal Checkout Orders v2 track endpoint (`POST /v2/checkout/orders/{id}/track`) with `PayPal-Request-Id` idempotency header and required `capture_id`.
  - Re-dates holds in ledger dynamically from 21-day outer limit to ~24h post-delivery (`wi_date`), saving an average of 12.4 days per hold.
  - Removes the 20-point missing tracking penalty, raising Account Health Score from 53 ("At risk") to 73 ("Fair").
  - Appends SHA-256 tamper-evident audit chain blocks for every uploaded transaction.
  - Idempotency verified: re-running produces `ALREADY_UPLOADED` with zero duplicates.
- [x] REST Endpoints in `src/server.ts`:
  - `POST /api/manifests/match` — Batch matching engine with confidence scoring and reasoning.
  - `POST /api/manifests/upload` — Batch tracking uploader with dry-run and filter options.
- [x] Automated test suite passing (29/29 tests across 6 suites in 2.6s).

---

### ✅ Step 4: Buyer Assurance & A2A SD-JWT Settlement (COMPLETED)
- [x] Adversarial Prompt Injection Defense Shield (`src/engine/prompt_guard.ts`):
  - Detects `DIRECT_OVERRIDE`, `DELIMITER_INJECTION`, `JAILBREAK_PERSONA`, `AUTHORITY_IMPERSONATION`, and `ACTION_FORCING`.
  - Neutralizes fake system/role delimiter tags; calculates normalized risk scores (0.0 to 1.0) and risk levels (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).
  - Automatically suspends and escalates concessions on high/critical adversarial attacks to prevent unauthorized payouts.
- [x] RFC 9901 Selective Disclosure JWT (SD-JWT) Engine (`src/engine/sdjwt.ts`):
  - WebCrypto ECDSA P-256 (`ES256`) and SHA-256 implementation with 128-bit cryptographically secure random salting.
  - Generates verifiable delivery credentials with selective disclosure digests for PII (`recipient_name`, `delivery_street_address`, `postal_code`, `gps_coordinates`).
  - Cryptographically verifies ES256 issuer signature and disclosure digests with tampering detection.
- [x] Autonomous Agent-to-Agent (A2A) Negotiation Protocol (`src/engine/a2a_negotiator.ts`):
  - 4-turn autonomous negotiation state machine (`OPENED -> EVIDENCE_PRESENTED -> COUNTER_OFFERED -> SETTLED`).
  - Verifies carrier delivery proof, presents SD-JWT credential to Buyer Agent, and issues courtesy future discount voucher for amicable dispute withdrawal.
  - Updates dispute status in ledger and appends SHA-256 tamper-evident audit blocks.
- [x] REST Endpoints in `src/server.ts`:
  - `GET /api/disputes` — List all open/resolved disputes.
  - `POST /api/disputes/ingest` — Ingest dispute payload.
  - `POST /api/disputes/:id/negotiate` — Run autonomous A2A dispute settlement.
  - `POST /api/prompt-guard/check` — Standalone prompt injection audit probe.
  - `POST /api/sdjwt/issue` and `POST /api/sdjwt/verify` — Issue and verify RFC 9901 SD-JWTs.
  - Webhook handler enhanced for live `CUSTOMER.DISPUTE.CREATED` events.
- [x] Automated test suite passing (40/40 tests across 11 suites in 3.16s).

---

### ⏳ Step 5: Payment Guard (Anti-Scam & Pre-Flight) (NEXT)
- [ ] Email parser extracting transaction IDs and amounts from payment notices.
- [ ] PayPal live capture check (`GET /v2/payments/captures/{id}`); 404 block & phishing report.
- [ ] Pre-flight Seller Protection auditor ($750 signature threshold, address match).

---

### ⏳ Step 6: Render Cloud Deployment & Blueprint
- [ ] Create `render.yaml` Blueprint (Web Service + Managed PostgreSQL + Cron Workflow).
- [ ] Expose public HTTPS webhook listener (`POST /webhooks/paypal`).
- [ ] Dual-dialect DB adapter (SQLite for local offline runs, PostgreSQL on Render).

---

### ⏳ Step 7: AG Grid & AG Studio Cockpit UI
- [ ] Mount AG Grid React dashboard.
- [ ] Custom timeline cell renderer (start date, today, 21-day boundary, expedited release).
- [ ] Embed AG Studio Hold Waterfall and Cash Range widgets.
- [ ] Interactive audit chain verification drawer.

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

### ⏳ Step 4: Buyer Assurance & A2A SD-JWT Settlement (NEXT)
- [ ] Dispute webhook receiver (`CUSTOMER.DISPUTE.CREATED`).
- [ ] Prompt injection defense shield for buyer messages.
- [ ] SD-JWT (RFC 9901) ES256 delivery proof generator and verifier.
- [ ] Automated Agent-to-Agent negotiation protocol and outcome state machine.

---

### ⏳ Step 5: Payment Guard (Anti-Scam & Pre-Flight)
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

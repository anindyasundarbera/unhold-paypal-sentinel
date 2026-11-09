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

### ⏳ Step 2: The Cash-Flow Engine (NEXT)
- [ ] Implement the "Why Held" analyzer (`src/engine/why_held.ts`):
  - Sales surge detector (2.9x volume threshold).
  - Missing tracking penalty rule.
  - Reserve terms inspector.
- [ ] Implement the Monte Carlo Release Forecasting Twin (`src/engine/monte_carlo.ts`):
  - 2,000 simulated release paths based on carrier transit curves and backlog shocks.
  - Release probability calculator for seller cash goals (e.g. $4,500 by Friday).
- [ ] Implement the Hold Waterfall Aggregator (`src/engine/waterfall.ts`):
  - Categorizes held balances into weekly release buckets (Nov 9–15, Nov 16–22, etc.).
- [ ] Write unit tests for release time clamping and simulation distributions.

---

### ⏳ Step 3: AI Tracking Matcher & Batch Uploader
- [ ] Exact rule matcher (order ID match, ZIP + date rules).
- [ ] Fuzzy LLM matcher (nicknames, typos, building numbers with confidence scoring).
- [ ] Batch upload service calling PayPal `POST /v2/checkout/orders/{id}/track` with `PayPal-Request-Id`.
- [ ] Dynamic ledger update (re-dating holds from 21-day delay to ~24 hours post-delivery).

---

### ⏳ Step 4: Buyer Assurance & A2A SD-JWT Settlement
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

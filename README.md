# Unhold: Autonomous Cash-Flow & Payment Protection for PayPal Sellers

> **Unhold** is an autonomous AI agent team and FinTech observability flight deck that keeps PayPal merchants' cash moving. It continuously monitors payment holds, diagnoses why funds are withheld using PayPal’s exact accounting event codes (`T2107`/`T2108`), matches shipping manifests to unlock funds weeks sooner, blocks fake payment scams, and negotiates agent-to-agent disputes using cryptographic delivery proofs.

[![Tests](https://img.shields.io/badge/tests-65%2F65%20passing-brightgreen)](#)
[![Quality Gates](https://img.shields.io/badge/quality%20gates-G0..G8%20verified-blue)](#)
[![RFC 9901](https://img.shields.io/badge/RFC%209901-SD--JWT%20ES256-purple)](#)
[![PayPal APIs](https://img.shields.io/badge/PayPal-Orders%20v2%20%7C%20Captures%20%7C%20Disputes-003087)](#)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/anindyasundarbera/unhold-paypal-sentinel)

---

## 📖 Live Web Interfaces

- **Merchant Cockpit (`/` or `/cockpit`):** Interactive dashboard featuring local AG Grid Community 34.3.1, real-time KPI metrics, Hold Waterfall release schedule, and 1-click batch upload actions.
- **Technical & Software Documentation (`/doc` or `/docs`):** 22-section deep architecture manual covering the 7-stage loop, Monte Carlo Cash Twin math, 3-tier matcher, RFC 9901 SD-JWT, and the 3 Zapier Slack alert moments.
- **14-Slide Presentation Deck (`/deck`):** Complete slide deck preserving all reviewer notes, architectural diagrams, and FinTech mechanics.

---

## 1. System Architecture

```
   [ Merchant Shipping CSVs / Inboxes ]            [ Real PayPal Sandbox ]
                     │                                         │
                     ▼                                         ▼
   ┌───────────────────────────────────┐     ┌───────────────────────────────────┐
   │         ZAPIER (Low-Code)         │     │    RENDER CLOUD (Always-On)       │
   │  - Email ingestion (scam alerts)  │     │  - Fastify Webhook Ingest (HTTPS) │
   │  - Merchant Slack notifications   │     │  - Render Workflows (Sweeps)      │
   │  - Approval request callbacks     │     │  - Managed PostgreSQL Ledger      │
   └─────────────────┬─────────────────┘     └─────────────────┬─────────────────┘
                     │                                         │
                     ▼                                         ▼
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │                      ASTROPODS (AI Agent Runtime)                           │
   │                                                                             │
   │   ┌─────────────────────────────────────────────────────────────────────┐   │
   │   │                         SUPERVISOR AGENT                            │   │
   │   │     Orchestrates specialists, settles debates, writes briefs        │   │
   │   └───────────────┬──────────────────┬──────────────────┬───────────────┘   │
   │                   │                  │                  │                   │
   │                   ▼                  ▼                  ▼                   │
   │         ┌──────────────────┐ ┌───────────────┐ ┌──────────────────┐        │
   │         │ CASH-FLOW AGENT  │ │BUYER ASSURANCE│ │  PAYMENT GUARD   │        │
   │         │ - Hold waterfall │ │- Dispute A2A  │ │- Phishing verify │        │
   │         │ - Monte Carlo twin│ │- SD-JWT proof│ │- Pre-flight check│        │
   │         │ - Trk AI matcher │ │- Prompt shield│ │- $750+ sig rule  │        │
   │         └─────────┬────────┘ └───────┬───────┘ └────────┬─────────┘        │
   │                   │                  │                  │                   │
   │                   └──────────────────┼──────────────────┘                   │
   │                                      ▼                                      │
   │   ┌─────────────────────────────────────────────────────────────────────┐   │
   │   │                      DETERMINISTIC GUARDRAILS                       │   │
   │   │  - Math Validator: Rejects any LLM output with unverified numbers   │   │
   │   │  - Policy Engine: No money moves without human 1-click approval     │   │
   │   │  - SHA-256 Audit Chain: Tamper-evident cryptographic ledger         │   │
   │   └─────────────────────────────────────────────────────────────────────┘   │
   └──────────────────────────────────────┬──────────────────────────────────────┘
                                          │
                                          ▼
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │                    AG STUDIO & AG GRID (The Cockpit)                        │
   │  - Hold Waterfall Chart & Monte Carlo release range (AG Studio widget)      │
   │  - High-density Holds Ledger with timeline cell renderers (AG Grid)         │
   │  - AI Tracking Matcher review drawer & interactive approval actions         │
   │  - Live Cryptographic Audit Chain verifier                                  │
   └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Low-Code Sponsor Integrations

| Sponsor | Role in Unhold | Low-Code Value |
| :--- | :--- | :--- |
| **AG Grid & AG Studio** | Primary UI & Observability Cockpit | Zero custom chart coding; built-in Master-Detail rows, timeline renderers, and embeddable AI assistant. |
| **Render** | Cloud Hosting, Webhooks & Orchestration | Public HTTPS endpoint for PayPal webhooks, zero cold-starts with always-on credit, and Render Workflows for periodic sweeps. |
| **Astropods** | Agent Runtime & Guardrails | Declarative agent loops, tool allowlists, and production-level agent observability. |
| **Zapier** | External Integrations & Notifications | No-code inbox scraping for payment emails and instant Slack approval notifications. |
| **PayPal Agent Toolkit** | Official PayPal Function Calling | Pre-tested tools (`get_order`, `create_shipment_tracking`, `list_disputes`). Zero REST boilerplate. |
| **Elastic** | Grounded Docs Search (RAG) | Managed `semantic_text` hybrid search over PayPal developer guides; offline SQLite FTS5 fallback. |
| **Postman** | Sandbox Contract Prover | Declarative test collection run via Postman CLI (`newman`) to prove fixes against sandbox. |

---

## 3. Deploying to Render (Cloud Production)

Unhold is fully prepared for immediate deployment to **Render.com** (utilizing the Render Starter tier, $50 hackathon credit, or Free tier):

### Method A: 1-Click Render Blueprint Deployment (Recommended)

1. Click the **Deploy to Render** button below:  
   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/anindyasundarbera/unhold-paypal-sentinel)
2. Render will automatically parse [`render.yaml`](render.yaml) and configure:
   - **`unhold-api`**: Web Service running Fastify on port 10000 with `/health` check.
   - **`unhold-reconcile-sweep`**: Cron job running every 6 hours (`0 */6 * * *`) executing the automated ledger reconciliation sweep.
   - **`unhold-postgres`**: Managed PostgreSQL database instance (optional).
3. Under Environment Variables, input your credentials (or leave defaults for offline demonstration):
   - `PAYPAL_CLIENT_ID` & `PAYPAL_CLIENT_SECRET`: Your PayPal Sandbox credentials from [developer.paypal.com](https://developer.paypal.com/dashboard).
   - `ZAPIER_WEBHOOK_URL`: Your Zapier Catch Hook URL to receive real-time Slack cards.
   - `ASTROPODS_API_KEY`: Your Astropods AI Gateway API key.
4. Click **Apply**. Render will clone, build TypeScript, and launch the service with a public HTTPS URL (e.g. `https://unhold-api.onrender.com`).

---

### Method B: Manual Web Service Deployment on Render

If you prefer deploying a standalone Web Service (Free or Starter tier):

1. Go to your [Render Dashboard](https://dashboard.render.com/) and click **New + ➔ Web Service**.
2. Connect the public repository: `https://github.com/anindyasundarbera/unhold-paypal-sentinel`.
3. Configure the settings:
   - **Name:** `unhold-paypal-sentinel`
   - **Region:** `Oregon (US West)` or your preferred region
   - **Branch:** `main`
   - **Runtime:** `Node` (Node.js >= 22.5.0 detected via `.node-version`)
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** `Free` or `Starter`
4. Under **Advanced ➔ Health Check Path**, set:
   - `/health`
5. Under **Environment Variables**, add:
   ```env
   NODE_ENV=production
   PORT=10000
   HOST=0.0.0.0
   DATABASE_PATH=./data/unhold.db
   PAYPAL_ENVIRONMENT=sandbox
   ```
6. Click **Create Web Service**. Once deployed:
   - Dashboard: `https://<your-service>.onrender.com/`
   - Technical Docs: `https://<your-service>.onrender.com/doc`
   - 14-Slide Deck: `https://<your-service>.onrender.com/deck`
   - Health Check: `https://<your-service>.onrender.com/health`

---

## 4. Quick Start (Local Development)

```bash
# 1. Install dependencies
cd projects/unhold_paypal
npm install

# 2. Run unit, contract & Red-Team headless Chrome E2E test suite (65 tests across 15 suites)
npm test

# 3. Build project
npm run build

# 4. Start local Fastify server
npm start
# ➔ Server runs on http://localhost:10000
# ➔ Cockpit: http://localhost:10000/
# ➔ Technical Docs: http://localhost:10000/doc
# ➔ Presentation Deck: http://localhost:10000/deck
```

---

## 5. The 3 Demo Slack & Zapier Alert Moments

1. **Moment 1: Cash Acceleration Executed (`orders.tracking_accelerated`)**  
   Fires when merchant approves batch upload of 38 matched carrier tracking manifests. Dispatches to PayPal Orders v2 Track API with `PayPal-Request-Id`, accelerating $4,435.50 by 12.4 days and jumping goal confidence to 94%.
2. **Moment 2: Phishing Scam Intercepted (`payment.fraud_detected`)**  
   Fires when Payment Guard performs pre-flight verification on a spoofed confirmation email and discovers a 404 nonexistent PayPal capture ID. Halts shipment and drafts 1-click report to `phishing@paypal.com`.
3. **Moment 3: Autonomous Dispute Settled (`dispute.settled`)**  
   Fires when Buyer AI agent verifies merchant's RFC 9901 SD-JWT delivery proof signed with `ES256`. The dispute is amicably withdrawn and held funds are released without human intervention.


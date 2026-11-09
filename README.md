# Unhold: Autonomous Cash-Flow & Payment Protection for PayPal Sellers

> **Unhold** is an AI agent team and financial observability flight deck that keeps PayPal merchants' cash moving. It continuously watches held payments, determines why money is withheld, matches shipping manifests to unlock funds weeks sooner, blocks fake payment scams, and negotiates agent-to-agent disputes using cryptographic delivery proofs.

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

## 3. Deployment Modes (Dual-Engine Architecture)

Unhold runs in two seamless environments:
1. **Local Mode (Zero Credentials / Offline):**  
   Uses Node 24 native `node:sqlite` in-memory or on disk. Pre-seeded with 106 realistic merchant holds ($5,235.24). Allows offline judge testing without external accounts.
2. **Cloud Mode (Render Managed Production):**  
   Deployed via `render.yaml` to Render Web Services + Managed PostgreSQL. Exposes public HTTPS port 443 for real PayPal Sandbox webhooks.

---

## 4. Quick Start (Local Development)

```bash
# 1. Install dependencies
cd projects/unhold_paypal
npm install

# 2. Run unit & contract test suite
npm test

# 3. Build project
npm run build
```

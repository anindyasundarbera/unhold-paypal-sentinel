# Implementation Plan: Comprehensive Requirements Document for Low-Code Rebuild of Unhold Sentinel

## Goal Description

The objective is to produce an authoritative, production-grade **Software Requirements Specification (SRS) / Product Requirement Document (PRD)** detailing how the complete **Unhold: Autonomous PayPal Cash-Flow & Payment Protection Sentinel** application would be architected and rebuilt from the ground up on a **Low-Code / Declarative Multi-Agent Platform**.

The current codebase (`projects/unhold_paypal/`) proves the technical feasibility of the system using TypeScript/Fastify, native `node:sqlite`, AG Grid, Astropods declarative specifications, Zapier webhooks, and Render cloud orchestration. The target requirements document will specify how to transform these hardcoded components into a unified, modular, low-code architecture—enabling citizen developers, fintech operations teams, and partner platforms to deploy, configure, and extend autonomous financial agent teams with minimal custom coding.

---

## User Review Required

> [!IMPORTANT]
> **Scope & Deliverable Format Alignment:**
> 1. **Primary Output Target:** The requirements document will be written to `projects/unhold_paypal/docs/LOW_CODE_REBUILD_SPECIFICATION.md` (and mirrored to the web-accessible `/doc` route if desired) so it is version-controlled and immediately shareable with judges, architects, and engineering teams.
> 2. **Low-Code Abstraction Depth:** The specification will define declarative JSON/YAML schemas for agent configurations (Astropods pod spec), visual trigger workflows (Zapier/n8n webhooks), visual UI component bindings (AG Grid / AG Studio), and zero-ops deployment blueprints (Render IaC), while preserving strict deterministic guardrails for money movements and cryptographic audit trails.

> [!WARNING]
> **Preserving FinTech Safety & Determinism in a Low-Code World:**
> While orchestration and UI will be low-code, financial calculation (Monte Carlo, Waterfall, T2107/T2108 event matching) and security (Prompt Guard, SD-JWT, SHA-256 chain) **must remain deterministic blocks**, not ungrounded LLM prompts. The requirement document will strictly enforce this separation.

---

## Open Questions

> [!NOTE]
> Please review these questions and provide your preferences. We can proceed with the recommended defaults if you agree:

1. **Target Visual Orchestrator Foundation:**
   - *Option A (Recommended):* Model the rebuild around the current **Astropods Declarative Multi-Agent Pod Spec** + **Zapier Webhook Triggers** + **Render Blueprints**, representing a clean enterprise multi-agent stack.
   - *Option B:* Model the rebuild around an open-source visual workflow engine like **n8n / Flowise / Dify** with custom nodes for PayPal, SD-JWT, and AG Grid.
   - *Option C:* Hybrid specification supporting both SaaS connectors (Zapier/Astropods) and self-hosted open-source workflow runtimes.

2. **Presentation Layer in Rebuild:**
   - *Option A (Recommended):* Embeddable **AG Grid & AG Studio** low-code web component architecture (zero custom charting, declarative column definitions, master-detail sub-tables).
   - *Option B:* Retool / Appsmith style internal-tool application builder canvas.

3. **Database & Persistence Tier:**
   - *Option A (Recommended):* Dual-mode: Local embedded SQLite (`node:sqlite` / Litestream) for rapid zero-cost edge execution, with automatic promotion to managed PostgreSQL (Render Postgres) for enterprise scale.

---

## Proposed Changes

The primary deliverable will be the creation of a comprehensive, 10-section Software Requirements Specification document, accompanied by updated schemas and documentation references.

### Documentation & Specifications

#### [NEW] `projects/unhold_paypal/docs/LOW_CODE_REBUILD_SPECIFICATION.md`
A comprehensive, 1,200+ line technical specification document structured as follows:

```
1. EXECUTIVE SUMMARY & LOW-CODE PARADIGM
   1.1 The Core Problem: The PayPal Cash-Flow Black Box
   1.2 The Solution: Autonomous Multi-Agent Sentinel via Low-Code Blocks
   1.3 Low-Code Architectural Principles (Declarative, Deterministic, Composable)

2. SYSTEM ARCHITECTURE & HIGH-LEVEL TOPOLOGY
   2.1 End-to-End System Diagram (Mermaid)
   2.2 The 5 Low-Code Layers:
       - Layer 1: Ingestion & Trigger Gateway (Zapier / Webhook Catchers)
       - Layer 2: Declarative Multi-Agent Runtime (Astropods Pod Engine)
       - Layer 3: Deterministic Financial & Diagnostic Compute Blocks
       - Layer 4: Cryptographic & Adversarial Security Shield
       - Layer 5: Visual Presentation & Observability Cockpit (AG Grid/Studio)
       - Layer 6: Cloud Infrastructure & Blueprints (Render.yaml)
   2.3 Data Flow & Event Bus Architecture

3. THE 6 SPECIALIST AGENT ROLES & LOW-CODE POD SPECIFICATION
   3.1 Supervisor Agent (Goal decomposition, debate resolution, brief writing)
   3.2 Cash-Flow Strategist (Waterfall, 6-driver attribution, Monte Carlo twin)
   3.3 AI Tracking Matcher (3-tier carrier matching, fuzzy normalization)
   3.4 Payment Guard Gatekeeper (Phishing heuristics, $750 signature rule)
   3.5 Dispute Defense & A2A Negotiator (Prompt shield, RFC 9901 SD-JWT)
   3.6 Tamper-Evident Audit Officer (SHA-256 block chain maintenance)
   3.7 Complete Astropods Pod Schema (astropods.pod.schema.json & astropods.yml)

4. DETAILED FUNCTIONAL REQUIREMENTS (FR-01 to FR-12)
   - FR-01: Declarative Multi-Agent Pod Definition & Tool Allowlisting
   - FR-02: PayPal API Connector Block (Orders v2, Disputes, Reporting, Webhooks)
   - FR-03: Real-Time FinTech Ledger Rebuilder & Event Code Engine
   - FR-04: Automated Why-Held Diagnostic Synthesizer (6 Root Cause Drivers)
   - FR-05: Hold Waterfall Release Schedule Engine
   - FR-06: 2,000-Run Monte Carlo Cash Twin & Goal Planning Forecaster
   - FR-07: 3-Tier Carrier Manifest Matcher & Idempotent Batch Uploader
   - FR-08: Pre-Flight Payment Guard & Counterfeit Notice Interceptor
   - FR-09: Adversarial Prompt Injection Defense Shield (<5ms Regex + Semantic)
   - FR-10: Autonomous Agent-to-Agent (A2A) 4-Turn Settlement Protocol
   - FR-11: RFC 9901 SD-JWT Cryptographic Delivery Proof Issuance & Verification
   - FR-12: The 3 Low-Code Automation Triggers (Batch Upload, Dispute Settle, Scam Alert)

5. NON-FUNCTIONAL REQUIREMENTS (NFR-01 to NFR-08)
   - NFR-01: Performance & Compute Latency Benchmarks
   - NFR-02: Deterministic Safety & Financial Hallucination Guardrails
   - NFR-03: Security, Secret Management & Credential Masking
   - NFR-04: Scalability & Concurrency (Multi-tenant Pods)
   - NFR-05: Idempotency & Fault-Tolerance (Exponential backoff & replay)
   - NFR-06: Cryptographic Auditability (SHA-256 block chain verification)
   - NFR-07: Portability & Zero-Ops Cloud Deployment (Render Blueprint)
   - NFR-08: Accessibility & UI Performance (AG Grid 60 FPS rendering)

6. DATA ARCHITECTURE & DECLARATIVE SCHEMAS
   6.1 Entity-Relationship Diagram (ERD)
   6.2 Complete JSON Schemas:
       - Hold Record Schema
       - Carrier Manifest Schema
       - Dispute Record Schema
       - Audit Block Schema
       - Low-Code Event Trigger Payload Schema
       - Astropods Multi-Agent Pod Spec Schema

7. HUMAN-IN-THE-LOOP (HITL) & THE 4-TIER AUTONOMY LADDER
   7.1 Tier 1: Informational / Advisory Mode
   7.2 Tier 2: Human Approval Required (Interactive Slack Cards & Drawer)
   7.3 Tier 3: Autonomous within Bounded Guardrails (Policy thresholds)
   7.4 Tier 4: Fully Autonomous Sentinel Mode
   7.5 Fallback, Human Escalation & Intervention Protocols

8. LOW-CODE INTEGRATION BLUEPRINTS & CONNECTORS
   8.1 Zapier / Slack 2-Way Notification & Approval Loop
   8.2 Astropods AI Gateway & Model Routing (Gemini 2.5, Claude 3.5, OpenAI)
   8.3 Render IaC Blueprint (Web Service, Cron Sweep, Managed DB, Persistent Disk)
   8.4 Postman Declarative Contract Testing Suite

9. REBUILD EXECUTION ROADMAP & ESTIMATED MILESTONES
   - Sprint 1: Declarative Pod Engine & PayPal Connectors
   - Sprint 2: Core Compute Blocks (Ledger, Waterfall, Monte Carlo)
   - Sprint 3: Automation Loops & Carrier Matcher (Zapier + Orders v2)
   - Sprint 4: Security Shield (Prompt Guard, SD-JWT, Audit Chain)
   - Sprint 5: AG Grid Cockpit Dashboard & HITL Approval Drawer
   - Sprint 6: Cloud Blueprints, E2E Simulation & Penetration Testing

10. VERIFICATION & ACCEPTANCE CRITERIA
    - Traceability Matrix (Requirements ➔ Test Suites ➔ Evidence)
    - Automated Red-Team QA Suite Specifications
    - Compliance & Security Verification Checklist
```

---

### Low-Code Pod Schema Definition

#### [NEW] `projects/unhold_paypal/schemas/astropods_pod_spec.schema.json`
Formal JSON Schema defining the declarative configuration of an Unhold Multi-Agent Pod, validating agents, roles, model parameters, tool allowlists, memory boundaries, and external webhook triggers.

---

### Documentation Page Updates

#### [MODIFY] `projects/unhold_paypal/public/doc.html`
Add a dedicated section **"23. Low-Code Rebuild Specification & Architecture"** in the sidebar and document body, hyperlinking directly to the full specification and summarizing the low-code rebuilding blueprint for judges and architects.

---

## Verification Plan

### Automated Verification
1. **Schema Validation:**
   ```bash
   python3 -c "
   import json, jsonschema
   schema = json.load(open('projects/unhold_paypal/schemas/astropods_pod_spec.schema.json'))
   spec = json.load(open('projects/unhold_paypal/src/seed/unhold_pod_spec.json'))
   jsonschema.validate(instance=spec, schema=schema)
   print('Schema validation passed!')
   "
   ```
2. **Monorepo Quality Gates:**
   ```bash
   python3 scripts/verify_gates.py
   ```
3. **Unhold Test Suite:**
   ```bash
   cd projects/unhold_paypal && npm test
   ```

### Manual Verification
1. Review `projects/unhold_paypal/docs/LOW_CODE_REBUILD_SPECIFICATION.md` for completeness, clarity, structural rigor, and alignment with the hackathon pitch and production reality.
2. Verify that `/doc` on the local server renders the new section and navigation cleanly.
3. Verify that the low-code rebuild plan accurately captures all 6 specialist agents, 7-stage loop, and the 3 specific Zapier/Slack moments.

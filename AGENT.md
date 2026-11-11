---
description: "Unhold: an agent team that finds held PayPal money, matches tracking, and releases it sooner after a human approves."
tags:
  - paypal
  - payments
  - fintech
  - agents
  - human-in-the-loop
authors:
  - name: Unhold team
capabilities:
  - Explains why a PayPal seller's payments are held, with every figure checked by code
  - Matches carrier manifests to held orders and proposes tracking uploads
  - Verifies orders exist on PayPal and reads trackers back after uploading
  - Asks a person to approve over Slack through Zapier, then acts and verifies
  - Records every agent step, log line and decision in a tamper-evident audit chain
repository:
  type: git
  url: "https://github.com/anindyasundarbera/unhold-paypal-sentinel.git"
integrations:
  - PayPal
  - Zapier
  - Elastic
  - Supabase
  - Slack
---

# Unhold agent team

A Supervisor agent runs `perceive, reason, plan, ask, act, verify, learn` with three specialists:

| Agent | Job |
|---|---|
| **Supervisor** | Reads the situation, explains it, asks a person to approve, learns from the outcome |
| **Cash-flow** | Finds matched parcels, builds the upload plan, uploads tracking to PayPal Orders v2 |
| **Payment Guard** | Confirms each order is real on PayPal, checks product price against the catalog, reads trackers back |
| **Buyer Assurance** | Scans disputes and neutralises prompt-injection attempts in buyer messages |

## How it behaves

- **Nothing moves without a person.** Every upload needs an approval; the approval link is signed and a decision counts once.
- **The model explains, code decides.** Policy chooses what may be proposed; the model's text is rejected if it contains a figure the tools did not return.
- **Honest scope.** The sandbox cannot create seller holds, so hold history is simulated and labelled. Tracking uploads, captures and webhooks are real sandbox calls.

## Operating it

- Cockpit: the agent's web interface (AG Grid). Agent team and Logs screens show every run and step.
- Traces: each run and step is an OpenTelemetry span in the Astropods monitor.
- Logs: structured JSON; persisted warnings, errors and agent events in the Logs screen.
- Metrics: `GET /metrics` (Prometheus format). Health: `/healthz`, `/readyz`.

## Limitations

- The cockpit relies on Astropods sign-in for access control; the standalone Render deployment has no login.
- Live uploads need a real PayPal order behind the hold.

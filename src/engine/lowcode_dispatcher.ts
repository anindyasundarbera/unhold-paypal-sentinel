import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ZapierEventPayload {
  event: 'tracking.batch_uploaded' | 'dispute.settled' | 'payment.fraud_detected' | 'health.alert' | string;
  timestamp?: string;
  source?: string;
  data: Record<string, unknown>;
}

export interface ZapierDispatchResult {
  success: boolean;
  event: string;
  status?: number;
  webhook_url?: string;
  error?: string;
  dispatched_at: string;
}

export interface AstropodsSpec {
  version: string;
  pod: {
    id: string;
    name: string;
    description: string;
    runtime: string;
    port: number;
    health_check: string;
  };
  team: {
    agents: Array<{
      id: string;
      name: string;
      role: string;
      endpoint: string;
    }>;
  };
  integrations: {
    paypal: {
      environment: string;
      apis: string[];
    };
    zapier: {
      webhook_enabled: boolean;
      events: string[];
    };
    ag_grid: {
      component: string;
      license_type: string;
    };
    render: {
      blueprint: string;
      service_type: string;
    };
  };
}

/**
 * Dispatches an outbound webhook event to Zapier when configured.
 * Uses native fetch with timeout and error tolerance.
 */
export async function dispatchZapierEvent(
  payload: ZapierEventPayload,
  customWebhookUrl?: string
): Promise<ZapierDispatchResult> {
  const webhookUrl = customWebhookUrl || process.env.ZAPIER_WEBHOOK_URL;
  const timestamp = payload.timestamp || new Date().toISOString();
  const source = payload.source || 'unhold-sentinel-engine';

  if (!webhookUrl) {
    return {
      success: false,
      event: payload.event,
      error: 'ZAPIER_WEBHOOK_URL is not configured',
      dispatched_at: timestamp
    };
  }

  const bodyData = {
    event: payload.event,
    timestamp,
    source,
    data: payload.data
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Unhold-PayPal-Sentinel/1.0'
      },
      body: JSON.stringify(bodyData),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const isOk = res.ok || res.status === 200 || res.status === 201;
    return {
      success: isOk,
      event: payload.event,
      status: res.status,
      webhook_url: webhookUrl.replace(/\/hooks\/catch\/([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)/, '/hooks/catch/$1/***'),
      dispatched_at: timestamp
    };
  } catch (err) {
    return {
      success: false,
      event: payload.event,
      error: (err as Error).message,
      webhook_url: webhookUrl.replace(/\/hooks\/catch\/([a-zA-Z0-9]+)\/([a-zA-Z0-9]+)/, '/hooks/catch/$1/***'),
      dispatched_at: timestamp
    };
  }
}

/**
 * Returns the declarative Astropods Pod specification for Unhold.
 */
export function getAstropodsPodSpec(): AstropodsSpec {
  return {
    version: '1.0',
    pod: {
      id: 'unhold-paypal-sentinel',
      name: 'Unhold Autonomous Cash-Flow & Payment Protection Pod',
      description: 'Autonomous multi-agent system resolving PayPal seller holds, tracking uploads, and dispute defense',
      runtime: 'nodejs-20',
      port: Number(process.env.PORT || 10000),
      health_check: '/health'
    },
    team: {
      agents: [
        {
          id: 'agt-ledger-scribe',
          name: 'Ledger Scribe',
          role: 'Rebuilds and reconciles 106 PayPal holds using T2107/T2108 event code pairing',
          endpoint: 'GET /api/holds'
        },
        {
          id: 'agt-cashflow-strategist',
          name: 'Cash-Flow Strategist',
          role: 'Builds hold waterfall, 6-driver breakdown, and 2,000-run Monte Carlo forecaster',
          endpoint: 'GET /api/waterfall'
        },
        {
          id: 'agt-tracking-matcher',
          name: 'AI Tracking Matcher',
          role: '3-tier carrier manifest matching and idempotent PayPal tracking uploader',
          endpoint: 'POST /api/manifests/upload'
        },
        {
          id: 'agt-safe-to-ship',
          name: 'Payment Guard Gatekeeper',
          role: 'Inbound email phishing auditor and pre-flight Seller Protection verifier',
          endpoint: 'POST /api/payment-guard/verify-email'
        },
        {
          id: 'agt-dispute-negotiator',
          name: 'Dispute Defense & A2A Negotiator',
          role: 'Untrusted prompt injection defense and 4-turn RFC 9901 SD-JWT autonomous settlement',
          endpoint: 'POST /api/disputes/{id}/negotiate'
        },
        {
          id: 'agt-audit-officer',
          name: 'Tamper-Evident Audit Officer',
          role: 'Maintains SHA-256 cryptographic hash chain verifying all state transitions',
          endpoint: 'GET /api/audit'
        }
      ]
    },
    integrations: {
      paypal: {
        environment: (process.env.PAYPAL_ENVIRONMENT as string) || 'sandbox',
        apis: [
          'POST /v2/checkout/orders/{id}/track',
          'GET /v2/checkout/orders/{id}',
          'GET /v2/payments/captures/{id}',
          'GET /v1/reporting/transactions',
          'GET /v1/reporting/balances',
          'POST /v1/notifications/verify-webhook-signature'
        ]
      },
      zapier: {
        webhook_enabled: !!process.env.ZAPIER_WEBHOOK_URL,
        events: ['tracking.batch_uploaded', 'dispute.settled', 'payment.fraud_detected']
      },
      ag_grid: {
        component: 'AG Grid Community 34.3.1',
        license_type: 'enterprise-trial'
      },
      render: {
        blueprint: 'render.yaml',
        service_type: 'web'
      }
    }
  };
}

/**
 * Astropods AI Gateway proxy function.
 * Allows switching between LLM providers via OpenAI-compatible endpoints or Astropods Gateway.
 */
export async function queryAstropodsGateway(
  prompt: string,
  model = process.env.LLM_PROVIDER_MODEL || 'deepseek-v4.1-flash:1017',
  customApiKey?: string
): Promise<{ response: string; model: string; source: 'astropods_gateway' | 'local_fallback' }> {
  const apiKey = customApiKey || process.env.ASTROPODS_API_KEY || process.env.LLM_API_KEY;
  const endpoint = process.env.LLM_PROVIDER_ENDPOINT || 'https://api.astropods.io/v1';

  if (!apiKey) {
    return {
      response: `[Astropods Gateway Local Fallback] Simulated response for: "${prompt.slice(0, 60)}..."`,
      model,
      source: 'local_fallback'
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        return {
          response: content,
          model,
          source: 'astropods_gateway'
        };
      }
    }

    return {
      response: `[Astropods Gateway Response Fallback - HTTP ${res.status}] Completed query: "${prompt.slice(0, 60)}"`,
      model,
      source: 'local_fallback'
    };
  } catch (err) {
    return {
      response: `[Astropods Gateway Offline] Processed locally: "${prompt.slice(0, 60)}" (${(err as Error).message})`,
      model,
      source: 'local_fallback'
    };
  }
}

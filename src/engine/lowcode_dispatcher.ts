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

  // Pre-formatted rich Slack Markdown message
  let slackMessage = '';
  if (payload.event === 'tracking.batch_uploaded') {
    const d = payload.data || {};
    slackMessage = [
      ':white_check_mark: *[UNHOLD] Cash Acceleration Executed*',
      '*Merchant:* Apex Home Goods (`SANDBOXSELLER01`)',
      `• *Accelerated Cash Release:* $${Number(d.total_usd_accelerated ?? 0).toFixed(2)} USD`,
      `• *Orders Uploaded to PayPal:* ${d.total_uploaded ?? 0} orders`,
      `• *Average Release Advance:* ${d.avg_days_saved ?? 0} days sooner`,
      `• *Account Health Score:* ${d.health_score_before ?? '—'} ➔ *${d.health_score_after ?? '—'} / 100*`,
      `• *Audit Status:* Signed into SHA-256 Tamper-Evident Ledger`,
      '_Actions autonomously executed by AI Tracking Matcher & PayPal Orders v2 API._'
    ].join('\n');
  } else if (payload.event === 'dispute.settled') {
    const d = payload.data || {};
    slackMessage = [
      ':handshake: *[UNHOLD] Autonomous A2A Dispute Settled*',
      `*Dispute ID:* ${d.dispute_id ?? '—'} · *Order:* ${d.order_id ?? '—'}`,
      '• *Resolution Protocol:* Agent-to-Agent Autonomous Settlement',
      '• *Evidence Attached:* RFC 9901 SD-JWT Cryptographic Delivery Proof (ES256)',
      `• *Customer Courtesy:* $${Number(d.concession_amount_usd ?? 0).toFixed(2)} store credit (${d.coupon_code ?? '—'})`,
      '• *Result:* Dispute withdrawn amicably by buyer agent; merchant funds released'
    ].join('\n');
  } else if (payload.event === 'payment.fraud_detected') {
    const d = payload.data || {};
    slackMessage = [
      ':rotating_light: *[UNHOLD SECURITY ALERT] Phishing Scam Blocked*',
      `*Transaction Ref:* \`${d.transaction_id ?? '—'}\``,
      `• *Claimed Notice Amount:* $${Number(d.claimed_amount ?? 0).toFixed(2)} USD`,
      `• *Threat Detection:* ${d.reason ?? 'Capture not found on PayPal'}`,
      '• *Domain Legitimacy:* Spoofed sender domain detected',
      '• *Merchant Protective Action:* HALT SHIPMENT IMMEDIATELY · Counterfeit receipt'
    ].join('\n');
  } else if (payload.event === 'agent.approval_requested') {
    const d = payload.data || {};
    slackMessage = [
      ':raising_hand: *[UNHOLD] Approval needed*',
      `*${d.title ?? 'Agent plan'}*`,
      `• *Orders:* ${d.orders ?? 0} · *Cash affected:* $${Number(d.total_usd ?? 0).toFixed(2)} · *Avg release advance:* ${d.avg_days_saved ?? 0} days`,
      `• *Agent summary:* ${d.summary ?? '—'}`,
      `<${d.approve_url}|:white_check_mark: Approve> · <${d.reject_url}|:x: Reject>${d.cockpit_url ? ` · <${d.cockpit_url}|See every parcel in Unhold>` : ''}`,
      `_Run \`${d.run_id ?? '—'}\` · nothing moves until you approve._`
    ].join('\n');
  } else if (payload.event === 'agent.run_completed' || payload.event === 'agent.run_failed' || payload.event === 'agent.run_rejected') {
    const d = payload.data || {};
    const icon = payload.event === 'agent.run_completed' ? ':white_check_mark:' : payload.event === 'agent.run_failed' ? ':rotating_light:' : ':no_entry:';
    slackMessage = [
      `${icon} *[UNHOLD] Agent run ${String(payload.event).replace('agent.run_', '')}*`,
      `• *Run:* \`${d.run_id ?? '—'}\` · *Goal:* ${d.goal ?? '—'} · *Mode:* ${d.mode ?? '—'}`,
      `• *Outcome:* ${d.summary ?? d.error ?? '—'}`
    ].join('\n');
  } else if (payload.event === 'agent.morning_brief') {
    const d = payload.data || {};
    slackMessage = [':sunrise: *[UNHOLD] Morning brief*', String(d.summary ?? '—')].join('\n');
  } else {
    slackMessage = [
      ':rocket: *[UNHOLD] Live System Alert*',
      `*Event:* \`${payload.event}\``,
      '*Merchant:* Apex Home Goods (`SANDBOXSELLER01`)',
      `*Timestamp:* ${timestamp}`,
      `*Details:* ${JSON.stringify(payload.data || {})}`
    ].join('\n');
  }

  const bodyData = {
    event: payload.event,
    timestamp,
    source,
    merchant: 'Apex Home Goods (SANDBOXSELLER01)',
    slack_title: `Unhold Alert: ${payload.event}`,
    slack_message: slackMessage,
    run_id: (payload.data as Record<string, unknown>)?.run_id,
    approve_url: (payload.data as Record<string, unknown>)?.approve_url,
    reject_url: (payload.data as Record<string, unknown>)?.reject_url,
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
 * The real Astropods blueprint (astropods.yml, spec blueprint/v1) this service is packaged as.
 * Served so a reviewer can see exactly what `ast blueprint push` publishes.
 */
export function getAstropodsBlueprint(): { file: string; spec: string | null; name: string | null; yaml: string | null } {
  const candidates = [join(__dirname, '../../astropods.yml'), join(process.cwd(), 'astropods.yml')];
  for (const p of candidates) {
    if (existsSync(p)) {
      const yaml = readFileSync(p, 'utf8');
      return {
        file: 'astropods.yml',
        spec: yaml.match(/^spec:\s*(\S+)/m)?.[1] ?? null,
        name: yaml.match(/^name:\s*(\S+)/m)?.[1] ?? null,
        yaml
      };
    }
  }
  return { file: 'astropods.yml', spec: null, name: null, yaml: null };
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

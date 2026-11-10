/**
 * Human-in-the-loop. The agent proposes; a person approves. An approval is a database row plus signed
 * one-click links (Approve / Reject) that work from Slack, email or the cockpit. The request goes out
 * through Zapier (catch hook for Zap-built flows, and Zapier MCP for a direct Slack post).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { LedgerDB } from '../db/ledger_db.js';
import { dispatchZapierEvent } from '../engine/lowcode_dispatcher.js';
import { logger } from '../obs/log_store.js';
import type { Plan } from './policy.js';
import { postToSlack, zapierMcpConfigured } from './zapier_mcp.js';

function secret(): string {
  return process.env.APPROVAL_SECRET || process.env.INGEST_SHARED_SECRET || process.env.PAYPAL_CLIENT_SECRET || 'unhold-dev-secret';
}

export function approvalToken(id: string, decision: 'approve' | 'reject'): string {
  return createHmac('sha256', secret()).update(`${id}:${decision}`).digest('hex').slice(0, 32);
}

export function verifyApprovalToken(id: string, decision: 'approve' | 'reject', token: string): boolean {
  const expected = Buffer.from(approvalToken(id, decision));
  const got = Buffer.from(String(token || ''));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export interface ApprovalRequest {
  id: string;
  approve_url: string;
  reject_url: string;
  channels: string[];
}

export async function requestApproval(
  db: LedgerDB,
  baseUrl: string,
  run: { id: string; goal: string; mode: string },
  plan: Plan,
  summary: string
): Promise<ApprovalRequest> {
  const id = randomUUID();
  const base = baseUrl.replace(/\/+$/, '');
  const approve_url = `${base}/approve/${id}?d=approve&t=${approvalToken(id, 'approve')}`;
  const reject_url = `${base}/approve/${id}?d=reject&t=${approvalToken(id, 'reject')}`;
  const title = `Upload tracking for ${plan.items.length} parcel${plan.items.length === 1 ? '' : 's'} (${plan.mode})`;

  await db.createApproval({ id, run_id: run.id, title, payload: JSON.stringify({ plan, summary }), channel: null });
  logger.info('agent.approval.requested', { run_id: run.id, approval_id: id, orders: plan.items.length, total_usd: plan.total_usd, persist: true });

  const channels: string[] = ['cockpit'];
  const data = {
    run_id: run.id, approval_id: id, title, summary,
    orders: plan.items.length, total_usd: plan.total_usd, avg_days_saved: plan.avg_days_sooner,
    mode: plan.mode, approve_url, reject_url
  };

  const hook = await dispatchZapierEvent({ event: 'agent.approval_requested', data });
  if (hook.success) channels.push('zapier-hook');
  else logger.warn('agent.approval.zapier_hook_failed', { run_id: run.id, error: hook.error ?? `HTTP ${hook.status}`, persist: true });

  if (zapierMcpConfigured()) {
    try {
      const text = `:raising_hand: *Unhold needs your approval*\n*${title}* · $${plan.total_usd.toFixed(2)} · ~${plan.avg_days_sooner} days sooner\n${summary}\n<${approve_url}|Approve> · <${reject_url}|Reject>`;
      const r = await postToSlack(text);
      channels.push(`zapier-mcp:${r.tool}`);
    } catch (err) {
      logger.warn('agent.approval.zapier_mcp_failed', { run_id: run.id, error: (err as Error).message, persist: true });
    }
  }

  await db.setApprovalChannel(id, channels.join(','));
  return { id, approve_url, reject_url, channels };
}

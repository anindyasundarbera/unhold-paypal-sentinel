/**
 * The Unhold agent team. The Supervisor runs the loop
 *   PERCEIVE -> REASON -> PLAN -> ASK -> (human approves) -> ACT -> VERIFY -> LEARN
 * delegating to three specialists (Cash-flow, Payment Guard, Buyer Assurance). Every step is recorded
 * (RunRecorder), traced (OpenTelemetry), logged and counted. Nothing moves money-adjacent state
 * (uploading tracking) without an approved approval row.
 */
import { randomUUID } from 'node:crypto';
import type { LedgerDB } from '../db/ledger_db.js';
import { executeBatchTrackingUpload, type BatchUploadReport } from '../engine/batch_uploader.js';
import { analyzePromptInjection } from '../engine/prompt_guard.js';
import { dispatchZapierEvent } from '../engine/lowcode_dispatcher.js';
import { checkCarrierStatus, kernelConfigured } from '../engine/carrier_browser.js';
import { channel3Configured, lookupProduct } from '../engine/product_lookup.js';
import * as elastic from '../search/elastic.js';
import { logger } from '../obs/log_store.js';
import { metrics } from '../obs/metrics.js';
import { currentTraceId, withSpan } from '../obs/tracing.js';
import { RunRecorder } from './recorder.js';
import { buildPlan, evaluatePolicy, type Plan, type OrderCheck } from './policy.js';
import { reason, type ReasonFacts, type Reasoning } from './reasoner.js';
import { getCandidates, verifyOrders, verifyTrackers, type AgentContext } from './tools.js';
import { requestApproval } from './approvals.js';

export type Goal = 'unhold' | 'morning_brief';
export type Mode = 'live' | 'simulated';

const STALE_MS = 15 * 60_000;

/** Runs left "running" by a crash or deploy are marked failed so the cockpit never shows a ghost. */
export async function recoverStaleRuns(db: LedgerDB): Promise<number> {
  let n = 0;
  for (const r of await db.listRuns(50)) {
    if (r.status === 'running' && Date.now() - Date.parse(r.started_at) > STALE_MS) {
      await db.updateRun(r.id, { status: 'failed', error: 'Interrupted (process restarted).', finished_at: new Date().toISOString() });
      logger.warn('agent.run.recovered_stale', { run_id: r.id, persist: true });
      n += 1;
    }
  }
  return n;
}

export class RunConflictError extends Error {}

export async function startRun(
  ctx: AgentContext,
  opts: { goal?: Goal; mode?: Mode; trigger?: string } = {}
): Promise<{ runId: string }> {
  const goal = opts.goal ?? 'unhold';
  const mode = opts.mode ?? 'live';
  const trigger = opts.trigger ?? 'ui';

  const recent = await ctx.db.listRuns(5);
  const active = recent.find((r) => r.status === 'running' && Date.now() - Date.parse(r.started_at) < STALE_MS);
  if (active) throw new RunConflictError(`Run ${active.id} is still running.`);

  const runId = randomUUID();
  await ctx.db.createRun({ id: runId, agent: 'supervisor', goal, mode, trigger });
  logger.info('agent.run.started', { run_id: runId, goal, mode, trigger, persist: true });
  metrics.inc('unhold_agent_runs_total', { goal, status: 'started' });

  // Fire and forget: the HTTP caller polls the run. Failures are captured inside.
  void executeRun(ctx, runId, goal, mode).catch((e) => logger.error('agent.run.unhandled', { run_id: runId, error: (e as Error).message }));
  return { runId };
}

async function finish(ctx: AgentContext, runId: string, goal: string, mode: string, status: 'completed' | 'failed' | 'rejected' | 'awaiting_approval', summary: string, event?: string, error?: string) {
  await ctx.db.updateRun(runId, { status, summary, error: error ?? null, finished_at: status === 'awaiting_approval' ? null : new Date().toISOString() });
  metrics.inc('unhold_agent_runs_total', { goal, status });
  const log = status === 'failed' ? logger.error.bind(logger) : logger.info.bind(logger);
  log(`agent.run.${status}`, { run_id: runId, goal, mode, summary, error, persist: true });
  if (event) await dispatchZapierEvent({ event, data: { run_id: runId, goal, mode, summary, error } }).catch(() => undefined);
}

async function executeRun(ctx: AgentContext, runId: string, goal: Goal, mode: Mode): Promise<void> {
  const rec = new RunRecorder(ctx.db, runId);
  try {
    await withSpan('agent.run', { 'unhold.run_id': runId, 'unhold.goal': goal, 'unhold.mode': mode, 'gen_ai.agent.name': 'unhold-supervisor' }, async () => {
      const tid = currentTraceId();
      if (tid) await ctx.db.updateRun(runId, { trace_id: tid }).catch(() => undefined);

      // ---------- PERCEIVE ----------
      const summary = (await rec.step({ agent: 'cash_flow', stage: 'perceive', tool: 'ledger_summary' }, () => ctx.db.getSummary(), {
        note: (s) => `${s.open_holds_count} holds, $${s.total_withheld_usd} withheld`
      }))!;
      const candidates = (await rec.step({ agent: 'cash_flow', stage: 'perceive', tool: 'matched_parcels' }, () => getCandidates(ctx.db), {
        note: (c) => `${c.length} matched parcels`
      }))!;

      let checks: Record<string, OrderCheck> = {};
      if (mode === 'live' && goal === 'unhold') {
        const ids = candidates.filter((c) => !c.uploaded).map((c) => c.order_id);
        checks = (await rec.step({ agent: 'payment_guard', stage: 'perceive', tool: 'verify_paypal_orders', input: { orders: ids.length } }, () => verifyOrders(ctx.paypal, ids), {
          soft: true,
          note: (c) => `${Object.values(c).filter((v) => v === 'live').length} real, ${Object.values(c).filter((v) => v === 'no_paypal_order').length} seeded (no PayPal order)`
        })) ?? {};
      }

      const evidence: string[] = [];
      if (elastic.elasticConfigured()) {
        const r = await rec.step({ agent: 'supervisor', stage: 'perceive', tool: 'elastic_search', input: { q: 'held payments waiting for tracking' } }, () => elastic.search('held payments waiting for tracking', 5), {
          soft: true, note: (x) => `${x.total} matches`
        });
        evidence.push(...(r?.hits.map((h) => h.title) ?? []));
      }

      const product_flags: ReasonFacts['product_flags'] = [];
      if (channel3Configured() && goal === 'unhold') {
        const top = candidates.filter((c) => !c.uploaded).slice(0, 3);
        const holds = await ctx.db.getAllHolds();
        for (const c of top) {
          const hold = holds.find((h) => h.order_id === c.order_id);
          if (!hold) continue;
          const p = await rec.step({ agent: 'payment_guard', stage: 'perceive', tool: 'channel3_product_check', input: { item: hold.item, amount: hold.amount } }, () => lookupProduct(hold.item, hold.amount), {
            soft: true, note: (x) => (x.found ? `${x.title} · ${x.priceCheck?.verdict ?? 'no price'}` : 'no catalog match')
          });
          if (p?.priceCheck && p.priceCheck.verdict !== 'consistent') {
            product_flags.push({ order_id: c.order_id, note: `${hold.item}: ${p.priceCheck.note} (${p.priceCheck.verdict.replace('_', ' ')})` });
          }
        }
      }

      const disputes: ReasonFacts['disputes'] = [];
      const ds = await rec.step({ agent: 'buyer_assurance', stage: 'perceive', tool: 'scan_disputes' }, async () => {
        const list = await ctx.db.getAllDisputes();
        return list.map((d) => ({ dispute_id: d.dispute_id, order_id: d.order_id, injection: analyzePromptInjection(d.buyer_message).isInjected }));
      }, { soft: true, note: (l) => `${l.length} disputes, ${l.filter((d) => d.injection).length} with injection attempts` });
      disputes.push(...(ds ?? []));

      // ---------- REASON ----------
      const reasoning: Reasoning = (await rec.step(
        { agent: 'supervisor', stage: 'reason', tool: 'llm_diagnose', input: { candidates: candidates.length, mode } },
        () => reason({ summary, candidates, checks, evidence, product_flags, disputes }),
        { note: (r) => `${r.source}${r.model ? ' ' + r.model : ''}${r.guardrail ? ' · fallback: ' + r.guardrail : ''}` }
      ))!;

      if (goal === 'morning_brief') {
        const text = `${reasoning.diagnosis} ${reasoning.risks.length ? 'Watch: ' + reasoning.risks.join(' ') : ''}`.trim();
        await rec.step({ agent: 'supervisor', stage: 'learn', tool: 'zapier_morning_brief' }, () => dispatchZapierEvent({ event: 'agent.morning_brief', data: { run_id: runId, summary: text } }), { soft: true });
        await finish(ctx, runId, goal, mode, 'completed', text);
        return;
      }

      // ---------- PLAN ----------
      const plan: Plan = (await rec.step({ agent: 'cash_flow', stage: 'plan', tool: 'build_plan' }, async () => buildPlan(candidates, checks, mode, reasoning.skip), {
        note: (p) => `${p.items.length} to upload ($${p.total_usd}), ${p.excluded.length} excluded`
      }))!;
      const verdict = evaluatePolicy(plan);
      await ctx.db.updateRun(runId, { plan: JSON.stringify({ plan, reasoning, verdict }) });

      if (verdict.blocked || plan.items.length === 0) {
        await finish(ctx, runId, goal, mode, 'completed', `${reasoning.diagnosis} No upload proposed: ${verdict.blocked ?? 'nothing eligible'}`, 'agent.run_completed');
        return;
      }

      // ---------- ASK ----------
      const ask = (await rec.step({ agent: 'supervisor', stage: 'ask', tool: 'request_approval', input: { orders: plan.items.length, total_usd: plan.total_usd } }, () =>
        requestApproval(ctx.db, ctx.baseUrl, { id: runId, goal, mode }, plan, `${reasoning.diagnosis} ${reasoning.recommendation}`.trim())
      , { note: (a) => `sent via ${a.channels.join(', ')}` }))!;
      await ctx.db.appendAuditEntry({ actor: 'Supervisor agent', action: 'approval_requested', target: ask.id, result: 'pending', detail: `${plan.items.length} parcels, $${plan.total_usd}, mode ${plan.mode}`, requestId: runId });
      await finish(ctx, runId, goal, mode, 'awaiting_approval', `Waiting for approval: ${plan.items.length} parcels, $${plan.total_usd.toFixed(2)}. ${reasoning.diagnosis}`);
    });
  } catch (err) {
    await finish(ctx, runId, goal, mode, 'failed', 'The agent run failed.', 'agent.run_failed', (err as Error).message);
  }
}

/** A person decided. Approve -> ACT, VERIFY, LEARN; reject -> close the run. Idempotent: a decision counts once. */
export async function decideApproval(ctx: AgentContext, approvalId: string, decision: 'approved' | 'rejected', by: string): Promise<{ ok: boolean; reason?: string; runId?: string }> {
  const approval = await ctx.db.getApproval(approvalId);
  if (!approval) return { ok: false, reason: 'Approval not found.' };
  const decided = await ctx.db.decideApproval(approvalId, decision, by);
  if (!decided) return { ok: false, reason: `Already ${approval.status}.`, runId: approval.run_id };

  const run = (await ctx.db.getRun(approval.run_id))!;
  logger.info(`agent.approval.${decision}`, { run_id: run.id, approval_id: approvalId, by, persist: true });
  await ctx.db.appendAuditEntry({ actor: `Human (${by})`, action: `approval_${decision}`, target: approvalId, result: decision, detail: approval.title, requestId: run.id });

  if (decision === 'rejected') {
    await finish(ctx, run.id, run.goal, run.mode, 'rejected', 'A person rejected the plan. Nothing was uploaded.', 'agent.run_rejected');
    return { ok: true, runId: run.id };
  }
  await ctx.db.updateRun(run.id, { status: 'running', error: null });
  void executeApproved(ctx, run.id, run.goal as Goal, run.mode as Mode, JSON.parse(approval.payload).plan as Plan)
    .catch((e) => logger.error('agent.run.unhandled', { run_id: run.id, error: (e as Error).message }));
  return { ok: true, runId: run.id };
}

async function executeApproved(ctx: AgentContext, runId: string, goal: Goal, mode: Mode, plan: Plan): Promise<void> {
  const rec = new RunRecorder(ctx.db, runId);
  try {
    await withSpan('agent.run.act', { 'unhold.run_id': runId, 'unhold.mode': mode }, async () => {
      // ---------- ACT ----------
      const report: BatchUploadReport = (await rec.step(
        { agent: 'cash_flow', stage: 'act', tool: 'upload_tracking', input: { orders: plan.items.map((i) => i.order_id), mode } },
        () => executeBatchTrackingUpload(ctx.db, ctx.paypal, { orderIds: plan.items.map((i) => i.order_id), autoOnly: false, simulate: mode === 'simulated', quiet: true }),
        { note: (r) => `${r.total_uploaded} uploaded, ${r.total_failed} failed${mode === 'simulated' ? ' (simulated)' : ''}` }
      ))!;

      // ---------- VERIFY ----------
      const uploadedIds = new Set(report.items.filter((i) => i.status === 'UPLOADED').map((i) => i.order_id));
      const uploadedItems = plan.items.filter((i) => uploadedIds.has(i.order_id));
      let confirmed = 0;
      if (mode === 'live' && uploadedItems.length) {
        const v = await rec.step({ agent: 'payment_guard', stage: 'verify', tool: 'read_back_trackers', input: { orders: uploadedItems.length } }, () => verifyTrackers(ctx.paypal, uploadedItems), {
          soft: true, note: (x) => `${x.filter((t) => t.confirmed).length}/${x.length} trackers confirmed on PayPal`
        });
        confirmed = v?.filter((t) => t.confirmed).length ?? 0;
      }
      if (kernelConfigured() && /^https:\/\//.test(ctx.baseUrl) && uploadedItems[0]) {
        const first = uploadedItems[0];
        await rec.step({ agent: 'payment_guard', stage: 'verify', tool: 'kernel_carrier_check', input: { tracking: first.tracking_number } }, () => checkCarrierStatus(first.tracking_number, ctx.baseUrl), {
          soft: true, note: (c) => `carrier page says ${c.status}`
        });
      }

      // ---------- LEARN ----------
      const outcome = `${report.total_uploaded} uploaded, ${report.total_failed} failed${mode === 'live' ? `, ${confirmed} confirmed on PayPal` : ' (simulated)'}; $${report.total_usd_accelerated.toFixed(2)} released ~${report.avg_days_saved} days sooner.`;
      await rec.step({ agent: 'supervisor', stage: 'learn', tool: 'remember_run' }, async () => {
        await ctx.db.appendAuditEntry({ actor: 'Supervisor agent', action: 'run_completed', target: runId, result: report.total_failed ? 'partial' : 'ok', detail: outcome, requestId: runId });
        if (elastic.elasticConfigured()) await elastic.reindex(ctx.db).catch(() => undefined);
        return { outcome };
      });
      const failed = report.total_failed > 0 || (mode === 'live' && confirmed < uploadedItems.length);
      await finish(ctx, runId, goal, mode, failed ? 'failed' : 'completed', outcome, failed ? 'agent.run_failed' : 'agent.run_completed', failed ? 'Some uploads failed or could not be confirmed on PayPal.' : undefined);
    });
  } catch (err) {
    await finish(ctx, runId, goal, mode, 'failed', 'The approved run failed.', 'agent.run_failed', (err as Error).message);
  }
}

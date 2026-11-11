import './helpers/test_env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryLedger } from './helpers/memory_ledger.js';
import { seedLedger } from '../src/seed/seeder.js';
import { startRun, decideApproval, RunConflictError } from '../src/agents/supervisor.js';
import { buildPlan, evaluatePolicy, numbersAreGrounded, type Candidate } from '../src/agents/policy.js';
import { approvalToken, verifyApprovalToken } from '../src/agents/approvals.js';
import { redactValue, redactJson } from '../src/obs/redact.js';
import { createServer } from '../src/server.js';
import type { LedgerDB } from '../src/db/ledger_db.js';
import type { PayPalClient } from '../src/paypal/client.js';

const fakePayPal = { getOrder: async () => { throw new Error('404 RESOURCE_NOT_FOUND'); }, addTracking: async () => ({}) } as unknown as PayPalClient;

async function waitFor(db: LedgerDB, runId: string, statuses: string[], ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await db.getRun(runId);
    if (r && statuses.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`run ${runId} never reached ${statuses.join('/')}: ${(await db.getRun(runId))?.status}`);
}

describe('Agent team: supervisor loop with human approval', () => {
  test('perceive -> reason -> plan -> ask, then approve -> act -> verify -> learn', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const ctx = { db, paypal: fakePayPal, baseUrl: 'http://127.0.0.1:3000' };

    const { runId } = await startRun(ctx, { goal: 'unhold', mode: 'simulated', trigger: 'test' });
    const waiting = await waitFor(db, runId, ['awaiting_approval', 'failed', 'completed']);
    assert.equal(waiting.status, 'awaiting_approval', waiting.error ?? waiting.summary ?? '');

    const steps = await db.getSteps(runId);
    const stages = new Set(steps.map((s) => s.stage));
    for (const st of ['perceive', 'reason', 'plan', 'ask']) assert.ok(stages.has(st as never), `missing stage ${st}`);
    assert.ok(steps.some((s) => s.agent === 'cash_flow') && steps.some((s) => s.agent === 'supervisor') && steps.some((s) => s.agent === 'buyer_assurance'));
    assert.ok(!steps.some((s) => s.stage === 'act'), 'nothing may act before approval');

    const approvals = await db.listApprovals();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, 'pending');
    const holdsBefore = (await db.getAllHolds()).filter((h) => h.uploaded).length;
    assert.equal(holdsBefore, 0, 'no hold may be uploaded before approval');

    const d = await decideApproval(ctx, approvals[0].id, 'approved', 'test');
    assert.equal(d.ok, true);
    const done = await waitFor(db, runId, ['completed', 'failed']);
    assert.equal(done.status, 'completed', done.error ?? done.summary ?? '');

    const after = await db.getSteps(runId);
    for (const st of ['act', 'learn']) assert.ok(after.some((s) => s.stage === st), `missing stage ${st}`);
    assert.ok((await db.getAllHolds()).filter((h) => h.uploaded).length > 0, 'approved plan must update holds');
    assert.equal((await db.verifyLedgerAuditChain()).valid, true);

    // a decision counts once
    const again = await decideApproval(ctx, approvals[0].id, 'rejected', 'test');
    assert.equal(again.ok, false);
    await db.close();
  });

  test('a rejected plan changes nothing', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const ctx = { db, paypal: fakePayPal, baseUrl: 'http://127.0.0.1:3000' };
    const { runId } = await startRun(ctx, { goal: 'unhold', mode: 'simulated', trigger: 'test' });
    await waitFor(db, runId, ['awaiting_approval']);
    const [a] = await db.listApprovals();
    await decideApproval(ctx, a.id, 'rejected', 'test');
    const run = await waitFor(db, runId, ['rejected']);
    assert.equal(run.status, 'rejected');
    assert.equal((await db.getAllHolds()).filter((h) => h.uploaded).length, 0);
    await db.close();
  });

  test('live mode proposes nothing for seeded holds that have no real PayPal order', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const ctx = { db, paypal: fakePayPal, baseUrl: 'http://127.0.0.1:3000' };
    const { runId } = await startRun(ctx, { goal: 'unhold', mode: 'live', trigger: 'test' });
    const run = await waitFor(db, runId, ['completed', 'awaiting_approval', 'failed']);
    assert.equal(run.status, 'completed');
    assert.match(run.summary ?? '', /No upload proposed/);
    assert.equal((await db.listApprovals()).length, 0);
    await db.close();
  });

  test('only one run at a time', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const ctx = { db, paypal: fakePayPal, baseUrl: 'http://127.0.0.1:3000' };
    await startRun(ctx, { mode: 'simulated' });
    await assert.rejects(() => startRun(ctx, { mode: 'simulated' }), RunConflictError);
    await new Promise((r) => setTimeout(r, 1500));
    await db.close();
  });
});

describe('Guardrails and logging hygiene', () => {
  const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
    order_id: id, hold_id: 'h' + id, amount: 10, tracking_number: 'T' + id, carrier: 'UPS', confidence: 0.95, decision: 'auto', days_sooner: 12, uploaded: false, ...over
  });

  test('buildPlan applies confidence, live-order and veto rules', () => {
    const plan = buildPlan(
      [cand('a'), cand('b'), cand('c', { confidence: 0.5 }), cand('d', { uploaded: true }), cand('e')],
      { a: 'live', b: 'no_paypal_order', c: 'live', d: 'live', e: 'live' },
      'live',
      [{ order_id: 'e', reason: 'price looks wrong' }]
    );
    assert.deepEqual(plan.items.map((i) => i.order_id), ['a']);
    assert.equal(plan.excluded.length, 4);
    assert.match(plan.excluded.find((x) => x.order_id === 'e')!.reason, /veto/);
    const v = evaluatePolicy(plan);
    assert.equal(v.requiresApproval, true);
    assert.equal(v.blocked, null);
    assert.equal(evaluatePolicy(buildPlan([], {}, 'live')).blocked, 'Nothing eligible to upload.');
  });

  test('numbers in model text must come from tool output', () => {
    assert.equal(numbersAreGrounded('You hold $5,235.24 across orders', [5235.24]).ok, true);
    const bad = numbersAreGrounded('You will gain $9,999.00', [5235.24]);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.offending, ['$9,999.00']);
  });

  test('approval links are signed per decision', () => {
    const t = approvalToken('abc', 'approve');
    assert.equal(verifyApprovalToken('abc', 'approve', t), true);
    assert.equal(verifyApprovalToken('abc', 'reject', t), false);
    assert.equal(verifyApprovalToken('abd', 'approve', t), false);
    assert.equal(verifyApprovalToken('abc', 'approve', ''), false);
  });

  test('secrets never reach logs or stored steps', () => {
    const out = redactValue({ api_key: 'sk-1234567890abcdef1234', nested: { Authorization: 'Bearer x', ok: 'fine' }, long: 'A'.repeat(60) }) as Record<string, unknown>;
    assert.equal(out.api_key, '[redacted]');
    assert.equal((out.nested as Record<string, unknown>).Authorization, '[redacted]');
    assert.equal((out.nested as Record<string, unknown>).ok, 'fine');
    assert.equal(out.long, '[redacted]');
    assert.ok(!redactJson({ client_secret: 'abc' }).includes('abc'));
  });
});

describe('Production endpoints', () => {
  test('health, readiness, metrics, logs and the agent API', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const server = await createServer(db, fakePayPal);

    assert.equal((await server.inject('/healthz')).json().status, 'ok');
    const ready = await server.inject('/readyz');
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, 'ready');

    const bad = await server.inject({ method: 'POST', url: '/api/agent/approvals/nope/decision', payload: { decision: 'maybe' } });
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.headers['x-request-id'], 'every response carries a request id');

    const start = await server.inject({ method: 'POST', url: '/api/agent/runs', payload: { goal: 'unhold', mode: 'simulated' } });
    assert.equal(start.statusCode, 202);
    const runId = start.json().run_id as string;
    await waitFor(db, runId, ['awaiting_approval']);

    const detail = (await server.inject(`/api/agent/runs/${runId}`)).json();
    assert.equal(detail.run.status, 'awaiting_approval');
    assert.ok(detail.steps.length >= 6);
    assert.equal(detail.approvals.length, 1);

    // signed link: GET confirms, a wrong token is refused
    const approval = (await db.listApprovals())[0];
    const good = await server.inject(`/approve/${approval.id}?d=approve&t=${approvalToken(approval.id, 'approve')}`);
    assert.equal(good.statusCode, 200);
    assert.match(good.body, /Confirm approve/);
    assert.equal((await server.inject(`/approve/${approval.id}?d=approve&t=wrong`)).statusCode, 403);
    assert.equal((await db.getApproval(approval.id))!.status, 'pending', 'a GET must never decide');

    const metrics = (await server.inject('/metrics')).body;
    assert.match(metrics, /unhold_http_requests_total/);
    assert.match(metrics, /unhold_agent_runs_total/);

    await server.close();
    await db.close();
  });
});

describe('Ledger connection TLS', () => {
  test('TLS stays on for hosted databases and is off for in-cluster/local ones', async () => {
    const { LedgerDB } = await import('../src/db/ledger_db.js');
    assert.deepEqual(LedgerDB.sslFor('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres'), { rejectUnauthorized: false });
    assert.equal(LedgerDB.sslFor('postgresql://u:p@unhold-agent-team-knowledge-ledger.astro-x.svc.cluster.local:5432/db'), false);
    assert.equal(LedgerDB.sslFor('postgresql://u:p@localhost:5432/db'), false);
  });
});

describe('Cockpit safeguards', () => {
  test('holds say whether a real PayPal order is behind them', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const server = await createServer(db, fakePayPal);
    const { holds } = (await server.inject('/api/holds')).json();
    const uploadable = holds.filter((h: { status: string; tracking_number?: string }) => h.status === 'seller_has' && h.tracking_number);
    assert.ok(uploadable.length > 0);
    assert.ok(uploadable.every((h: { paypal_order: string }) => h.paypal_order === 'demo'), 'seeded holds have no PayPal order');
    assert.ok(holds.filter((h: { status: string }) => h.status === 'not_shipped').every((h: { paypal_order: string }) => h.paypal_order === 'unknown'));
    await server.close();
    await db.close();
  });

  test('with an access code set, changes need it and reading stays open', async () => {
    process.env.COCKPIT_ACCESS_CODE = 'test-code-123';
    try {
      const db = await memoryLedger();
      await seedLedger(db);
      const server = await createServer(db, fakePayPal);
      assert.equal((await server.inject('/api/summary')).statusCode, 200);
      assert.equal((await server.inject('/api/config')).json().accessCodeRequired, true);
      const verify = await server.inject({ method: 'POST', url: '/api/audit/verify' });
      assert.equal(verify.statusCode, 200, 'verifying the audit chain is read-only and must not ask for the code');

      const blocked = await server.inject({ method: 'POST', url: '/api/manifests/upload', payload: { orderIds: [] } });
      assert.equal(blocked.statusCode, 401);
      assert.equal(blocked.json().error, 'access_code_required');
      const wrong = await server.inject({ method: 'POST', url: '/api/agent/runs', headers: { 'x-unhold-access': 'nope' }, payload: { mode: 'simulated' } });
      assert.equal(wrong.statusCode, 401);
      assert.equal((await db.listRuns()).length, 0, 'a refused call must not start a run');

      const allowed = await server.inject({ method: 'POST', url: '/api/agent/approvals/none/decision', headers: { 'x-unhold-access': 'test-code-123' }, payload: { decision: 'maybe' } });
      assert.equal(allowed.statusCode, 400, 'passes the gate and reaches normal validation');
      await server.close();
      await db.close();
    } finally {
      delete process.env.COCKPIT_ACCESS_CODE;
    }
  });
});

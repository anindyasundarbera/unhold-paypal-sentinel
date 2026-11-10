import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { LedgerDB } from '../src/db/ledger_db.js';
import type { FastifyInstance } from 'fastify';

describe('Render Fastify Web Service Endpoints', async () => {
  let server: FastifyInstance;
  let db: LedgerDB;

  before(async () => {
    process.env.NODE_ENV = 'test';
    db = await LedgerDB.memory();
    server = await createServer(db);
  });

  after(async () => {
    await server.close();
    await db.close();
  });

  test('GET /health returns 200 with service identification', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health'
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'unhold-api');
    assert.ok(body.timestamp);
  });

  test('GET /api/summary returns hold statistics and totals', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/summary'
    });

    assert.equal(res.statusCode, 200);
    const summary = JSON.parse(res.body);
    assert.equal(summary.open_holds_count, 106);
    assert.equal(summary.total_withheld_usd, 5235.24);
    assert.equal(summary.speedable_holds_count, 38);
    assert.equal(summary.speedable_amount_usd, 1869.39);
    assert.equal(summary.health_score, 53);
  });

  test('GET /api/holds returns seeded holds array with filtering', async () => {
    const allRes = await server.inject({
      method: 'GET',
      url: '/api/holds'
    });
    assert.equal(allRes.statusCode, 200);
    const allData = JSON.parse(allRes.body);
    assert.equal(allData.holds.length, 106);

    const speedableRes = await server.inject({
      method: 'GET',
      url: '/api/holds?status=seller_has'
    });
    assert.equal(speedableRes.statusCode, 200);
    const speedableData = JSON.parse(speedableRes.body);
    assert.equal(speedableData.holds.length, 42);
  });

  test('GET /api/waterfall generates release schedule buckets', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/waterfall?asOf=2026-11-09T18:00:00Z'
    });

    assert.equal(res.statusCode, 200);
    const waterfall = JSON.parse(res.body);
    assert.equal(waterfall.totalHeldUsd, 5235.24);
    assert.equal(waterfall.shiftedAmountUsd, 1869.39);
    assert.ok(Array.isArray(waterfall.currentBuckets));
    assert.ok(Array.isArray(waterfall.expeditedBuckets));
  });

  test('GET /api/why-held produces diagnostic explanation', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/why-held'
    });

    assert.equal(res.statusCode, 200);
    const report = JSON.parse(res.body);
    assert.equal(report.health.score, 53);
    assert.ok(report.plain_english_explanation.includes('5,235.24'));
    assert.ok(report.drivers.length >= 2);
    assert.equal(report.health.components.length, 3);
  });

  test('POST /api/cash-goal/plan optimizes action roadmap', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/cash-goal/plan',
      payload: {
        goalAmount: 4500,
        goalDay: 11,
        confidence: 0.8
      }
    });

    assert.equal(res.statusCode, 200);
    const plan = JSON.parse(res.body);
    assert.equal(plan.goalAmount, 4500);
    assert.ok(plan.selectedActions.length >= 1);
    assert.ok(plan.plannedProb > plan.baselineProb);
  });

  test('GET /api/manifests returns synthesized shipping manifests', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/manifests'
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.manifests.length, 38);
  });

  test('GET /api/audit returns tamper-evident chain with passing verification', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/audit'
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.chain));
    assert.ok(data.chain.length > 0);
    assert.equal(data.verification.valid, true);
  });

  test('POST /webhooks/paypal records real webhook event into audit chain', async () => {
    const webhookPayload = {
      id: 'WH-EVT-TEST-001',
      create_time: '2026-11-09T22:00:00Z',
      resource_type: 'capture',
      event_type: 'PAYMENT.CAPTURE.PENDING',
      summary: 'Payment capture is pending review',
      resource: {
        id: 'CAP-TEST-999',
        amount: {
          currency_code: 'USD',
          value: '149.99'
        },
        status: 'PENDING',
        status_details: {
          reason: 'PENDING_REVIEW'
        }
      }
    };

    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/paypal',
      headers: {
        'content-type': 'application/json'
      },
      payload: webhookPayload
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'SUCCESS');
    assert.equal(body.event_id, 'WH-EVT-TEST-001');
    assert.equal(body.event_type, 'PAYMENT.CAPTURE.PENDING');
    assert.ok(body.audit_block_id);
    assert.ok(body.audit_hash);

    // Verify audit chain integrity after webhook receipt
    const verifyRes = await server.inject({
      method: 'GET',
      url: '/api/audit'
    });
    const verifyData = JSON.parse(verifyRes.body);
    assert.equal(verifyData.verification.valid, true);

    // Check that the last entry matches the webhook event
    const lastEntry = verifyData.chain[verifyData.chain.length - 1];
    assert.equal(lastEntry.actor, 'PayPal Webhook Gateway');
    assert.equal(lastEntry.action, 'PAYMENT.CAPTURE.PENDING');
    assert.equal(lastEntry.target, 'WH-EVT-TEST-001');
  });
});

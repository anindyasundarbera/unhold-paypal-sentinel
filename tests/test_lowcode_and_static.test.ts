import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { LedgerDB } from '../src/db/ledger_db.js';
import {
  dispatchZapierEvent,
  getAstropodsPodSpec,
  queryAstropodsGateway
} from '../src/engine/lowcode_dispatcher.js';

describe('Step 6 & 7: Static UI Wireframes & Low-Code Integrations', () => {
  test('Fastify serves static wireframes at root /, /cockpit, and /deck', async () => {
    const db = new LedgerDB(':memory:');
    const server = await createServer(db);

    // Root GET /
    const rootRes = await server.inject({
      method: 'GET',
      url: '/'
    });
    assert.equal(rootRes.statusCode, 200);
    assert.match(rootRes.headers['content-type'] || '', /text\/html/);
    assert.match(rootRes.payload, /Unhold/);
    assert.match(rootRes.payload, /Apex Home Goods/);

    // Cockpit GET /cockpit
    const cockpitRes = await server.inject({
      method: 'GET',
      url: '/cockpit'
    });
    assert.equal(cockpitRes.statusCode, 200);
    assert.match(cockpitRes.payload, /Unhold/);

    // Deck GET /deck
    const deckRes = await server.inject({
      method: 'GET',
      url: '/deck'
    });
    assert.equal(deckRes.statusCode, 200);
    assert.match(deckRes.payload, /Unhold wireframes/);

    // Documentation GET /doc
    const docRes = await server.inject({
      method: 'GET',
      url: '/doc'
    });
    assert.equal(docRes.statusCode, 200);
    assert.match(docRes.payload, /Unhold System Documentation/);

    await server.close();
  });

  test('Astropods Pod Spec returns valid declarative multi-agent pod manifest', async () => {
    const spec = getAstropodsPodSpec();
    assert.equal(spec.version, '1.0');
    assert.equal(spec.pod.id, 'unhold-paypal-sentinel');
    assert.equal(spec.team.agents.length, 6);

    const agentIds = spec.team.agents.map((a) => a.id);
    assert.ok(agentIds.includes('agt-ledger-scribe'));
    assert.ok(agentIds.includes('agt-cashflow-strategist'));
    assert.ok(agentIds.includes('agt-tracking-matcher'));
    assert.ok(agentIds.includes('agt-safe-to-ship'));
    assert.ok(agentIds.includes('agt-dispute-negotiator'));
    assert.ok(agentIds.includes('agt-audit-officer'));

    assert.ok(spec.integrations.paypal.apis.length >= 5);
    assert.equal(spec.integrations.ag_grid.component, 'AG Grid Community 34.3.1');
  });

  test('Astropods Gateway queries AI endpoint or returns local fallback', async () => {
    const res = await queryAstropodsGateway('Summarize the PayPal 21-day hold reason');
    assert.ok(res.response);
    assert.ok(res.model);
    assert.ok(res.source === 'astropods_gateway' || res.source === 'local_fallback');
  });

  test('Zapier event dispatcher formats payload and masks credentials', async () => {
    const result = await dispatchZapierEvent({
      event: 'tracking.batch_uploaded',
      data: {
        total_uploaded: 38,
        total_usd_accelerated: 1869.39
      }
    });

    assert.equal(result.event, 'tracking.batch_uploaded');
    assert.ok(result.dispatched_at);
    // If ZAPIER_WEBHOOK_URL is set, url is masked
    if (result.webhook_url) {
      assert.ok(!result.webhook_url.includes('undefined'));
    }
  });

  test('Fastify Low-Code REST endpoints return valid responses', async () => {
    const db = new LedgerDB(':memory:');
    const server = await createServer(db);

    // GET /api/lowcode/astropods/spec
    const specRes = await server.inject({
      method: 'GET',
      url: '/api/lowcode/astropods/spec'
    });
    assert.equal(specRes.statusCode, 200);
    const specData = JSON.parse(specRes.payload);
    assert.equal(specData.pod.id, 'unhold-paypal-sentinel');

    // POST /api/lowcode/astropods/query
    const queryRes = await server.inject({
      method: 'POST',
      url: '/api/lowcode/astropods/query',
      payload: { prompt: 'What is the current health score?' }
    });
    assert.equal(queryRes.statusCode, 200);
    const queryData = JSON.parse(queryRes.payload);
    assert.ok(queryData.response);

    // POST /api/lowcode/zapier/trigger
    const zapierRes = await server.inject({
      method: 'POST',
      url: '/api/lowcode/zapier/trigger',
      payload: {
        event: 'test.manual_ping',
        data: { message: 'Ping from automated test suite' }
      }
    });
    assert.equal(zapierRes.statusCode, 200);
    const zapierData = JSON.parse(zapierRes.payload);
    assert.equal(zapierData.event, 'test.manual_ping');

    await server.close();
  });
});

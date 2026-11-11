import './helpers/test_env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryLedger } from './helpers/memory_ledger.js';
import { seedLedger } from '../src/seed/seeder.js';
import { createServer } from '../src/server.js';
import { buildInbox, type InboxInput } from '../src/engine/inbox.js';
import type { PayPalClient } from '../src/paypal/client.js';
import type { HoldRecord } from '../src/types/ledger.js';

const fakePayPal = { getOrder: async () => { throw new Error('404 RESOURCE_NOT_FOUND'); }, addTracking: async () => ({}) } as unknown as PayPalClient;
const NOW = new Date('2026-11-11T12:00:00Z');
const hold = (over: Partial<HoldRecord>): HoldRecord => ({
  id: 'H1', txn_id: 'T1', order_id: 'O1', code: 'T2107', kind: 'PAYMENT_HOLD', amount: 50, held_at: '2026-11-01T00:00:00Z', exp_at: '2026-11-22T00:00:00Z',
  conf: 'HIGH', rule: 'no_tracking', action: null, reason: '', status: 'seller_has', carrier: 'UPS', tracking_number: 'TRK1', shipped_at: null, delivered_at: null,
  wi_date: '2026-11-12T00:00:00Z', buyer: 'A. Buyer', item: 'Lamp', uploaded: false, ...over
} as HoldRecord);
const base = (over: Partial<InboxInput> = {}): InboxInput => ({
  holds: [], matches: [], approvals: [], disputes: [], runs: [], audit: [], chainValid: true,
  summary: { total_withheld_usd: 0, open_holds_count: 0, health_score: 90, health_band: 'Healthy', avg_days_sooner: 12 },
  connections: [{ name: 'PayPal', ok: true, role: 'Orders' }], now: NOW, ...over
});

describe('Work queues by role', () => {
  test('a quiet account gives every role an empty to-do list and healthy checks', () => {
    const { items, roles } = buildInbox(base());
    assert.equal(items.filter((i) => i.state === 'todo').length, 0);
    assert.equal(roles.owner.headline, 'Nothing needs a decision');
    assert.equal(roles.fulfilment.primary, null);
    assert.equal(roles.support.primary?.tab, 'guard');
    assert.equal(roles.admin.headline, 'Everything is running');
    assert.ok(items.some((i) => i.role === 'admin' && i.state === 'ok' && /chain intact/.test(i.title)));
  });

  test('each kind of work lands with the role that handles it', () => {
    const holds = [
      hold({}),
      hold({ id: 'H2', order_id: 'O2', tracking_number: 'TRK2', amount: 30 }),
      hold({ id: 'H3', order_id: 'O3', tracking_number: 'TRK3', uploaded: true, status: 'in_paypal' }),
      hold({ id: 'H4', order_id: 'O4', status: 'not_shipped', tracking_number: null as never, wi_date: null as never, amount: 20 }),
      hold({ id: 'H5', order_id: 'O5', status: 'unapproved' })
    ];
    const m = (trk: string, order: string | null, confidence: number) => ({
      tracking_number: trk, carrier: 'UPS', matched_hold_id: null, matched_order_id: order, confidence,
      match_method: 'rule' as const, match_reason: 'why', decision: 'auto' as const, hold_amount: 0, days_sooner: 10
    });
    const { items, roles } = buildInbox(base({
      holds,
      matches: [m('TRK1', 'O1', 0.95), m('TRK2', 'O2', 0.6), m('TRK3', 'O3', 1), m('TRK9', null, 0)],
      approvals: [
        { id: 'A1', title: 'Upload tracking for 2 parcels', status: 'pending', requested_at: '2026-11-09T00:00:00Z', orders: 2, total_usd: 80, mode: 'live' },
        { id: 'A0', title: 'Old', status: 'rejected', requested_at: '2026-11-01T00:00:00Z', orders: 1, total_usd: 5 }
      ],
      disputes: [
        { dispute_id: 'D1', order_id: 'O1', capture_id: 'C1', amount: 40, currency: 'USD', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'ITEM_NOT_RECEIVED', buyer_message: 'Where is it?', respond_by: '2026-11-20T00:00:00Z', created_at: '2026-11-10T00:00:00Z' },
        { dispute_id: 'D2', order_id: 'O2', capture_id: 'C2', amount: 10, currency: 'USD', status: 'RESOLVED', reason: 'X', buyer_message: '', respond_by: '2026-11-20T00:00:00Z', created_at: '2026-11-10T00:00:00Z' }
      ],
      runs: [
        { id: 'R1', status: 'failed', goal: 'unhold', started_at: '2026-11-10T00:00:00Z', finished_at: null, summary: null, error: 'boom' },
        { id: 'R0', status: 'failed', goal: 'unhold', started_at: '2026-10-01T00:00:00Z', finished_at: null, summary: null, error: 'old' }
      ],
      audit: [{ block_id: 7, timestamp: '2026-11-10T00:00:00Z', actor: 'Batch Tracking Uploader', action: 'POST /v2/checkout/orders/{id}/track', target: 'O9', result: 'error', detail: '404', prev_hash: '', hash: '' }],
      chainValid: false,
      summary: { total_withheld_usd: 150, open_holds_count: 5, health_score: 53, health_band: 'At risk', avg_days_sooner: 12 },
      connections: [{ name: 'PayPal', ok: true, role: 'Orders' }, { name: 'Elastic', ok: false, role: 'Search' }]
    }));
    const kinds = (role: string) => items.filter((i) => i.role === role).map((i) => i.kind).sort();

    assert.deepEqual(kinds('fulfilment'), ['failed_upload', 'not_shipped', 'ready', 'review', 'unmatched']);
    assert.ok(!items.some((i) => i.id === 'parcel:TRK3'), 'an uploaded parcel is not work');
    assert.deepEqual(kinds('owner'), ['decision', 'health', 'opportunity']);
    assert.equal(items.find((i) => i.kind === 'opportunity')!.amount, 80);
    assert.deepEqual(kinds('support'), ['dispute', 'payment_review']);
    assert.deepEqual(kinds('admin'), ['chain', 'connection', 'error', 'failed_run', 'stale']);

    assert.equal(roles.owner.headline, '1 plan waiting for your decision');
    assert.deepEqual(roles.owner.primary, { label: 'Review plan', tab: 'agents' });
    assert.match(roles.fulfilment.headline, /^2 parcels to upload/);
    assert.equal(roles.support.headline, '1 dispute to answer');
    assert.equal(roles.admin.todo, 5);
    assert.match(roles.admin.sub, /1\/2 services connected · audit chain broken/);
  });

  test('GET /api/inbox answers for the seeded ledger', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const server = await createServer(db, fakePayPal);
    const res = await server.inject('/api/inbox');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body.roles).sort(), ['admin', 'fulfilment', 'owner', 'support']);
    assert.ok(body.items.some((i: { kind: string }) => i.kind === 'ready'), 'the seed has parcels ready to upload');
    assert.ok(body.roles.fulfilment.todo > 0);
    assert.ok(Array.isArray(body.connections));
    await server.close();
    await db.close();
  });
});

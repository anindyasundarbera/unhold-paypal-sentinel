import './helpers/test_env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryLedger } from './helpers/memory_ledger.js';
import { seedLedger } from '../src/seed/seeder.js';
import { parseIngestPayload, ingestManifests } from '../src/engine/manifest_ingest.js';

describe('Manifest ingest (Zapier inbound)', () => {
  test('parses a flat Zapier object, a CSV and an array; rejects bad rows', () => {
    const flat = parseIngestPayload({ tracking: '1Z 999 AA1', courier: 'ups', name: 'A B', zip: '94105' });
    assert.equal(flat.rows.length, 1);
    assert.equal(flat.rows[0].tracking_number, '1Z999AA1');
    assert.equal(flat.rows[0].carrier, 'UPS');

    const csv = parseIngestPayload({ csv: 'tracking_number,carrier,zip\nT1,fedex,10001\nT2,dhl,20002' });
    assert.equal(csv.rows.length, 2);
    assert.equal(csv.rows[0].carrier, 'FedEx');

    const bad = parseIngestPayload([{ tracking_number: 'X', carrier: 'pigeon' }, { carrier: 'ups' }]);
    assert.equal(bad.rows.length, 0);
    assert.equal(bad.rejected.length, 2);
  });

  test('stores, matches by order id, persists and audits', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const target = (await db.getAllHolds()).find((h) => h.status === 'not_shipped')!;
    const report = await ingestManifests(db, { rows: [{ tracking_number: 'ZAP-TEST-001', carrier: 'UPS', order_id: target.order_id }] });
    assert.equal(report.stored, 1);
    assert.equal(report.matched, 1);
    const saved = await db.getManifest('ZAP-TEST-001');
    assert.equal(saved?.matched_order_id, target.order_id);
    const chain = await db.getAuditChain();
    assert.equal(chain[chain.length - 1].action, 'POST /api/manifests/ingest');
    assert.equal((await db.verifyLedgerAuditChain()).valid, true);
    await db.close();
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerDB } from '../src/db/ledger_db.js';
import { seedLedger } from '../src/seed/seeder.js';

describe('Unhold SQLite Ledger & Seeder', () => {
  test('initializes and seeds 106 holds accurately', () => {
    const db = new LedgerDB(':memory:');
    const counts = seedLedger(db);

    assert.equal(counts.holdsCount, 106);
    assert.equal(counts.evidenceCount, 29);
    assert.equal(counts.manifestsCount, 38);

    const summary = db.getSummary();
    assert.equal(summary.open_holds_count, 106);
    assert.equal(summary.total_withheld_usd, 5235.24);
    assert.equal(summary.speedable_holds_count, 38);
    assert.equal(summary.speedable_amount_usd, 1869.39);
    assert.equal(summary.health_score, 53);
    assert.equal(summary.health_band, 'At risk');

    db.close();
  });

  test('retrieves speedable holds and updates tracking status', () => {
    const db = new LedgerDB(':memory:');
    seedLedger(db);

    const speedable = db.getSpeedableHolds();
    assert.equal(speedable.length, 38);

    const targetHold = speedable[0];
    assert.equal(targetHold.status, 'seller_has');
    assert.equal(targetHold.uploaded, false);

    // Update tracking
    const updated = db.updateHoldTracking(
      targetHold.id,
      '1Z9999999999999999',
      'UPS',
      true
    );
    assert.equal(updated, true);

    const refreshedHolds = db.getAllHolds();
    const refreshedTarget = refreshedHolds.find((h) => h.id === targetHold.id);
    assert.ok(refreshedTarget);
    assert.equal(refreshedTarget.status, 'in_paypal');
    assert.equal(refreshedTarget.uploaded, true);
    assert.equal(refreshedTarget.tracking_number, '1Z9999999999999999');

    // Remaining speedable holds should now be 37
    const remainingSpeedable = db.getSpeedableHolds();
    assert.equal(remainingSpeedable.length, 37);

    db.close();
  });

  test('verifies initial ledger audit chain integrity', () => {
    const db = new LedgerDB(':memory:');
    seedLedger(db);

    const auditChain = db.getAuditChain();
    assert.equal(auditChain.length, 3);

    const verification = db.verifyLedgerAuditChain();
    assert.equal(verification.valid, true);

    db.close();
  });
});

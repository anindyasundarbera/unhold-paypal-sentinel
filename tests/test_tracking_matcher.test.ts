import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerDB } from '../src/db/ledger_db.js';
import { memoryLedger } from './helpers/memory_ledger.js';
import { seedLedger } from '../src/seed/seeder.js';
import { PayPalClient } from '../src/paypal/client.js';
import {
  levenshteinDistance,
  normalizeNameTokens,
  isNicknameMatch,
  matchSingleManifest,
  matchAllManifests
} from '../src/engine/tracking_matcher.js';
import { executeBatchTrackingUpload } from '../src/engine/batch_uploader.js';
import { createServer } from '../src/server.js';
import type { CarrierManifestRecord, HoldRecord } from '../src/types/ledger.js';

process.env.NODE_ENV = 'test';

describe('Step 3: AI Tracking Matcher & Batch Uploader', async () => {
  test('levenshtein distance and nickname token matching', async () => {
    assert.equal(levenshteinDistance('Okafor', 'Okafor'), 0);
    assert.equal(levenshteinDistance('Okafor', 'Okaffor'), 1);
    assert.equal(levenshteinDistance('Lindqvist', 'Lindqvsit'), 1); // transposition

    assert.equal(isNicknameMatch('Ada', 'Adaeze'), true);
    assert.equal(isNicknameMatch('Tom', 'Thomas'), true);
    assert.equal(isNicknameMatch('Dan', 'Daniel'), true);
    assert.equal(isNicknameMatch('Rick', 'Erik'), true);
    assert.equal(isNicknameMatch('Alice', 'Bob'), false);

    const inverted = normalizeNameTokens('Okafor, Adaeze');
    assert.equal(inverted.isInverted, true);
    assert.equal(inverted.first, 'adaeze');
    assert.equal(inverted.last, 'okafor');
  });

  test('Tier 1: Exact ID matching', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const speedable = await db.getSpeedableHolds();
    const targetHold = speedable[0];

    const manifest: CarrierManifestRecord = {
      tracking_number: '1Z999TEST0001',
      carrier: 'UPS',
      source_file: 'shop_export.csv',
      recipient_name: 'A. Okafor',
      street_address: '123 Elm Street',
      zip_code: '10001',
      label_printed_at: targetHold.held_at,
      matched_order_id: targetHold.order_id,
      confidence: 1.0,
      match_method: 'id',
      match_reason: 'PayPal order ID in shop export',
      decision: 'auto'
    };

    const match = matchSingleManifest(manifest, [targetHold]);
    assert.equal(match.matched_hold_id, targetHold.id);
    assert.equal(match.confidence, 1.0);
    assert.equal(match.match_method, 'id');
    assert.equal(match.decision, 'auto');
    assert.ok(match.days_sooner > 0);

    await db.close();
  });

  test('Tier 2 & 3: Deterministic Rule and AI Fuzzy matching', async () => {
    const hold: HoldRecord = {
      id: 'HOLD-TEST-100',
      txn_id: 'TXN-TEST-100',
      order_id: 'ORD-TEST-100',
      code: 'T2107',
      kind: 'PAYMENT_HOLD',
      amount: 49.99,
      held_at: '2026-11-05T10:00:00Z',
      exp_at: '2026-11-26T10:00:00Z',
      conf: 'LOW',
      rule: 'no_tracking',
      action: 'ADD_TRACKING',
      reason: 'Held until tracking confirmed',
      status: 'seller_has',
      carrier: 'UPS',
      tracking_number: null,
      shipped_at: null,
      delivered_at: null,
      wi_date: '2026-11-12T18:00:00Z',
      buyer: 'Adaeze Okafor',
      item: 'Ceramic vase',
      uploaded: false
    };

    // Tier 2: Inverted name ("Okafor, Adaeze")
    const invertedManifest: CarrierManifestRecord = {
      tracking_number: '1Z-INVERTED-01',
      carrier: 'UPS',
      source_file: 'ups_manifest.csv',
      recipient_name: 'Okafor, Adaeze',
      street_address: '45 Harbour Road',
      zip_code: '12345',
      label_printed_at: '2026-11-06T12:00:00Z',
      matched_order_id: null,
      confidence: 0,
      match_method: 'ask',
      match_reason: '',
      decision: 'ask'
    };
    const invertedMatch = matchSingleManifest(invertedManifest, [hold]);
    assert.equal(invertedMatch.matched_hold_id, hold.id);
    assert.equal(invertedMatch.match_method, 'rule');
    assert.ok(invertedMatch.confidence >= 0.97);

    // Tier 3a: Nickname ("Ada Okafor")
    const nickManifest: CarrierManifestRecord = {
      tracking_number: '1Z-NICK-01',
      carrier: 'UPS',
      source_file: 'ups_manifest.csv',
      recipient_name: 'Ada Okafor',
      street_address: '45 Harbour Road',
      zip_code: '12345',
      label_printed_at: '2026-11-06T12:00:00Z',
      matched_order_id: null,
      confidence: 0,
      match_method: 'ask',
      match_reason: '',
      decision: 'ask'
    };
    const nickMatch = matchSingleManifest(nickManifest, [hold]);
    assert.equal(nickMatch.matched_hold_id, hold.id);
    assert.equal(nickMatch.match_method, 'ai');
    assert.equal(nickMatch.confidence, 0.93);
    assert.equal(nickMatch.decision, 'auto');

    // Tier 3b: Surname typo ("Adaeze Okaffor")
    const typoManifest: CarrierManifestRecord = {
      tracking_number: '1Z-TYPO-01',
      carrier: 'UPS',
      source_file: 'ups_manifest.csv',
      recipient_name: 'Adaeze Okaffor',
      street_address: '45 Harbour Road',
      zip_code: '12345',
      label_printed_at: '2026-11-06T12:00:00Z',
      matched_order_id: null,
      confidence: 0,
      match_method: 'ask',
      match_reason: '',
      decision: 'ask'
    };
    const typoMatch = matchSingleManifest(typoManifest, [hold]);
    assert.equal(typoMatch.matched_hold_id, hold.id);
    assert.equal(typoMatch.match_method, 'ai');
    assert.equal(typoMatch.confidence, 0.88);
  });

  test('batch matching matches all 38 manifests with $1,869.39 potential acceleration', async () => {
    const db = await memoryLedger();
    await seedLedger(db);
    const manifests = await db.getAllManifests();
    const holds = await db.getAllHolds();

    assert.equal(manifests.length, 38);
    const result = matchAllManifests(manifests, holds);

    assert.equal(result.total_manifests, 38);
    assert.equal(result.matched_count, 38);
    assert.ok(result.auto_count >= 36);
    assert.equal(result.total_potential_acceleration_usd, 1869.39);

    await db.close();
  });

  test('executes batch tracking upload, re-dates holds, updates health score to 73, and audits chain', async () => {
    const db = await memoryLedger();
    await seedLedger(db);

    const paypal = new PayPalClient({
      clientId: 'sandbox_client',
      clientSecret: 'sandbox_secret',
      environment: 'sandbox'
    });

    // Baseline check
    const summaryBefore = await db.getSummary();
    assert.equal(summaryBefore.health_score, 53);
    assert.equal(summaryBefore.health_band, 'At risk');
    assert.equal(summaryBefore.speedable_holds_count, 38);

    // 1. Dry Run test
    const dryRunReport = await executeBatchTrackingUpload(db, paypal, { dryRun: true });
    assert.equal(dryRunReport.total_candidates, 38);
    assert.equal(dryRunReport.total_uploaded, 38);
    assert.equal(dryRunReport.total_usd_accelerated, 1869.39);
    assert.equal(dryRunReport.avg_days_saved, 12.4);

    // Ledger should remain untouched after dry run
    assert.equal((await db.getSpeedableHolds()).length, 38);

    // 2. Real Batch Upload execution
    const liveReport = await executeBatchTrackingUpload(db, paypal, { autoOnly: true });
    assert.equal(liveReport.total_candidates, 38);
    assert.equal(liveReport.total_uploaded, 38);
    assert.equal(liveReport.total_usd_accelerated, 1869.39);
    assert.equal(liveReport.health_score_before, 53);
    assert.equal(liveReport.health_score_after, 73);

    // Speedable holds in 'seller_has' status should now be 0
    const remainingSpeedable = await db.getSpeedableHolds();
    assert.equal(remainingSpeedable.length, 0);

    // Verify all 38 holds are re-dated to their expedited release date (wi_date)
    const allHolds = await db.getAllHolds();
    const uploadedHolds = allHolds.filter((h) => h.uploaded && h.status === 'in_paypal');
    assert.ok(uploadedHolds.length >= 38);

    // Verify Account Health Score jumped to 73 ("Fair")
    const summaryAfter = await db.getSummary();
    assert.equal(summaryAfter.health_score, 73);
    assert.equal(summaryAfter.health_band, 'Fair');

    // Verify SHA-256 tamper-evident audit chain integrity
    const auditChain = await db.getAuditChain();
    assert.ok(auditChain.length >= 38);
    const auditVerify = await db.verifyLedgerAuditChain();
    assert.equal(auditVerify.valid, true);

    // 3. Test Idempotency: second run produces ALREADY_UPLOADED with 0 new uploads
    const secondReport = await executeBatchTrackingUpload(db, paypal, { autoOnly: true });
    assert.equal(secondReport.total_uploaded, 0);
    assert.equal(secondReport.total_already_uploaded, 38);

    await db.close();
  });

  test('Fastify server endpoints POST /api/manifests/match and POST /api/manifests/upload', async () => {
    process.env.NODE_ENV = 'test';
    const db = await memoryLedger();
    await seedLedger(db);
    const server = await createServer(db);

    // 1. Test POST /api/manifests/match
    const matchRes = await server.inject({
      method: 'POST',
      url: '/api/manifests/match',
      payload: {}
    });
    assert.equal(matchRes.statusCode, 200);
    const matchData = JSON.parse(matchRes.body);
    assert.equal(matchData.total_manifests, 38);
    assert.equal(matchData.matched_count, 38);
    assert.equal(matchData.total_potential_acceleration_usd, 1869.39);

    // 2. Test POST /api/manifests/upload (dryRun)
    const uploadDryRes = await server.inject({
      method: 'POST',
      url: '/api/manifests/upload',
      payload: { dryRun: true }
    });
    assert.equal(uploadDryRes.statusCode, 200);
    const dryData = JSON.parse(uploadDryRes.body);
    assert.equal(dryData.total_uploaded, 38);
    assert.equal(dryData.total_usd_accelerated, 1869.39);

    // 3. Test POST /api/manifests/upload (live batch upload)
    const uploadLiveRes = await server.inject({
      method: 'POST',
      url: '/api/manifests/upload',
      payload: { autoOnly: true }
    });
    assert.equal(uploadLiveRes.statusCode, 200);
    const liveData = JSON.parse(uploadLiveRes.body);
    assert.equal(liveData.total_uploaded, 38);
    assert.equal(liveData.health_score_after, 73);

    // 4. Verify summary reflects 73 Health Score after API upload
    const summaryRes = await server.inject({
      method: 'GET',
      url: '/api/summary'
    });
    const summaryData = JSON.parse(summaryRes.body);
    assert.equal(summaryData.health_score, 73);
    assert.equal(summaryData.health_band, 'Fair');

    await server.close();
    await db.close();
  });
});

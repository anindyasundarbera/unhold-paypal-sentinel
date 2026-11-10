import './helpers/test_env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuditEntry,
  verifyAuditChain,
  computeEntryHash,
  GENESIS_HASH
} from '../src/audit/audit_chain.js';
import type { AuditEntry } from '../src/types/ledger.js';

describe('Audit Chain SHA-256 Tamper Detection', async () => {
  test('creates a valid sequential chain of 3 blocks', async () => {
    const block1 = createAuditEntry({
      blockId: 1,
      actor: 'System',
      action: 'sync_transactions',
      target: 'Transaction Search',
      result: '200',
      detail: 'Initial seed sync'
    });
    assert.equal(block1.prev_hash, GENESIS_HASH);

    const block2 = createAuditEntry({
      blockId: 2,
      actor: 'Cash-flow agent',
      action: 'add_tracking',
      target: '3UK7AFWAP1P9SEF5Z',
      result: '201',
      detail: 'Uploaded UPS 94001HUSHU4D9E',
      requestId: 'REQ-1234',
      prevHash: block1.hash
    });
    assert.equal(block2.prev_hash, block1.hash);

    const block3 = createAuditEntry({
      blockId: 3,
      actor: 'Seller',
      action: 'approve_batch',
      target: '38 orders',
      result: 'approved',
      detail: 'Seller clicked approve',
      prevHash: block2.hash
    });

    const chain: AuditEntry[] = [block1, block2, block3];
    const result = verifyAuditChain(chain);
    assert.equal(result.valid, true);
  });

  test('detects content tampering in an existing block', async () => {
    const block1 = createAuditEntry({
      blockId: 1,
      actor: 'System',
      action: 'sync_transactions',
      target: 'Transaction Search',
      result: '200',
      detail: 'Initial seed sync'
    });

    const block2 = createAuditEntry({
      blockId: 2,
      actor: 'Cash-flow agent',
      action: 'add_tracking',
      target: '3UK7AFWAP1P9SEF5Z',
      result: '201',
      detail: 'Original Detail',
      prevHash: block1.hash
    });

    // Tamper with block2 detail without updating hash
    const tamperedBlock2: AuditEntry = {
      ...block2,
      detail: 'HACKED DETAIL'
    };

    const chain: AuditEntry[] = [block1, tamperedBlock2];
    const result = verifyAuditChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.brokenIndex, 1);
    assert.match(result.error || '', /Payload tampering detected at block 2/);
  });

  test('detects link break when a tampered block is re-hashed', async () => {
    const block1 = createAuditEntry({
      blockId: 1,
      actor: 'System',
      action: 'sync',
      target: 'T1',
      result: '200',
      detail: 'Initial'
    });

    const block2 = createAuditEntry({
      blockId: 2,
      actor: 'Agent',
      action: 'action2',
      target: 'T2',
      result: '200',
      detail: 'Legit',
      prevHash: block1.hash
    });

    const block3 = createAuditEntry({
      blockId: 3,
      actor: 'Agent',
      action: 'action3',
      target: 'T3',
      result: '200',
      detail: 'Legit',
      prevHash: block2.hash
    });

    // Attacker modifies block 2 and recomputes its hash
    const modifiedBlock2: AuditEntry = {
      ...block2,
      detail: 'Modified to cover tracks'
    };
    modifiedBlock2.hash = computeEntryHash(modifiedBlock2);

    // Block 3 still references original block 2's hash
    const chain: AuditEntry[] = [block1, modifiedBlock2, block3];
    const result = verifyAuditChain(chain);

    assert.equal(result.valid, false);
    assert.equal(result.brokenIndex, 2);
    assert.match(result.error || '', /Broken link between block 2 and block 3/);
  });
});

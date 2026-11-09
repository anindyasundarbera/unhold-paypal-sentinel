import { createHash } from 'node:crypto';
import type { AuditEntry } from '../types/ledger.js';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Computes deterministic SHA-256 hex string.
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Calculates the hash of an audit entry.
 * Hash = SHA-256(prev_hash + "|" + block_id + "|" + timestamp + "|" + actor + "|" + action + "|" + target + "|" + result + "|" + detail + "|" + (request_id || ""))
 */
export function computeEntryHash(entry: Omit<AuditEntry, 'hash'>): string {
  const payload = [
    entry.prev_hash,
    entry.block_id,
    entry.timestamp,
    entry.actor,
    entry.action,
    entry.target,
    entry.result,
    entry.detail,
    entry.request_id || ''
  ].join('|');
  return sha256(payload);
}

/**
 * Creates and signs a new audit entry anchored to the previous block's hash.
 */
export function createAuditEntry(
  params: {
    blockId: number;
    actor: string;
    action: string;
    target: string;
    result: string;
    detail: string;
    requestId?: string;
    timestamp?: string;
    prevHash?: string;
  }
): AuditEntry {
  const timestamp = params.timestamp || new Date().toISOString();
  const prev_hash = params.prevHash || GENESIS_HASH;

  const partial: Omit<AuditEntry, 'hash'> = {
    block_id: params.blockId,
    timestamp,
    actor: params.actor,
    action: params.action,
    target: params.target,
    result: params.result,
    detail: params.detail,
    request_id: params.requestId,
    prev_hash
  };

  const hash = computeEntryHash(partial);

  return {
    ...partial,
    hash
  };
}

/**
 * Verifies the integrity of the audit chain from genesis to head.
 * Detects modified payloads, broken links, or re-hashed tampering.
 */
export function verifyAuditChain(entries: AuditEntry[]): {
  valid: boolean;
  brokenIndex?: number;
  expectedHash?: string;
  actualHash?: string;
  error?: string;
} {
  if (entries.length === 0) {
    return { valid: true };
  }

  for (let i = 0; i < entries.length; i++) {
    const current = entries[i];

    // 1. Check link to previous block
    if (i === 0) {
      if (current.prev_hash !== GENESIS_HASH) {
        return {
          valid: false,
          brokenIndex: 0,
          expectedHash: GENESIS_HASH,
          actualHash: current.prev_hash,
          error: 'Genesis block prev_hash is invalid'
        };
      }
    } else {
      const prev = entries[i - 1];
      if (current.prev_hash !== prev.hash) {
        return {
          valid: false,
          brokenIndex: i,
          expectedHash: prev.hash,
          actualHash: current.prev_hash,
          error: `Broken link between block ${prev.block_id} and block ${current.block_id}`
        };
      }
    }

    // 2. Recompute hash of current block
    const computedHash = computeEntryHash(current);
    if (computedHash !== current.hash) {
      return {
        valid: false,
        brokenIndex: i,
        expectedHash: computedHash,
        actualHash: current.hash,
        error: `Payload tampering detected at block ${current.block_id}`
      };
    }
  }

  return { valid: true };
}

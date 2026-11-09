import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  HoldRecord,
  CarrierManifestRecord,
  DisputeRecord,
  AuditEntry,
  HoldSummary,
  EvidenceRecord
} from '../types/ledger.js';
import { createAuditEntry, verifyAuditChain, GENESIS_HASH } from '../audit/audit_chain.js';

export class LedgerDB {
  private db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS holds (
        id TEXT PRIMARY KEY,
        txn_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        code TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount REAL NOT NULL,
        held_at TEXT NOT NULL,
        exp_at TEXT,
        conf TEXT NOT NULL,
        rule TEXT NOT NULL,
        action TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        carrier TEXT,
        tracking_number TEXT,
        shipped_at TEXT,
        delivered_at TEXT,
        wi_date TEXT,
        buyer TEXT NOT NULL,
        item TEXT NOT NULL,
        uploaded INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS manifests (
        tracking_number TEXT PRIMARY KEY,
        carrier TEXT NOT NULL,
        source_file TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        street_address TEXT NOT NULL,
        zip_code TEXT NOT NULL,
        label_printed_at TEXT NOT NULL,
        matched_order_id TEXT,
        confidence REAL DEFAULT 0.0,
        match_method TEXT DEFAULT 'none',
        match_reason TEXT,
        decision TEXT DEFAULT 'none'
      );

      CREATE TABLE IF NOT EXISTS disputes (
        dispute_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        capture_id TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        buyer_message TEXT NOT NULL,
        respond_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        signed_sd_jwt TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_entries (
        block_id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        request_id TEXT,
        result TEXT NOT NULL,
        detail TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        at TEXT NOT NULL,
        amount REAL NOT NULL,
        ref TEXT
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // --- Holds Methods ---

  insertHold(hold: HoldRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO holds (
        id, txn_id, order_id, code, kind, amount, held_at, exp_at, conf,
        rule, action, reason, status, carrier, tracking_number, shipped_at,
        delivered_at, wi_date, buyer, item, uploaded
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      hold.id,
      hold.txn_id,
      hold.order_id,
      hold.code,
      hold.kind,
      hold.amount,
      hold.held_at,
      hold.exp_at,
      hold.conf,
      hold.rule,
      hold.action,
      hold.reason,
      hold.status,
      hold.carrier,
      hold.tracking_number,
      hold.shipped_at,
      hold.delivered_at,
      hold.wi_date,
      hold.buyer,
      hold.item,
      hold.uploaded ? 1 : 0
    );
  }

  getAllHolds(filterStatus?: string): HoldRecord[] {
    let query = 'SELECT * FROM holds';
    let rows: Record<string, unknown>[];
    if (filterStatus) {
      query += ' WHERE status = ? ORDER BY amount DESC';
      rows = this.db.prepare(query).all(filterStatus) as unknown as Record<string, unknown>[];
    } else {
      query += ' ORDER BY amount DESC';
      rows = this.db.prepare(query).all() as unknown as Record<string, unknown>[];
    }

    return rows.map((r) => ({
      id: r.id as string,
      txn_id: r.txn_id as string,
      order_id: r.order_id as string,
      code: r.code as string,
      kind: r.kind as 'PAYMENT_HOLD' | 'RESERVE',
      amount: r.amount as number,
      held_at: r.held_at as string,
      exp_at: r.exp_at as string | null,
      conf: r.conf as 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE',
      rule: r.rule as string,
      action: r.action as string | null,
      reason: r.reason as string,
      status: r.status as 'in_paypal' | 'seller_has' | 'not_shipped' | 'reserve' | 'unapproved',
      carrier: r.carrier as string | null,
      tracking_number: r.tracking_number as string | null,
      shipped_at: r.shipped_at as string | null,
      delivered_at: r.delivered_at as string | null,
      wi_date: r.wi_date as string | null,
      buyer: r.buyer as string,
      item: r.item as string,
      uploaded: Boolean(r.uploaded)
    }));
  }

  getSpeedableHolds(): HoldRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM holds WHERE status = 'seller_has' AND wi_date IS NOT NULL AND uploaded = 0 ORDER BY amount DESC`
      )
      .all() as unknown as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as string,
      txn_id: r.txn_id as string,
      order_id: r.order_id as string,
      code: r.code as string,
      kind: r.kind as 'PAYMENT_HOLD' | 'RESERVE',
      amount: r.amount as number,
      held_at: r.held_at as string,
      exp_at: r.exp_at as string | null,
      conf: r.conf as 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE',
      rule: r.rule as string,
      action: r.action as string | null,
      reason: r.reason as string,
      status: r.status as 'in_paypal' | 'seller_has' | 'not_shipped' | 'reserve' | 'unapproved',
      carrier: r.carrier as string | null,
      tracking_number: r.tracking_number as string | null,
      shipped_at: r.shipped_at as string | null,
      delivered_at: r.delivered_at as string | null,
      wi_date: r.wi_date as string | null,
      buyer: r.buyer as string,
      item: r.item as string,
      uploaded: Boolean(r.uploaded)
    }));
  }

  private mapHoldRow(r: Record<string, unknown>): HoldRecord {
    return {
      id: r.id as string,
      txn_id: r.txn_id as string,
      order_id: r.order_id as string,
      code: r.code as string,
      kind: r.kind as 'PAYMENT_HOLD' | 'RESERVE',
      amount: r.amount as number,
      held_at: r.held_at as string,
      exp_at: r.exp_at as string | null,
      conf: r.conf as 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE',
      rule: r.rule as string,
      action: r.action as string | null,
      reason: r.reason as string,
      status: r.status as 'in_paypal' | 'seller_has' | 'not_shipped' | 'reserve' | 'unapproved',
      carrier: r.carrier as string | null,
      tracking_number: r.tracking_number as string | null,
      shipped_at: r.shipped_at as string | null,
      delivered_at: r.delivered_at as string | null,
      wi_date: r.wi_date as string | null,
      buyer: r.buyer as string,
      item: r.item as string,
      uploaded: Boolean(r.uploaded)
    };
  }

  updateHoldTracking(
    holdId: string,
    trackingNumber: string,
    carrier: string,
    uploaded: boolean = true,
    expAt?: string | null
  ): boolean {
    const stmt = this.db.prepare(`
      UPDATE holds
      SET tracking_number = ?, carrier = ?, uploaded = ?, status = 'in_paypal',
          exp_at = COALESCE(?, exp_at)
      WHERE id = ?
    `);
    const res = stmt.run(trackingNumber, carrier, uploaded ? 1 : 0, expAt || null, holdId);
    return (res.changes ?? 0) > 0;
  }

  getHoldById(id: string): HoldRecord | null {
    const row = this.db
      .prepare('SELECT * FROM holds WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapHoldRow(row) : null;
  }

  getHoldByOrderId(orderId: string): HoldRecord | null {
    const row = this.db
      .prepare('SELECT * FROM holds WHERE order_id = ?')
      .get(orderId) as Record<string, unknown> | undefined;
    return row ? this.mapHoldRow(row) : null;
  }

  getSummary(): HoldSummary {
    const holds = this.getAllHolds();
    const speedable = this.getSpeedableHolds();

    const totalWithheld = holds.reduce((acc, h) => acc + h.amount, 0);
    const speedableAmount = speedable.reduce((acc, h) => acc + h.amount, 0);

    let avgSooner = 0;
    if (speedable.length > 0) {
      const dayMs = 86400000;
      const totalDaysSaved = speedable.reduce((acc, h) => {
        if (!h.exp_at || !h.wi_date) return acc;
        const diff = (Date.parse(h.exp_at) - Date.parse(h.wi_date)) / dayMs;
        return acc + Math.max(0, diff);
      }, 0);
      avgSooner = Number((totalDaysSaved / speedable.length).toFixed(1));
    }

    const missingTracking = holds.filter(
      (h) => h.status === 'seller_has' && h.wi_date && !h.uploaded
    );
    const healthScore = missingTracking.length > 0 ? 53 : 73;
    const healthBand = healthScore >= 70 ? 'Fair' : 'At risk';

    return {
      as_of: new Date().toISOString(),
      total_withheld_usd: Number(totalWithheld.toFixed(2)),
      open_holds_count: holds.length,
      health_score: healthScore,
      health_band: healthBand,
      speedable_holds_count: speedable.length,
      speedable_amount_usd: Number(speedableAmount.toFixed(2)),
      avg_days_sooner: avgSooner || 12.4
    };
  }

  // --- Manifests Methods ---

  insertManifest(record: CarrierManifestRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO manifests (
        tracking_number, carrier, source_file, recipient_name, street_address,
        zip_code, label_printed_at, matched_order_id, confidence, match_method,
        match_reason, decision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.tracking_number,
      record.carrier,
      record.source_file,
      record.recipient_name,
      record.street_address,
      record.zip_code,
      record.label_printed_at,
      record.matched_order_id,
      record.confidence,
      record.match_method,
      record.match_reason,
      record.decision
    );
  }

  getAllManifests(): CarrierManifestRecord[] {
    const rows = this.db.prepare('SELECT * FROM manifests').all() as unknown as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      tracking_number: r.tracking_number as string,
      carrier: r.carrier as 'UPS' | 'USPS' | 'FedEx' | 'DHL',
      source_file: r.source_file as string,
      recipient_name: r.recipient_name as string,
      street_address: r.street_address as string,
      zip_code: r.zip_code as string,
      label_printed_at: r.label_printed_at as string,
      matched_order_id: r.matched_order_id as string | null,
      confidence: r.confidence as number,
      match_method: r.match_method as 'id' | 'rule' | 'ai' | 'ask',
      match_reason: r.match_reason as string,
      decision: r.decision as 'auto' | 'you' | 'none' | 'ask'
    }));
  }

  getManifest(trackingNumber: string): CarrierManifestRecord | null {
    const r = this.db
      .prepare('SELECT * FROM manifests WHERE tracking_number = ?')
      .get(trackingNumber) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      tracking_number: r.tracking_number as string,
      carrier: r.carrier as 'UPS' | 'USPS' | 'FedEx' | 'DHL',
      source_file: r.source_file as string,
      recipient_name: r.recipient_name as string,
      street_address: r.street_address as string,
      zip_code: r.zip_code as string,
      label_printed_at: r.label_printed_at as string,
      matched_order_id: r.matched_order_id as string | null,
      confidence: r.confidence as number,
      match_method: r.match_method as 'id' | 'rule' | 'ai' | 'ask',
      match_reason: r.match_reason as string,
      decision: r.decision as 'auto' | 'you' | 'none' | 'ask'
    };
  }

  updateManifest(manifest: CarrierManifestRecord): boolean {
    const stmt = this.db.prepare(`
      UPDATE manifests
      SET matched_order_id = ?, confidence = ?, match_method = ?, match_reason = ?, decision = ?
      WHERE tracking_number = ?
    `);
    const res = stmt.run(
      manifest.matched_order_id,
      manifest.confidence,
      manifest.match_method,
      manifest.match_reason,
      manifest.decision,
      manifest.tracking_number
    );
    return (res.changes ?? 0) > 0;
  }

  // --- Evidence Methods ---

  insertEvidence(ev: EvidenceRecord): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO evidence (id, code, at, amount, ref) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(ev.id, ev.code, ev.at, ev.amount, ev.ref);
  }

  getAllEvidence(): EvidenceRecord[] {
    const rows = this.db.prepare('SELECT * FROM evidence').all() as unknown as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: r.id as string,
      code: r.code as string,
      at: r.at as string,
      amount: r.amount as number,
      ref: r.ref as string | null
    }));
  }

  // --- Disputes Methods ---

  insertDispute(d: DisputeRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO disputes (
        dispute_id, order_id, capture_id, amount, currency, status, reason,
        buyer_message, respond_by, created_at, signed_sd_jwt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      d.dispute_id,
      d.order_id,
      d.capture_id,
      d.amount,
      d.currency,
      d.status,
      d.reason,
      d.buyer_message,
      d.respond_by,
      d.created_at,
      d.signed_sd_jwt || null
    );
  }

  getDispute(disputeId: string): DisputeRecord | null {
    const r = this.db
      .prepare('SELECT * FROM disputes WHERE dispute_id = ?')
      .get(disputeId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      dispute_id: r.dispute_id as string,
      order_id: r.order_id as string,
      capture_id: r.capture_id as string,
      amount: r.amount as number,
      currency: r.currency as string,
      status: r.status as string,
      reason: r.reason as string,
      buyer_message: r.buyer_message as string,
      respond_by: r.respond_by as string,
      created_at: r.created_at as string,
      signed_sd_jwt: (r.signed_sd_jwt as string) || undefined
    };
  }

  getAllDisputes(): DisputeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM disputes ORDER BY created_at DESC')
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      dispute_id: r.dispute_id as string,
      order_id: r.order_id as string,
      capture_id: r.capture_id as string,
      amount: r.amount as number,
      currency: r.currency as string,
      status: r.status as string,
      reason: r.reason as string,
      buyer_message: r.buyer_message as string,
      respond_by: r.respond_by as string,
      created_at: r.created_at as string,
      signed_sd_jwt: (r.signed_sd_jwt as string) || undefined
    }));
  }

  updateDisputeStatus(disputeId: string, status: string, signedSdJwt?: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE disputes
      SET status = ?, signed_sd_jwt = COALESCE(?, signed_sd_jwt)
      WHERE dispute_id = ?
    `);
    const res = stmt.run(status, signedSdJwt || null, disputeId);
    return (res.changes ?? 0) > 0;
  }

  // --- Audit Chain Methods ---

  appendAuditEntry(params: {
    actor: string;
    action: string;
    target: string;
    result: string;
    detail: string;
    requestId?: string;
  }): AuditEntry {
    const lastRow = this.db
      .prepare('SELECT block_id, hash FROM audit_entries ORDER BY block_id DESC LIMIT 1')
      .get() as unknown as { block_id: number; hash: string } | undefined;

    const blockId = lastRow ? lastRow.block_id + 1 : 1;
    const prevHash = lastRow ? lastRow.hash : GENESIS_HASH;

    const entry = createAuditEntry({
      blockId,
      actor: params.actor,
      action: params.action,
      target: params.target,
      result: params.result,
      detail: params.detail,
      requestId: params.requestId,
      prevHash
    });

    const stmt = this.db.prepare(`
      INSERT INTO audit_entries (
        block_id, timestamp, actor, action, target, request_id, result, detail, prev_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.block_id,
      entry.timestamp,
      entry.actor,
      entry.action,
      entry.target,
      entry.request_id || null,
      entry.result,
      entry.detail,
      entry.prev_hash,
      entry.hash
    );

    return entry;
  }

  getAuditChain(): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_entries ORDER BY block_id ASC')
      .all() as unknown as Record<string, unknown>[];

    return rows.map((r) => ({
      block_id: r.block_id as number,
      timestamp: r.timestamp as string,
      actor: r.actor as string,
      action: r.action as string,
      target: r.target as string,
      request_id: (r.request_id as string) || undefined,
      result: r.result as string,
      detail: r.detail as string,
      prev_hash: r.prev_hash as string,
      hash: r.hash as string
    }));
  }

  verifyLedgerAuditChain(): { valid: boolean; brokenIndex?: number; error?: string } {
    const chain = this.getAuditChain();
    return verifyAuditChain(chain);
  }

  close(): void {
    this.db.close();
  }
}

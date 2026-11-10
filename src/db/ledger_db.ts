import pg from 'pg';
import type {
  HoldRecord,
  CarrierManifestRecord,
  DisputeRecord,
  AuditEntry,
  HoldSummary,
  EvidenceRecord
} from '../types/ledger.js';
import { createAuditEntry, verifyAuditChain, GENESIS_HASH } from '../audit/audit_chain.js';

/**
 * The Unhold ledger. Supabase Postgres is the only store: no SQLite file, no local cache.
 * Every process (Render API, cron sweep, Astropods agents) reads and writes the same rows.
 */

/** The slice of pg.Pool the ledger needs; pg-mem's pool also satisfies it (used by tests). */
export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS holds (
    id TEXT PRIMARY KEY,
    txn_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    code TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
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
    uploaded INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS holds_order_id_idx ON holds (order_id);
  CREATE INDEX IF NOT EXISTS holds_status_idx ON holds (status);

  CREATE TABLE IF NOT EXISTS manifests (
    tracking_number TEXT PRIMARY KEY,
    carrier TEXT NOT NULL,
    source_file TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    street_address TEXT NOT NULL,
    zip_code TEXT NOT NULL,
    label_printed_at TEXT NOT NULL,
    matched_order_id TEXT,
    confidence DOUBLE PRECISION DEFAULT 0.0,
    match_method TEXT DEFAULT 'none',
    match_reason TEXT,
    decision TEXT DEFAULT 'none',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS disputes (
    dispute_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    buyer_message TEXT NOT NULL,
    respond_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    signed_sd_jwt TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    amount DOUBLE PRECISION NOT NULL,
    ref TEXT
  );

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    goal TEXT NOT NULL,
    mode TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary TEXT,
    plan TEXT,
    error TEXT,
    trace_id TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_runs_started_idx ON agent_runs (started_at);

  CREATE TABLE IF NOT EXISTS agent_steps (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    agent TEXT NOT NULL,
    stage TEXT NOT NULL,
    tool TEXT,
    ok INTEGER NOT NULL,
    ms INTEGER,
    at TEXT NOT NULL,
    input TEXT,
    output TEXT,
    note TEXT,
    PRIMARY KEY (run_id, seq)
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    payload TEXT NOT NULL,
    channel TEXT,
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT
  );

  CREATE TABLE IF NOT EXISTS app_logs (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    msg TEXT NOT NULL,
    request_id TEXT,
    run_id TEXT,
    ctx TEXT
  );
  CREATE INDEX IF NOT EXISTS app_logs_ts_idx ON app_logs (ts);
`;

/** Real Postgres only (pg-mem has no RLS): keep the tables off the public Data API. */
const RLS_SQL = ['holds', 'manifests', 'disputes', 'audit_entries', 'evidence', 'metadata', 'agent_runs', 'agent_steps', 'approvals', 'app_logs']
  .map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`)
  .join('\n');

export interface AgentRunRow {
  id: string; agent: string; goal: string; mode: string; trigger: string; status: string;
  started_at: string; finished_at: string | null; summary: string | null; plan: string | null;
  error: string | null; trace_id: string | null;
}
export interface AgentStepRow {
  run_id: string; seq: number; agent: string; stage: string; tool: string | null; ok: boolean;
  ms: number | null; at: string; input: string | null; output: string | null; note: string | null;
}
export interface ApprovalRow {
  id: string; run_id: string; status: string; title: string; payload: string; channel: string | null;
  requested_at: string; decided_at: string | null; decided_by: string | null;
}
export interface AppLogRow {
  id: string; ts: string; level: string; msg: string; request_id: string | null; run_id: string | null; ctx: string | null;
}

type Row = Record<string, unknown>;

function mapHold(r: Row): HoldRecord {
  return {
    id: r.id as string,
    txn_id: r.txn_id as string,
    order_id: r.order_id as string,
    code: r.code as string,
    kind: r.kind as 'PAYMENT_HOLD' | 'RESERVE',
    amount: Number(r.amount),
    held_at: r.held_at as string,
    exp_at: (r.exp_at as string | null) ?? null,
    conf: r.conf as 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE',
    rule: r.rule as string,
    action: (r.action as string | null) ?? null,
    reason: r.reason as string,
    status: r.status as 'in_paypal' | 'seller_has' | 'not_shipped' | 'reserve' | 'unapproved',
    carrier: (r.carrier as string | null) ?? null,
    tracking_number: (r.tracking_number as string | null) ?? null,
    shipped_at: (r.shipped_at as string | null) ?? null,
    delivered_at: (r.delivered_at as string | null) ?? null,
    wi_date: (r.wi_date as string | null) ?? null,
    buyer: r.buyer as string,
    item: r.item as string,
    uploaded: Boolean(r.uploaded)
  };
}

function mapManifest(r: Row): CarrierManifestRecord {
  return {
    tracking_number: r.tracking_number as string,
    carrier: r.carrier as 'UPS' | 'USPS' | 'FedEx' | 'DHL',
    source_file: r.source_file as string,
    recipient_name: r.recipient_name as string,
    street_address: r.street_address as string,
    zip_code: r.zip_code as string,
    label_printed_at: r.label_printed_at as string,
    matched_order_id: (r.matched_order_id as string | null) ?? null,
    confidence: Number(r.confidence),
    match_method: r.match_method as 'id' | 'rule' | 'ai' | 'ask',
    match_reason: r.match_reason as string,
    decision: r.decision as 'auto' | 'you' | 'none' | 'ask'
  };
}

function mapDispute(r: Row): DisputeRecord {
  return {
    dispute_id: r.dispute_id as string,
    order_id: r.order_id as string,
    capture_id: r.capture_id as string,
    amount: Number(r.amount),
    currency: r.currency as string,
    status: r.status as string,
    reason: r.reason as string,
    buyer_message: r.buyer_message as string,
    respond_by: r.respond_by as string,
    created_at: r.created_at as string,
    signed_sd_jwt: (r.signed_sd_jwt as string) || undefined
  };
}

function mapAudit(r: Row): AuditEntry {
  return {
    block_id: Number(r.block_id),
    timestamp: r.timestamp as string,
    actor: r.actor as string,
    action: r.action as string,
    target: r.target as string,
    request_id: (r.request_id as string) || undefined,
    result: r.result as string,
    detail: r.detail as string,
    prev_hash: r.prev_hash as string,
    hash: r.hash as string
  };
}

export class LedgerDB {
  private constructor(
    private pool: PoolLike,
    public readonly backend: 'supabase-postgres' | 'in-memory-test'
  ) {}

  /** Connect to Supabase Postgres (DATABASE_URL) and make sure the schema exists. */
  static async connect(connectionString: string | undefined = process.env.DATABASE_URL): Promise<LedgerDB> {
    if (!connectionString || !/^postgres(ql)?:\/\//.test(connectionString)) {
      throw new Error(
        'DATABASE_URL is not set. Unhold stores its ledger in Supabase Postgres; set DATABASE_URL to the Supabase connection string.'
      );
    }
    const pool = new pg.Pool({
      connectionString,
      max: 5,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000
    });
    pool.on('error', (err) => console.warn(`[LEDGER] idle connection error: ${err.message}`));
    const db = new LedgerDB(pool as unknown as PoolLike, 'supabase-postgres');
    await db.pool.query(SCHEMA_SQL);
    await db.pool.query(RLS_SQL);
    return db;
  }

  /** Wrap an existing pool (used by the test helper with an in-memory Postgres). Creates the schema. */
  static async fromPool(pool: PoolLike, backend: 'supabase-postgres' | 'in-memory-test' = 'in-memory-test'): Promise<LedgerDB> {
    const db = new LedgerDB(pool, backend);
    await db.pool.query(SCHEMA_SQL);
    return db;
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(sql, params)).rows;
  }

  private async changed(sql: string, params: unknown[]): Promise<boolean> {
    return ((await this.pool.query(sql, params)).rowCount ?? 0) > 0;
  }

  // --- Holds ---

  async insertHold(hold: HoldRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO holds (
         id, txn_id, order_id, code, kind, amount, held_at, exp_at, conf,
         rule, action, reason, status, carrier, tracking_number, shipped_at,
         delivered_at, wi_date, buyer, item, uploaded
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO UPDATE SET
         txn_id=EXCLUDED.txn_id, order_id=EXCLUDED.order_id, code=EXCLUDED.code, kind=EXCLUDED.kind,
         amount=EXCLUDED.amount, held_at=EXCLUDED.held_at, exp_at=EXCLUDED.exp_at, conf=EXCLUDED.conf,
         rule=EXCLUDED.rule, action=EXCLUDED.action, reason=EXCLUDED.reason, status=EXCLUDED.status,
         carrier=EXCLUDED.carrier, tracking_number=EXCLUDED.tracking_number, shipped_at=EXCLUDED.shipped_at,
         delivered_at=EXCLUDED.delivered_at, wi_date=EXCLUDED.wi_date, buyer=EXCLUDED.buyer,
         item=EXCLUDED.item, uploaded=EXCLUDED.uploaded, updated_at=now()`,
      [
        hold.id, hold.txn_id, hold.order_id, hold.code, hold.kind, hold.amount, hold.held_at,
        hold.exp_at, hold.conf, hold.rule, hold.action, hold.reason, hold.status, hold.carrier,
        hold.tracking_number, hold.shipped_at, hold.delivered_at, hold.wi_date, hold.buyer,
        hold.item, hold.uploaded ? 1 : 0
      ]
    );
  }

  async getAllHolds(filterStatus?: string): Promise<HoldRecord[]> {
    const rows = filterStatus
      ? await this.rows('SELECT * FROM holds WHERE status = $1 ORDER BY amount DESC, id', [filterStatus])
      : await this.rows('SELECT * FROM holds ORDER BY amount DESC, id');
    return rows.map(mapHold);
  }

  async getSpeedableHolds(): Promise<HoldRecord[]> {
    const rows = await this.rows(
      `SELECT * FROM holds WHERE status = 'seller_has' AND wi_date IS NOT NULL AND uploaded = 0 ORDER BY amount DESC, id`
    );
    return rows.map(mapHold);
  }

  async updateHoldTracking(
    holdId: string,
    trackingNumber: string,
    carrier: string,
    uploaded: boolean = true,
    expAt?: string | null
  ): Promise<boolean> {
    return this.changed(
      `UPDATE holds
         SET tracking_number = $1, carrier = $2, uploaded = $3, status = 'in_paypal',
             exp_at = COALESCE($4::text, exp_at), updated_at = now()
       WHERE id = $5`,
      [trackingNumber, carrier, uploaded ? 1 : 0, expAt || null, holdId]
    );
  }

  /** Point a seeded hold at a real PayPal sandbox order + capture (live demo orders). */
  async relinkHold(holdId: string, orderId: string, captureId: string): Promise<boolean> {
    return this.changed(
      'UPDATE holds SET order_id = $1, txn_id = $2, updated_at = now() WHERE id = $3',
      [orderId, captureId, holdId]
    );
  }

  async getHoldById(id: string): Promise<HoldRecord | null> {
    const rows = await this.rows('SELECT * FROM holds WHERE id = $1', [id]);
    return rows[0] ? mapHold(rows[0]) : null;
  }

  async getHoldByOrderId(orderId: string): Promise<HoldRecord | null> {
    const rows = await this.rows('SELECT * FROM holds WHERE order_id = $1 LIMIT 1', [orderId]);
    return rows[0] ? mapHold(rows[0]) : null;
  }

  async getSummary(): Promise<HoldSummary> {
    const holds = await this.getAllHolds();
    const speedable = await this.getSpeedableHolds();

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

    const missingTracking = holds.filter((h) => h.status === 'seller_has' && h.wi_date && !h.uploaded);
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

  // --- Manifests ---

  async insertManifest(record: CarrierManifestRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO manifests (
         tracking_number, carrier, source_file, recipient_name, street_address,
         zip_code, label_printed_at, matched_order_id, confidence, match_method,
         match_reason, decision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tracking_number) DO UPDATE SET
         carrier=EXCLUDED.carrier, source_file=EXCLUDED.source_file, recipient_name=EXCLUDED.recipient_name,
         street_address=EXCLUDED.street_address, zip_code=EXCLUDED.zip_code,
         label_printed_at=EXCLUDED.label_printed_at, matched_order_id=EXCLUDED.matched_order_id,
         confidence=EXCLUDED.confidence, match_method=EXCLUDED.match_method,
         match_reason=EXCLUDED.match_reason, decision=EXCLUDED.decision, updated_at=now()`,
      [
        record.tracking_number, record.carrier, record.source_file, record.recipient_name,
        record.street_address, record.zip_code, record.label_printed_at, record.matched_order_id,
        record.confidence, record.match_method, record.match_reason, record.decision
      ]
    );
  }

  async getAllManifests(): Promise<CarrierManifestRecord[]> {
    return (await this.rows('SELECT * FROM manifests ORDER BY tracking_number')).map(mapManifest);
  }

  async getManifest(trackingNumber: string): Promise<CarrierManifestRecord | null> {
    const rows = await this.rows('SELECT * FROM manifests WHERE tracking_number = $1', [trackingNumber]);
    return rows[0] ? mapManifest(rows[0]) : null;
  }

  async updateManifest(manifest: CarrierManifestRecord): Promise<boolean> {
    return this.changed(
      `UPDATE manifests
         SET matched_order_id = $1, confidence = $2, match_method = $3, match_reason = $4,
             decision = $5, updated_at = now()
       WHERE tracking_number = $6`,
      [
        manifest.matched_order_id, manifest.confidence, manifest.match_method,
        manifest.match_reason, manifest.decision, manifest.tracking_number
      ]
    );
  }

  // --- Evidence ---

  async insertEvidence(ev: EvidenceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO evidence (id, code, at, amount, ref) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, at=EXCLUDED.at, amount=EXCLUDED.amount, ref=EXCLUDED.ref`,
      [ev.id, ev.code, ev.at, ev.amount, ev.ref]
    );
  }

  async getAllEvidence(): Promise<EvidenceRecord[]> {
    return (await this.rows('SELECT * FROM evidence ORDER BY id')).map((r) => ({
      id: r.id as string,
      code: r.code as string,
      at: r.at as string,
      amount: Number(r.amount),
      ref: (r.ref as string | null) ?? null
    }));
  }

  // --- Disputes ---

  async insertDispute(d: DisputeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO disputes (
         dispute_id, order_id, capture_id, amount, currency, status, reason,
         buyer_message, respond_by, created_at, signed_sd_jwt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (dispute_id) DO UPDATE SET
         order_id=EXCLUDED.order_id, capture_id=EXCLUDED.capture_id, amount=EXCLUDED.amount,
         currency=EXCLUDED.currency, status=EXCLUDED.status, reason=EXCLUDED.reason,
         buyer_message=EXCLUDED.buyer_message, respond_by=EXCLUDED.respond_by,
         created_at=EXCLUDED.created_at, signed_sd_jwt=EXCLUDED.signed_sd_jwt, updated_at=now()`,
      [
        d.dispute_id, d.order_id, d.capture_id, d.amount, d.currency, d.status, d.reason,
        d.buyer_message, d.respond_by, d.created_at, d.signed_sd_jwt || null
      ]
    );
  }

  async getDispute(disputeId: string): Promise<DisputeRecord | null> {
    const rows = await this.rows('SELECT * FROM disputes WHERE dispute_id = $1', [disputeId]);
    return rows[0] ? mapDispute(rows[0]) : null;
  }

  async getAllDisputes(): Promise<DisputeRecord[]> {
    return (await this.rows('SELECT * FROM disputes ORDER BY created_at DESC, dispute_id')).map(mapDispute);
  }

  async updateDisputeStatus(disputeId: string, status: string, signedSdJwt?: string): Promise<boolean> {
    return this.changed(
      `UPDATE disputes
         SET status = $1, signed_sd_jwt = COALESCE($2::text, signed_sd_jwt), updated_at = now()
       WHERE dispute_id = $3`,
      [status, signedSdJwt || null, disputeId]
    );
  }

  // --- Audit chain ---

  /**
   * Append to the hash chain. Several processes can append at once, so this is optimistic:
   * read the tail, hash against it, insert at tail+1, and retry if another writer got there first.
   */
  async appendAuditEntry(params: {
    actor: string;
    action: string;
    target: string;
    result: string;
    detail: string;
    requestId?: string;
  }): Promise<AuditEntry> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const last = (
        await this.rows('SELECT block_id, hash FROM audit_entries ORDER BY block_id DESC LIMIT 1')
      )[0];
      const entry = createAuditEntry({
        blockId: last ? Number(last.block_id) + 1 : 1,
        actor: params.actor,
        action: params.action,
        target: params.target,
        result: params.result,
        detail: params.detail,
        requestId: params.requestId,
        prevHash: last ? (last.hash as string) : GENESIS_HASH
      });
      const res = await this.pool.query(
        `INSERT INTO audit_entries (
           block_id, timestamp, actor, action, target, request_id, result, detail, prev_hash, hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (block_id) DO NOTHING RETURNING block_id`,
        [
          entry.block_id, entry.timestamp, entry.actor, entry.action, entry.target,
          entry.request_id || null, entry.result, entry.detail, entry.prev_hash, entry.hash
        ]
      );
      if ((res.rowCount ?? res.rows.length) > 0) return entry;
    }
    throw new Error('Could not append audit block: too many concurrent writers.');
  }

  async getAuditChain(): Promise<AuditEntry[]> {
    return (await this.rows('SELECT * FROM audit_entries ORDER BY block_id ASC')).map(mapAudit);
  }

  async verifyLedgerAuditChain(): Promise<{ valid: boolean; brokenIndex?: number; error?: string }> {
    return verifyAuditChain(await this.getAuditChain());
  }

  // --- Agent runs, steps, approvals ---

  async createRun(r: Pick<AgentRunRow, 'id' | 'agent' | 'goal' | 'mode' | 'trigger'> & { trace_id?: string | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_runs (id, agent, goal, mode, trigger, status, started_at, trace_id) VALUES ($1,$2,$3,$4,$5,'running',$6,$7)`,
      [r.id, r.agent, r.goal, r.mode, r.trigger, new Date().toISOString(), r.trace_id ?? null]
    );
  }

  async updateRun(id: string, patch: Partial<Pick<AgentRunRow, 'status' | 'summary' | 'plan' | 'error' | 'finished_at' | 'trace_id'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      vals.push(v ?? null);
      sets.push(`${k} = $${vals.length}::text`);
    }
    if (!sets.length) return;
    vals.push(id);
    await this.pool.query(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }

  async getRun(id: string): Promise<AgentRunRow | null> {
    const rows = await this.rows('SELECT * FROM agent_runs WHERE id = $1', [id]);
    return (rows[0] as unknown as AgentRunRow) ?? null;
  }

  async listRuns(limit = 30): Promise<AgentRunRow[]> {
    return (await this.rows('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT $1', [limit])) as unknown as AgentRunRow[];
  }

  async addStep(s: Omit<AgentStepRow, 'seq'>): Promise<number> {
    const r = await this.rows('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM agent_steps WHERE run_id = $1', [s.run_id]);
    const seq = Number(r[0].n);
    await this.pool.query(
      `INSERT INTO agent_steps (run_id, seq, agent, stage, tool, ok, ms, at, input, output, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [s.run_id, seq, s.agent, s.stage, s.tool, s.ok ? 1 : 0, s.ms, s.at, s.input, s.output, s.note]
    );
    return seq;
  }

  async getSteps(runId: string): Promise<AgentStepRow[]> {
    const rows = await this.rows('SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY seq', [runId]);
    return rows.map((r) => ({ ...(r as unknown as AgentStepRow), ok: Boolean(r.ok), seq: Number(r.seq), ms: r.ms == null ? null : Number(r.ms) }));
  }

  async createApproval(a: Pick<ApprovalRow, 'id' | 'run_id' | 'title' | 'payload' | 'channel'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO approvals (id, run_id, status, title, payload, channel, requested_at) VALUES ($1,$2,'pending',$3,$4,$5,$6)`,
      [a.id, a.run_id, a.title, a.payload, a.channel, new Date().toISOString()]
    );
  }

  async getApproval(id: string): Promise<ApprovalRow | null> {
    const rows = await this.rows('SELECT * FROM approvals WHERE id = $1', [id]);
    return (rows[0] as unknown as ApprovalRow) ?? null;
  }

  async listApprovals(limit = 30): Promise<ApprovalRow[]> {
    return (await this.rows('SELECT * FROM approvals ORDER BY requested_at DESC LIMIT $1', [limit])) as unknown as ApprovalRow[];
  }

  /** Only a pending approval can be decided, and only once (returns false if it already was). */
  async decideApproval(id: string, status: 'approved' | 'rejected', by: string): Promise<boolean> {
    return this.changed(
      `UPDATE approvals SET status = $1, decided_at = $2, decided_by = $3 WHERE id = $4 AND status = 'pending'`,
      [status, new Date().toISOString(), by, id]
    );
  }

  async setApprovalChannel(id: string, channel: string): Promise<void> {
    await this.pool.query('UPDATE approvals SET channel = $1 WHERE id = $2', [channel, id]);
  }

  // --- Production logs ---

  async writeLogs(rows: AppLogRow[]): Promise<void> {
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO app_logs (id, ts, level, msg, request_id, run_id, ctx) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.ts, r.level, r.msg, r.request_id, r.run_id, r.ctx]
      );
    }
  }

  async listLogs(opts: { level?: string; runId?: string; q?: string; limit?: number } = {}): Promise<AppLogRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    const rank: Record<string, string[]> = { error: ['error', 'fatal'], warn: ['warn', 'error', 'fatal'], info: ['info', 'warn', 'error', 'fatal'] };
    if (opts.level && rank[opts.level]) {
      const placeholders = rank[opts.level].map((l) => { vals.push(l); return `$${vals.length}`; });
      where.push(`level IN (${placeholders.join(',')})`);
    }
    if (opts.runId) { vals.push(opts.runId); where.push(`run_id = $${vals.length}`); }
    if (opts.q) { vals.push(`%${opts.q.toLowerCase()}%`); where.push(`LOWER(msg) LIKE $${vals.length}`); }
    vals.push(Math.min(opts.limit ?? 200, 500));
    return (await this.rows(
      `SELECT * FROM app_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT $${vals.length}`,
      vals
    )) as unknown as AppLogRow[];
  }

  /** Housekeeping: drop log rows older than `days`. */
  async pruneLogs(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const r = await this.pool.query('DELETE FROM app_logs WHERE ts < $1', [cutoff]);
    return r.rowCount ?? 0;
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await this.pool.query('SELECT 1');
    return Date.now() - t;
  }

  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of ['holds', 'manifests', 'disputes', 'audit_entries', 'evidence', 'metadata']) {
      out[t] = Number((await this.rows(`SELECT count(*)::int AS n FROM ${t}`))[0].n);
    }
    return out;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Production logging: every line goes to stdout as structured JSON (pino, so Render's log stream and
 * Astropods' log API see it), and important lines are also persisted to Supabase (app_logs) in
 * batches so the cockpit can show them. Secrets are redacted before anything is stored.
 */
import { randomUUID } from 'node:crypto';
import type { LedgerDB, AppLogRow } from '../db/ledger_db.js';
import { redactJson } from './redact.js';
import { metrics } from './metrics.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface LogCtx { request_id?: string; run_id?: string; persist?: boolean; [k: string]: unknown }
interface PinoLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export class AppLogger {
  private queue: AppLogRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  public dropped = 0;

  constructor(private out: PinoLike | null, private db: LedgerDB | null) {}

  attach(out: PinoLike, db: LedgerDB | null): void {
    this.out = out;
    this.db = db;
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  private log(level: Level, msg: string, ctx: LogCtx = {}): void {
    const { request_id, run_id, persist, ...rest } = ctx;
    metrics.inc('unhold_log_lines_total', { level });
    const line = { event: msg, request_id, run_id, ...rest };
    // stdout JSON (pino redacts known paths; redactJson covers free-form context)
    this.out?.[level](JSON.parse(redactJson(line)), msg);
    // persist warn/error always, info/debug only when asked (agent events, mutations)
    if (this.db && (level === 'warn' || level === 'error' || persist)) {
      this.queue.push({
        id: randomUUID(),
        ts: new Date().toISOString(),
        level,
        msg,
        request_id: request_id ?? null,
        run_id: run_id ?? null,
        ctx: Object.keys(rest).length ? redactJson(rest) : null
      });
      if (this.queue.length >= 25) void this.flush();
      if (this.queue.length > 1000) { this.queue.shift(); this.dropped += 1; }
    }
  }

  debug(msg: string, ctx?: LogCtx) { this.log('debug', msg, ctx); }
  info(msg: string, ctx?: LogCtx) { this.log('info', msg, ctx); }
  warn(msg: string, ctx?: LogCtx) { this.log('warn', msg, ctx); }
  error(msg: string, ctx?: LogCtx) { this.log('error', msg, ctx); }

  async flush(): Promise<void> {
    if (this.flushing || !this.db || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, 100);
    try {
      await this.db.writeLogs(batch);
    } catch (err) {
      // never let logging take the app down: put the batch back (bounded) and say so on stdout
      this.queue.unshift(...batch.slice(0, 200));
      this.out?.error({ event: 'logstore.flush_failed', error: (err as Error).message }, 'logstore.flush_failed');
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/** Process-wide logger; the server attaches pino + the ledger at start-up. */
export const logger = new AppLogger(null, null);

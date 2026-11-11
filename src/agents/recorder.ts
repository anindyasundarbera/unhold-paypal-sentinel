/**
 * Every agent action goes through RunRecorder.step(): it times the call, opens an OpenTelemetry span,
 * writes a structured log line, bumps metrics and persists the step (with secrets redacted) so the
 * cockpit can replay exactly what each agent saw, decided and did.
 */
import type { LedgerDB } from '../db/ledger_db.js';
import { logger } from '../obs/log_store.js';
import { metrics } from '../obs/metrics.js';
import { withSpan } from '../obs/tracing.js';
import { redactJson } from '../obs/redact.js';

export type AgentName = 'supervisor' | 'cash_flow' | 'payment_guard' | 'buyer_assurance';

export interface StepSpec {
  agent: AgentName;
  stage: 'perceive' | 'reason' | 'plan' | 'ask' | 'act' | 'verify' | 'learn';
  tool?: string;
  input?: unknown;
}

export class RunRecorder {
  constructor(private db: LedgerDB, public readonly runId: string) {}

  /** Run `fn` as a recorded step. Failures are recorded and re-thrown unless `soft` is set. */
  async step<T>(spec: StepSpec, fn: () => Promise<T>, opts: { soft?: boolean; note?: (out: T) => string } = {}): Promise<T | undefined> {
    const started = Date.now();
    const name = `${spec.agent}.${spec.stage}${spec.tool ? '.' + spec.tool : ''}`;
    let output: unknown;
    let ok = true;
    let note: string | null = null;
    try {
      output = await withSpan(
        `agent.step ${name}`,
        {
          'unhold.run_id': this.runId,
          'unhold.agent': spec.agent,
          'unhold.stage': spec.stage,
          ...(spec.tool ? { 'unhold.tool': spec.tool, 'gen_ai.tool.name': spec.tool } : {})
        },
        fn
      );
      if (opts.note) note = opts.note(output as T);
      return output as T;
    } catch (err) {
      ok = false;
      note = (err as Error).message;
      output = { error: (err as Error).message };
      logger.error(`agent.step.failed ${name}`, { run_id: this.runId, error: note, persist: true });
      if (!opts.soft) throw err;
      return undefined;
    } finally {
      const ms = Date.now() - started;
      metrics.inc('unhold_agent_steps_total', { agent: spec.agent, stage: spec.stage, ok: ok ? 'true' : 'false' });
      metrics.observe('unhold_agent_step_ms', { agent: spec.agent, stage: spec.stage }, ms);
      if (spec.tool) metrics.inc('unhold_agent_tool_calls_total', { tool: spec.tool, ok: ok ? 'true' : 'false' });
      if (ok) logger.info(`agent.step ${name}`, { run_id: this.runId, ms, note, persist: true });
      try {
        await this.db.addStep({
          run_id: this.runId,
          agent: spec.agent,
          stage: spec.stage,
          tool: spec.tool ?? null,
          ok,
          ms,
          at: new Date().toISOString(),
          input: spec.input === undefined ? null : redactJson(spec.input).slice(0, 8000),
          output: redactJson(output).slice(0, 12000),
          note
        });
      } catch (e) {
        logger.error('agent.step.persist_failed', { run_id: this.runId, error: (e as Error).message });
      }
    }
  }
}

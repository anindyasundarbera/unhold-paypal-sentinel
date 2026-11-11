/**
 * Deterministic guardrails. The LLM may explain and veto, but it never decides what is allowed:
 * this policy decides which parcels can be proposed, and nothing is uploaded without a human approval.
 */

export const POLICY = {
  minConfidence: 0.8,
  maxBatch: 60,
  maxUsdPerRun: 50000,
  /** Above this many uploads the plan is flagged as a large batch in the approval request. */
  largeBatch: 5
} as const;

export interface Candidate {
  order_id: string;
  hold_id: string;
  amount: number;
  tracking_number: string;
  carrier: string;
  confidence: number;
  decision: string;
  days_sooner: number;
  uploaded: boolean;
}

export type OrderCheck = 'live' | 'no_paypal_order' | 'error';

export interface PlanItem extends Candidate {
  live: boolean;
  reason: string;
}

export interface Plan {
  mode: 'live' | 'simulated';
  items: PlanItem[];
  excluded: Array<{ order_id: string; reason: string }>;
  total_usd: number;
  avg_days_sooner: number;
  live_count: number;
  simulated_count: number;
}

export function buildPlan(
  candidates: Candidate[],
  checks: Record<string, OrderCheck>,
  mode: 'live' | 'simulated',
  skip: Array<{ order_id: string; reason: string }> = []
): Plan {
  const skipMap = new Map(skip.map((s) => [s.order_id, s.reason]));
  const items: PlanItem[] = [];
  const excluded: Plan['excluded'] = [];

  for (const c of candidates) {
    if (c.uploaded) { excluded.push({ order_id: c.order_id, reason: 'Tracking already uploaded.' }); continue; }
    if (c.confidence < POLICY.minConfidence) { excluded.push({ order_id: c.order_id, reason: `Match confidence ${Math.round(c.confidence * 100)}% is under ${POLICY.minConfidence * 100}%; needs the seller.` }); continue; }
    if (skipMap.has(c.order_id)) { excluded.push({ order_id: c.order_id, reason: `Supervisor veto: ${skipMap.get(c.order_id)}` }); continue; }
    const check = checks[c.order_id];
    const live = check === 'live';
    if (mode === 'live' && !live) {
      excluded.push({
        order_id: c.order_id,
        reason: check === 'error' ? 'PayPal could not be reached to verify this order.' : 'No real PayPal order behind this hold (seeded seller history); it cannot be uploaded live.'
      });
      continue;
    }
    items.push({ ...c, live, reason: live ? 'Verified real PayPal order; high-confidence tracking match.' : 'Simulated: seeded hold with no PayPal order.' });
  }

  const limited = items.slice(0, POLICY.maxBatch);
  for (const dropped of items.slice(POLICY.maxBatch)) excluded.push({ order_id: dropped.order_id, reason: `Over the ${POLICY.maxBatch}-parcel batch limit.` });
  const total = limited.reduce((a, i) => a + i.amount, 0);
  return {
    mode,
    items: limited,
    excluded,
    total_usd: Number(total.toFixed(2)),
    avg_days_sooner: limited.length ? Number((limited.reduce((a, i) => a + i.days_sooner, 0) / limited.length).toFixed(1)) : 0,
    live_count: limited.filter((i) => i.live).length,
    simulated_count: limited.filter((i) => !i.live).length
  };
}

export interface PolicyVerdict {
  requiresApproval: boolean;
  blocked: string | null;
  notes: string[];
}

export function evaluatePolicy(plan: Plan): PolicyVerdict {
  const notes: string[] = ['Every upload needs a human approval.'];
  if (plan.items.length === 0) return { requiresApproval: false, blocked: 'Nothing eligible to upload.', notes };
  if (plan.total_usd > POLICY.maxUsdPerRun) return { requiresApproval: true, blocked: `Plan moves $${plan.total_usd}, over the $${POLICY.maxUsdPerRun} per-run cap.`, notes };
  if (plan.items.length > POLICY.largeBatch) notes.push(`Large batch: ${plan.items.length} parcels (over ${POLICY.largeBatch}).`);
  if (plan.mode === 'simulated') notes.push('Simulated mode: no PayPal call will be made.');
  return { requiresApproval: true, blocked: null, notes };
}

/** True when every dollar figure in `text` is one of the figures the tools actually returned. */
export function numbersAreGrounded(text: string, allowed: number[]): { ok: boolean; offending: string[] } {
  const offending: string[] = [];
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!allowed.some((a) => Math.abs(a - n) < 0.011)) offending.push(m[0]);
  }
  return { ok: offending.length === 0, offending };
}

/**
 * Work queues by role. One pure function turns the ledger, matches, approvals, disputes, runs and audit
 * trail into "things that need someone", so each person lands on what is theirs instead of on every screen.
 * Roles are views, not permissions: the app has no user accounts.
 */
import type { AuditEntry, DisputeRecord, HoldRecord } from '../types/ledger.js';
import type { MatchResult } from './tracking_matcher.js';

export type Role = 'owner' | 'fulfilment' | 'support' | 'admin';
export const ROLES: Role[] = ['owner', 'fulfilment', 'support', 'admin'];

export interface WorkItem {
  id: string;
  role: Role;
  kind: string;
  /** Group heading shown in the queue. */
  kind_label: string;
  /** todo = needs someone; info = worth knowing; ok = a healthy check. */
  state: 'todo' | 'info' | 'ok';
  title: string;
  detail: string;
  amount: number | null;
  /** Deadline or the moment it happened (ISO). */
  due: string | null;
  /** Screen that handles it ('' = nothing to open) and the label of the button that opens it. */
  tab: string;
  action: string;
  hold_filter?: string;
}

export interface RoleCard {
  role: Role;
  todo: number;
  headline: string;
  sub: string;
  primary: { label: string; tab: string; hold_filter?: string } | null;
}

export interface InboxInput {
  holds: HoldRecord[];
  matches: MatchResult[];
  approvals: Array<{ id: string; title: string; status: string; requested_at: string; orders: number; total_usd: number; mode?: string }>;
  disputes: DisputeRecord[];
  runs: Array<{ id: string; status: string; goal: string; started_at: string; finished_at: string | null; summary: string | null; error: string | null }>;
  audit: AuditEntry[];
  chainValid: boolean;
  summary: { total_withheld_usd: number; open_holds_count: number; health_score: number; health_band: string; avg_days_sooner: number };
  connections: Array<{ name: string; ok: boolean; role: string }>;
  now?: Date;
}

const DAY = 86400000;
const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const words = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function buildInbox(input: InboxInput): { items: WorkItem[]; roles: Record<Role, RoleCard> } {
  const now = (input.now ?? new Date()).getTime();
  const recent = (iso: string | null | undefined, days: number) => Boolean(iso) && now - Date.parse(iso as string) <= days * DAY;
  const items: WorkItem[] = [];
  const byOrder = new Map(input.holds.map((h) => [h.order_id, h]));

  // ---------- Fulfilment ----------
  let readyUsd = 0;
  let ready = 0;
  let review = 0;
  let unmatched = 0;
  for (const m of input.matches) {
    if (!m.matched_order_id) {
      unmatched += 1;
      items.push({
        id: `unmatched:${m.tracking_number}`, role: 'fulfilment', kind: 'unmatched', kind_label: 'Parcels with no order found', state: 'todo',
        title: `${m.carrier} ${m.tracking_number}`, detail: clip(m.match_reason || 'No PayPal order matches this parcel.'),
        amount: null, due: null, tab: 'matcher', action: 'Open matcher'
      });
      continue;
    }
    const h = byOrder.get(m.matched_order_id);
    if (!h || h.status !== 'seller_has' || h.uploaded || !h.wi_date) continue;
    const needsCheck = m.confidence < 0.8 || m.decision !== 'auto';
    if (needsCheck) review += 1; else ready += 1;
    readyUsd += h.amount;
    items.push({
      id: `parcel:${m.tracking_number}`, role: 'fulfilment', kind: needsCheck ? 'review' : 'ready',
      kind_label: needsCheck ? 'Matches to check before uploading' : 'Ready to upload', state: 'todo',
      title: `${h.buyer} · ${h.item}`,
      detail: `${m.carrier} ${m.tracking_number} · matched ${Math.round(m.confidence * 100)}%${m.days_sooner ? ` · releases ${m.days_sooner} days sooner` : ''}`,
      amount: h.amount, due: h.exp_at ?? null, tab: 'matcher', action: needsCheck ? 'Check match' : 'Review and upload'
    });
  }
  const notShipped = input.holds.filter((h) => h.status === 'not_shipped');
  for (const h of notShipped) {
    items.push({
      id: `ship:${h.id}`, role: 'fulfilment', kind: 'not_shipped', kind_label: 'Paid but not shipped', state: 'todo',
      title: `${h.buyer} · ${h.item}`, detail: 'Ship it and add tracking so PayPal can release the money after delivery.',
      amount: h.amount, due: h.exp_at ?? null, tab: 'holds', action: 'Open order', hold_filter: 'not_shipped'
    });
  }
  const errorEntries = input.audit.filter((a) => /error|fail/i.test(a.result) && recent(a.timestamp, 7));
  const failedUploads = errorEntries.filter((a) => /track/i.test(a.action));
  for (const a of failedUploads) {
    items.push({
      id: `upload-failed:${a.block_id}`, role: 'fulfilment', kind: 'failed_upload', kind_label: 'Uploads that did not go through', state: 'todo',
      title: `Order ${a.target}`, detail: clip(a.detail), amount: null, due: a.timestamp, tab: 'audit', action: 'Open audit'
    });
  }

  // ---------- Owner ----------
  const pending = input.approvals.filter((a) => a.status === 'pending');
  for (const a of pending) {
    items.push({
      id: `approval:${a.id}`, role: 'owner', kind: 'decision', kind_label: 'Plans waiting for your decision', state: 'todo',
      title: a.title, detail: `${plural(a.orders, 'parcel')} · ${a.mode === 'simulated' ? 'demo data, no PayPal call' : 'real PayPal orders'} · nothing is uploaded until you decide`,
      amount: a.total_usd, due: a.requested_at, tab: 'agents', action: 'Review plan'
    });
  }
  const uploadable = ready + review;
  if (uploadable > 0) {
    items.push({
      id: 'opportunity', role: 'owner', kind: 'opportunity', kind_label: 'Money you can release sooner', state: 'todo',
      title: `${plural(uploadable, 'shipped parcel')} ${uploadable === 1 ? 'has' : 'have'} tracking PayPal has not seen`,
      detail: `Uploading it releases the money about ${input.summary.avg_days_sooner} days sooner. The agent can prepare the plan for you to approve.`,
      amount: Math.round(readyUsd * 100) / 100, due: null, tab: 'agents', action: 'Let the agent plan it'
    });
  }
  if (input.summary.health_score < 70) {
    items.push({
      id: 'health', role: 'owner', kind: 'health', kind_label: 'Account health', state: 'info',
      title: `Health ${input.summary.health_score}/100 · ${input.summary.health_band}`,
      detail: 'See what PayPal is reacting to and what would move the score.', amount: null, due: null, tab: 'cockpit', action: 'See why'
    });
  }
  for (const r of input.runs.filter((x) => x.status === 'completed' && recent(x.finished_at, 7)).slice(0, 3)) {
    items.push({
      id: `result:${r.id}`, role: 'owner', kind: 'result', kind_label: 'What the agent did this week', state: 'ok',
      title: r.goal === 'morning_brief' ? 'Morning brief' : 'Release run finished', detail: clip(r.summary || 'Finished.', 220),
      amount: null, due: r.finished_at, tab: 'agents', action: 'Open run'
    });
  }

  // ---------- Support ----------
  const open = input.disputes.filter((d) => !/RESOLVED/.test(d.status));
  for (const d of open) {
    items.push({
      id: `dispute:${d.dispute_id}`, role: 'support', kind: 'dispute', kind_label: 'Disputes to answer', state: 'todo',
      title: `${words(d.reason)} · ${d.dispute_id}`, detail: clip(d.buyer_message || ''), amount: d.amount, due: d.respond_by, tab: 'disputes', action: 'Answer'
    });
  }
  const underReview = input.holds.filter((h) => h.status === 'unapproved');
  for (const h of underReview) {
    items.push({
      id: `review:${h.id}`, role: 'support', kind: 'payment_review', kind_label: 'Payments PayPal is still reviewing', state: 'info',
      title: `${h.buyer} · ${h.item}`, detail: 'Do not ship until PayPal approves this payment.', amount: h.amount, due: h.exp_at ?? null, tab: 'holds', action: 'Open payment'
    });
  }

  // ---------- Admin ----------
  const failedRuns = input.runs.filter((r) => r.status === 'failed' && recent(r.started_at, 7));
  for (const r of failedRuns) {
    items.push({
      id: `run-failed:${r.id}`, role: 'admin', kind: 'failed_run', kind_label: 'Agent runs that failed', state: 'todo',
      title: clip(r.error || r.summary || 'The run failed.', 140), detail: 'Open the run to see the step that failed.', amount: null, due: r.started_at, tab: 'agents', action: 'Open run'
    });
  }
  const stale = pending.filter((a) => now - Date.parse(a.requested_at) > DAY);
  for (const a of stale) {
    items.push({
      id: `stale:${a.id}`, role: 'admin', kind: 'stale', kind_label: 'Plans waiting more than a day', state: 'todo',
      title: a.title, detail: 'No one has decided this plan. It blocks new agent runs until it is approved or rejected.', amount: a.total_usd, due: a.requested_at, tab: 'agents', action: 'Open plan'
    });
  }
  for (const a of errorEntries) {
    items.push({
      id: `error:${a.block_id}`, role: 'admin', kind: 'error', kind_label: 'Errors in the audit trail', state: 'todo',
      title: `${a.actor}: ${words(a.action)}`, detail: clip(a.detail), amount: null, due: a.timestamp, tab: 'audit', action: 'Open audit'
    });
  }
  const off = input.connections.filter((c) => !c.ok);
  for (const c of off) {
    items.push({
      id: `connection:${c.name}`, role: 'admin', kind: 'connection', kind_label: 'Services not connected', state: 'todo',
      title: c.name, detail: `${c.role}. Set its key in the environment to switch it on.`, amount: null, due: null, tab: '', action: ''
    });
  }
  items.push(
    input.chainValid
      ? { id: 'chain', role: 'admin', kind: 'check', kind_label: 'Health checks', state: 'ok', title: `Audit chain intact · ${plural(input.audit.length, 'entry', 'entries')}`, detail: 'Every entry still matches the hash of the one before it.', amount: null, due: null, tab: 'audit', action: 'Open audit' }
      : { id: 'chain', role: 'admin', kind: 'chain', kind_label: 'Audit chain broken', state: 'todo', title: 'An audit entry no longer matches its hash', detail: 'Something changed an entry after it was written. Open the audit screen to find where the chain breaks.', amount: null, due: null, tab: 'audit', action: 'Open audit' }
  );
  if (!off.length) {
    items.push({ id: 'connections', role: 'admin', kind: 'check', kind_label: 'Health checks', state: 'ok', title: `All ${input.connections.length} services connected`, detail: input.connections.map((c) => c.name).join(', '), amount: null, due: null, tab: '', action: '' });
  }

  // ---------- Role cards ----------
  const todo = (role: Role) => items.filter((i) => i.role === role && i.state === 'todo').length;
  const nextDispute = open.slice().sort((a, b) => Date.parse(a.respond_by) - Date.parse(b.respond_by))[0];
  const shipUsd = notShipped.reduce((a, h) => a + h.amount, 0);
  const adminTodo = todo('admin');
  const connected = input.connections.length - off.length;

  const roles: Record<Role, RoleCard> = {
    owner: {
      role: 'owner', todo: todo('owner'),
      headline: pending.length ? `${plural(pending.length, 'plan')} waiting for your decision` : uploadable ? `${usd(readyUsd)} can release about ${input.summary.avg_days_sooner} days sooner` : 'Nothing needs a decision',
      sub: `${usd(input.summary.total_withheld_usd)} held across ${plural(input.summary.open_holds_count, 'payment')}`,
      primary: pending.length ? { label: 'Review plan', tab: 'agents' } : uploadable ? { label: 'Let the agent plan it', tab: 'agents' } : null
    },
    fulfilment: {
      role: 'fulfilment', todo: todo('fulfilment'),
      headline: uploadable ? `${plural(uploadable, 'parcel')} to upload · ${usd(readyUsd)}` : notShipped.length ? `${plural(notShipped.length, 'order')} to ship` : 'No parcels are waiting',
      sub: [review ? `${review} to check first` : '', notShipped.length ? `${plural(notShipped.length, 'paid order')} not shipped (${usd(shipUsd)})` : '', unmatched ? `${unmatched} with no order` : ''].filter(Boolean).join(' · ') || 'Every shipped parcel has its tracking in PayPal',
      primary: uploadable ? { label: 'Upload tracking', tab: 'matcher' } : notShipped.length ? { label: 'See orders to ship', tab: 'holds', hold_filter: 'not_shipped' } : null
    },
    support: {
      role: 'support', todo: todo('support'),
      headline: open.length ? `${plural(open.length, 'dispute')} to answer` : 'No open disputes',
      sub: nextDispute ? `Next reply due ${new Date(nextDispute.respond_by).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : underReview.length ? `${plural(underReview.length, 'payment')} under PayPal review: do not ship yet` : 'Check a “payment received” email before you ship',
      primary: open.length ? { label: 'Answer disputes', tab: 'disputes' } : { label: 'Check a payment email', tab: 'guard' }
    },
    admin: {
      role: 'admin', todo: adminTodo,
      headline: adminTodo ? `${plural(adminTodo, 'thing')} need${adminTodo === 1 ? 's' : ''} attention` : 'Everything is running',
      sub: `${connected}/${input.connections.length} services connected · audit chain ${input.chainValid ? 'intact' : 'broken'}`,
      primary: failedRuns.length ? { label: 'Open agent runs', tab: 'agents' } : errorEntries.length || !input.chainValid ? { label: 'Open audit', tab: 'audit' } : { label: 'Open agent runs', tab: 'agents' }
    }
  };
  return { items, roles };
}

/** Tools the agents use. Each is a plain async function over the ledger / PayPal; the supervisor records every call. */
import type { LedgerDB } from '../db/ledger_db.js';
import type { PayPalClient } from '../paypal/client.js';
import type { Candidate, OrderCheck, PlanItem } from './policy.js';

export interface AgentContext {
  db: LedgerDB;
  paypal: PayPalClient;
  baseUrl: string;
}

/** Matched parcels joined to their holds: what the Cash-flow agent could upload. */
export async function getCandidates(db: LedgerDB): Promise<Candidate[]> {
  const holds = await db.getAllHolds();
  const byOrder = new Map(holds.map((h) => [h.order_id, h]));
  const out: Candidate[] = [];
  for (const m of await db.getAllManifests()) {
    if (!m.matched_order_id) continue;
    const h = byOrder.get(m.matched_order_id);
    if (!h || h.status === 'not_shipped') continue;
    const days = h.exp_at && h.wi_date ? Math.max(0, (Date.parse(h.exp_at) - Date.parse(h.wi_date)) / 86400000) : 0;
    out.push({
      order_id: h.order_id,
      hold_id: h.id,
      amount: h.amount,
      tracking_number: m.tracking_number,
      carrier: m.carrier,
      confidence: m.confidence,
      decision: m.decision,
      days_sooner: Number(days.toFixed(1)),
      uploaded: h.uploaded
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * Remembered PayPal order checks, so screens can say which holds have a real PayPal order without
 * asking PayPal on every page load. A real order stays real; "no order" is rechecked after 10 minutes.
 */
const orderCheckCache = new Map<string, { check: OrderCheck; at: number }>();
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

export function cachedOrderCheck(orderId: string): OrderCheck | undefined {
  const hit = orderCheckCache.get(orderId);
  if (!hit) return undefined;
  if (hit.check !== 'live' && Date.now() - hit.at > NEGATIVE_TTL_MS) return undefined;
  return hit.check;
}

/** Cached checks for these orders; unknown ones are looked up on PayPal, waiting at most `waitMs`. */
export async function orderChecksFor(paypal: PayPalClient, orderIds: string[], waitMs = 4000): Promise<Record<string, OrderCheck | 'unknown'>> {
  const missing = [...new Set(orderIds)].filter((id) => cachedOrderCheck(id) === undefined);
  if (missing.length) {
    const lookup = verifyOrders(paypal, missing, 10).catch(() => undefined);
    await Promise.race([lookup, new Promise((r) => setTimeout(r, waitMs))]);
  }
  return Object.fromEntries(orderIds.map((id) => [id, cachedOrderCheck(id) ?? 'unknown']));
}

/** Payment Guard: confirm each order really exists on PayPal and was captured, with bounded concurrency. */
export async function verifyOrders(paypal: PayPalClient, orderIds: string[], concurrency = 6): Promise<Record<string, OrderCheck>> {
  const result: Record<string, OrderCheck> = {};
  let i = 0;
  const worker = async () => {
    while (i < orderIds.length) {
      const id = orderIds[i++];
      try {
        const o = await paypal.getOrder(id);
        const captured = o.purchase_units?.some((u) => u.payments?.captures?.some((c) => c.status === 'COMPLETED'));
        result[id] = captured ? 'live' : 'no_paypal_order';
        orderCheckCache.set(id, { check: result[id], at: Date.now() });
      } catch (err) {
        const msg = (err as Error).message;
        result[id] = /404|RESOURCE_NOT_FOUND|INVALID_RESOURCE_ID|not found/i.test(msg) ? 'no_paypal_order' : 'error';
        if (result[id] === 'no_paypal_order') orderCheckCache.set(id, { check: result[id], at: Date.now() });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, orderIds.length) }, worker));
  return result;
}

/** VERIFY: read each uploaded order back from PayPal and confirm it carries our tracking number. */
export async function verifyTrackers(paypal: PayPalClient, items: PlanItem[]): Promise<Array<{ order_id: string; tracking_number: string; confirmed: boolean; tracker_id?: string; status?: string; error?: string }>> {
  const out = [];
  for (const it of items) {
    try {
      const o = await paypal.getOrder(it.order_id);
      const t = o.purchase_units?.[0]?.shipping?.trackers?.find((x) => x.id?.endsWith(it.tracking_number) || (x as { tracking_number?: string }).tracking_number === it.tracking_number);
      out.push({ order_id: it.order_id, tracking_number: it.tracking_number, confirmed: Boolean(t), tracker_id: t?.id, status: (t as { status?: string } | undefined)?.status });
    } catch (err) {
      out.push({ order_id: it.order_id, tracking_number: it.tracking_number, confirmed: false, error: (err as Error).message.slice(0, 160) });
    }
  }
  return out;
}

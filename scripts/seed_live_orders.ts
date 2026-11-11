/**
 * Creates REAL PayPal sandbox orders for a few held payments so the tracking upload is a real API call.
 *   npm run seed:live            (default 5 orders)   |   npm run seed:live -- 3
 * 1. creates one order per chosen hold (amount = hold amount)
 * 2. prints an approval link per order: sign in as your sandbox BUYER and approve (the script never sees the password)
 * 3. waits for each approval, captures it, then relinks the hold + manifest to the real order/capture ids
 */
import { LedgerDB } from '../src/db/ledger_db.js';
import { PayPalClient } from '../src/paypal/client.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const STATE_FILE = '.live_orders.json'; // orders already created (reused on re-run; git-ignored)

const BASE = 'https://api-m.sandbox.paypal.com';
const count = Number(process.argv[2] || 5);

async function main() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing');
  const paypal = new PayPalClient({ clientId, clientSecret, environment: 'sandbox' });
  const db = await LedgerDB.connect();

  const manifests = new Map((await db.getAllManifests()).filter((m) => m.matched_order_id).map((m) => [m.matched_order_id!, m]));
  const holds = (await db.getSpeedableHolds()).filter((h) => manifests.has(h.order_id) && !h.order_id.startsWith('LIVE-')).slice(0, count);
  if (!holds.length) throw new Error('No speedable holds with a matched manifest found.');

  const token = await paypal.getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const pending: Array<{ holdId: string; oldOrder: string; orderId: string; approve: string }> = [];

  const saved: Record<string, { orderId: string; approve: string }> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  for (const h of holds) {
    if (saved[h.id]) {
      pending.push({ holdId: h.id, oldOrder: h.order_id, orderId: saved[h.id].orderId, approve: saved[h.id].approve });
      continue;
    }
    const res = await fetch(`${BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { ...headers, 'PayPal-Request-Id': `unhold-live-${h.id}-${Date.now()}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: h.id, description: `${h.item} (Unhold live demo)`, amount: { currency_code: 'USD', value: h.amount.toFixed(2) } }],
        payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } }
      })
    });
    const text = await res.text();
    const order = (text ? JSON.parse(text) : {}) as { id?: string; links?: Array<{ rel: string; href: string }>; message?: string };
    if (!res.ok || !order.id) throw new Error(`create order failed: ${order.message || res.status}`);
    const approve = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href || '';
    saved[h.id] = { orderId: order.id, approve };
    writeFileSync(STATE_FILE, JSON.stringify(saved, null, 2));
    pending.push({ holdId: h.id, oldOrder: h.order_id, orderId: order.id, approve });
  }

  console.log(`\nCreated ${pending.length} sandbox orders. Approve each as your sandbox BUYER:\n`);
  pending.forEach((p, i) => console.log(`  ${i + 1}. ${p.orderId}\n     ${p.approve}\n`));
  console.log('Waiting for approvals (up to 20 minutes)...');

  const deadline = Date.now() + 20 * 60_000;
  const done = new Set<string>();
  const getJson = async (url: string, init?: RequestInit): Promise<Record<string, any> | null> => {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      return text ? (JSON.parse(text) as Record<string, any>) : null;
    } catch {
      return null; // transient network / empty body: try again on the next pass
    }
  };
  while (done.size < pending.length && Date.now() < deadline) {
    const fresh = { Authorization: `Bearer ${await paypal.getAccessToken().catch(() => token)}`, 'Content-Type': 'application/json' };
    for (const p of pending) {
      if (done.has(p.orderId)) continue;
      const o = await getJson(`${BASE}/v2/checkout/orders/${p.orderId}`, { headers: fresh });
      if (!o || (o.status !== 'APPROVED' && o.status !== 'COMPLETED')) continue;
      let cj = o;
      if (o.status === 'APPROVED') {
        const cap = await getJson(`${BASE}/v2/checkout/orders/${p.orderId}/capture`, { method: 'POST', headers: { ...fresh, 'PayPal-Request-Id': `unhold-cap-${p.orderId}` }, body: '{}' });
        if (!cap) continue;
        cj = cap;
      }
      const capture = cj.purchase_units?.[0]?.payments?.captures?.[0];
      const captureId = capture?.id || '';
      if (!captureId) { console.warn(`  no capture id yet for ${p.orderId}`); continue; }
      console.log(`  captured ${p.orderId}: ${capture.status} (${captureId})`);
      await db.relinkHold(p.holdId, p.orderId, captureId);
      const m = manifests.get(p.oldOrder);
      if (m) await db.updateManifest({ ...m, matched_order_id: p.orderId, match_reason: `${m.match_reason} (relinked to live sandbox order)` });
      await db.appendAuditEntry({ actor: 'Live order seeder', action: 'relink_hold', target: p.orderId, result: 'ok', detail: `hold ${p.holdId} now backed by real sandbox capture ${captureId}` });
      done.add(p.orderId);
      console.log(`  linked hold ${p.holdId} -> ${p.orderId}`);
    }
    if (done.size < pending.length) await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(`\n${done.size}/${pending.length} live orders linked.`);
  await db.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

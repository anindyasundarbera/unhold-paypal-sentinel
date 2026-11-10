/**
 * Carrier-manifest ingest. Zapier (or any low-code tool) posts parcel rows here; we normalise them,
 * store them, match them to held PayPal orders and persist the match so the seller can approve it.
 */
import type { LedgerDB } from '../db/ledger_db.js';
import type { CarrierManifestRecord } from '../types/ledger.js';
import { matchAllManifests } from './tracking_matcher.js';

export interface IngestRow {
  tracking_number: string;
  carrier: string;
  recipient_name?: string;
  street_address?: string;
  zip_code?: string;
  label_printed_at?: string;
  order_id?: string;
  source_file?: string;
}

const CARRIERS: Record<string, CarrierManifestRecord['carrier']> = {
  ups: 'UPS', usps: 'USPS', fedex: 'FedEx', 'fed ex': 'FedEx', dhl: 'DHL'
};

const pick = (o: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

/** Accepts {rows:[...]}, {csv:"..."}, an array, or one flat object (what a Zap sends). */
export function parseIngestPayload(body: unknown): { rows: IngestRow[]; rejected: Array<{ row: unknown; reason: string }> } {
  const rejected: Array<{ row: unknown; reason: string }> = [];
  let raw: Array<Record<string, unknown>> = [];
  const b = (body ?? {}) as Record<string, unknown>;

  if (Array.isArray(body)) raw = body as Array<Record<string, unknown>>;
  else if (Array.isArray(b.rows)) raw = b.rows as Array<Record<string, unknown>>;
  else if (typeof b.csv === 'string') raw = parseCsv(b.csv);
  else if (Object.keys(b).length) raw = [b];

  const rows: IngestRow[] = [];
  for (const r of raw.slice(0, 500)) {
    const tracking = pick(r, 'tracking_number', 'tracking', 'trackingNumber', 'tracking_no').replace(/\s+/g, '');
    const carrierRaw = pick(r, 'carrier', 'courier', 'service').toLowerCase();
    const carrier = CARRIERS[carrierRaw] || CARRIERS[carrierRaw.replace(/[^a-z]/g, '')];
    if (!tracking) { rejected.push({ row: r, reason: 'missing tracking number' }); continue; }
    if (!carrier) { rejected.push({ row: r, reason: `unknown carrier "${carrierRaw}" (use UPS, USPS, FedEx or DHL)` }); continue; }
    rows.push({
      tracking_number: tracking,
      carrier,
      recipient_name: pick(r, 'recipient_name', 'name', 'recipient', 'ship_to'),
      street_address: pick(r, 'street_address', 'address', 'street'),
      zip_code: pick(r, 'zip_code', 'zip', 'postal_code'),
      label_printed_at: pick(r, 'label_printed_at', 'shipped_at', 'date') || new Date().toISOString(),
      order_id: pick(r, 'order_id', 'paypal_order_id', 'order'),
      source_file: pick(r, 'source_file', 'source') || 'zapier'
    });
  }
  return { rows, rejected };
}

function parseCsv(text: string): Array<Record<string, unknown>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

export interface IngestReport {
  received: number;
  stored: number;
  rejected: Array<{ row: unknown; reason: string }>;
  matched: number;
  auto_approved: number;
  needs_review: number;
  unmatched: number;
  items: Array<{ tracking_number: string; matched_order_id: string | null; confidence: number; decision: string; reason: string }>;
}

export async function ingestManifests(db: LedgerDB, body: unknown): Promise<IngestReport> {
  const { rows, rejected } = parseIngestPayload(body);
  const records: CarrierManifestRecord[] = rows.map((r) => ({
    tracking_number: r.tracking_number,
    carrier: r.carrier as CarrierManifestRecord['carrier'],
    source_file: r.source_file || 'zapier',
    recipient_name: r.recipient_name || '',
    street_address: r.street_address || '',
    zip_code: r.zip_code || '',
    label_printed_at: r.label_printed_at || new Date().toISOString(),
    matched_order_id: r.order_id || null,
    confidence: r.order_id ? 1 : 0,
    match_method: 'id',
    match_reason: r.order_id ? 'PayPal order id supplied in the manifest row.' : '',
    decision: 'none'
  }));

  // Match only holds that still need tracking, and persist each result.
  const holds = (await db.getAllHolds()).filter((h) => !h.uploaded);
  const result = matchAllManifests(records, holds);
  const byTracking = new Map(result.matches.map((m) => [m.tracking_number, m]));

  const items: IngestReport['items'] = [];
  for (const rec of records) {
    const m = byTracking.get(rec.tracking_number);
    const stored: CarrierManifestRecord = m && m.matched_order_id
      ? { ...rec, matched_order_id: m.matched_order_id, confidence: m.confidence, match_method: m.match_method, match_reason: m.match_reason, decision: m.decision }
      : { ...rec, matched_order_id: null, confidence: 0, decision: 'ask', match_reason: 'No held order matched this parcel.' };
    await db.insertManifest(stored);
    items.push({
      tracking_number: stored.tracking_number,
      matched_order_id: stored.matched_order_id,
      confidence: stored.confidence,
      decision: stored.decision,
      reason: stored.match_reason
    });
  }

  await db.appendAuditEntry({
    actor: 'Manifest Ingest (Zapier)',
    action: 'POST /api/manifests/ingest',
    target: `${records.length} parcels`,
    result: rejected.length ? 'partial' : 'ok',
    detail: `stored ${records.length}, matched ${result.matched_count}, auto ${result.auto_count}, review ${result.review_count}, rejected ${rejected.length}`
  });

  return {
    received: rows.length + rejected.length,
    stored: records.length,
    rejected,
    matched: result.matched_count,
    auto_approved: result.auto_count,
    needs_review: result.review_count,
    unmatched: result.unmatched_count,
    items
  };
}

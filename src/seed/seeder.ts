import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LedgerDB } from '../db/ledger_db.js';
import type { HoldRecord, EvidenceRecord, CarrierManifestRecord } from '../types/ledger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RawSeedData {
  as_of: string;
  summary: Record<string, unknown>;
  holds: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  sales: Array<{ d: string; v: number }>;
}

export function loadSeedData(): RawSeedData {
  const seedPath = join(__dirname, 'unhold_seed.json');
  const content = readFileSync(seedPath, 'utf8');
  return JSON.parse(content) as RawSeedData;
}

const FIRST: Record<string, string> = {
  A: 'Adaeze',
  M: 'Marco',
  J: 'James',
  S: 'Sakura',
  L: 'Lucas',
  R: 'Rania',
  K: 'Katarina',
  D: 'Daniel',
  P: 'Priya',
  E: 'Erik',
  T: 'Thomas',
  H: 'Hana',
  N: 'Nadia',
  G: 'Grace',
  I: 'Ivan',
  C: 'Camille'
};

const NICK: Record<string, string> = {
  Adaeze: 'Ada',
  Marco: 'Marc',
  James: 'Jim',
  Sakura: 'Saku',
  Lucas: 'Luke',
  Rania: 'Rani',
  Katarina: 'Kat',
  Daniel: 'Dan',
  Priya: 'Pri',
  Erik: 'Rick',
  Thomas: 'Tom',
  Hana: 'Hanna',
  Nadia: 'Nadya',
  Grace: 'Gracie',
  Ivan: 'Vanya',
  Camille: 'Cami'
};

const STREETS = [
  'Elm Street',
  'Harbour Road',
  'Maple Avenue',
  'Station Road',
  'Linden Way',
  'Cedar Lane',
  'Park Row',
  'Mill Street'
];

function hnum(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) {
    x = (x * 31 + s.charCodeAt(i)) >>> 0;
  }
  return x;
}

function fullName(buyer: string): string {
  const parts = buyer.split('. ');
  const first = FIRST[parts[0]] || parts[0];
  return `${first} ${parts[1] || ''}`.trim();
}

function getStreet(holdId: string): string {
  const k = hnum(holdId);
  return `${10 + (k % 180)} ${STREETS[k % STREETS.length]}`;
}

function getZip(txnId: string): string {
  const k = hnum(txnId);
  return String(10000 + (k % 89999));
}

function getCarrierSource(carrier: string | null): string {
  if (carrier === 'UPS') return 'ups_manifest_nov8.csv';
  if (carrier === 'USPS') return 'usps_export.csv';
  return 'fedex_dhl_pickups.csv';
}

export function seedLedger(db: LedgerDB): {
  holdsCount: number;
  evidenceCount: number;
  manifestsCount: number;
} {
  const data = loadSeedData();

  // 1. Seed Holds
  for (const raw of data.holds) {
    const hold: HoldRecord = {
      id: raw.id as string,
      txn_id: raw.txn as string,
      order_id: raw.order as string,
      code: raw.code as string,
      kind: raw.kind as 'PAYMENT_HOLD' | 'RESERVE',
      amount: Number(raw.amount),
      held_at: raw.held as string,
      exp_at: (raw.exp as string) || null,
      conf: raw.conf as 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE',
      rule: raw.rule as string,
      action: (raw.action as string) || null,
      reason: raw.reason as string,
      status: raw.status as 'in_paypal' | 'seller_has' | 'not_shipped' | 'reserve' | 'unapproved',
      carrier: (raw.carrier as string) || null,
      tracking_number: (raw.trk as string) || null,
      shipped_at: (raw.shipped as string) || null,
      delivered_at: (raw.delivered as string) || null,
      wi_date: (raw.wi as string) || null,
      buyer: raw.buyer as string,
      item: raw.item as string,
      uploaded: Boolean(raw.uploaded)
    };
    db.insertHold(hold);
  }

  // 2. Seed Evidence
  for (const raw of data.evidence) {
    const ev: EvidenceRecord = {
      id: raw.id as string,
      code: raw.code as string,
      at: raw.at as string,
      amount: Number(raw.amount),
      ref: (raw.ref as string) || null
    };
    db.insertEvidence(ev);
  }

  // 3. Synthesize and Seed Carrier Manifests (from seller_has untracked holds)
  const speedable = db.getSpeedableHolds().sort((a, b) => (a.id < b.id ? -1 : 1));
  let manifestsCount = 0;

  speedable.forEach((h, i) => {
    const name = fullName(h.buyer);
    const parts = name.split(' ');
    const first = parts[0];
    const last = parts.slice(1).join(' ');
    const street = getStreet(h.id);
    const zip = getZip(h.txn_id);

    let matchMethod: 'id' | 'rule' | 'ai' | 'ask' = 'id';
    let conf = 1.0;
    let why = 'PayPal order id is in the shop export.';
    let decision: 'auto' | 'you' | 'none' | 'ask' = 'auto';
    let sourceFile = 'shop_export.csv';
    let labelName = name;
    let labelAddress = `${street}, ${zip}`;

    if (i >= 30 && i < 36) {
      matchMethod = 'rule';
      sourceFile = getCarrierSource(h.carrier);
      conf = [0.99, 0.98, 0.97][i % 3];
      labelName = i % 2 ? `${last}, ${first}` : `${first} ${last}`.toUpperCase();
      why = `Same name ${i % 2 ? 'in reverse order' : 'in capitals'}, same ZIP, shipped within 2 days of payment.`;
    } else if (i >= 36 && i < 40) {
      matchMethod = 'ai';
      sourceFile = getCarrierSource(h.carrier);
      const k = i - 36;
      if (k === 0) {
        labelName = `${NICK[first] || first} ${last}`;
        conf = 0.93;
        why = `"${NICK[first] || first}" is a common short form of "${first}". Same street and ZIP, shipped a day after payment.`;
      } else if (k === 1) {
        labelName = `${first} ${last.slice(0, -2)}${last.slice(-1)}`;
        conf = 0.88;
        why = `Surname has a typo ("${last.slice(0, -2)}${last.slice(-1)}"). Street, ZIP and timing all match.`;
      } else if (k === 2) {
        labelName = 'Flat 4B (no name)';
        labelAddress = `Flat 4B, ${street}, ${zip}`;
        conf = 0.86;
        why = 'No name on the label, but flat number and street match, and only one payment shipped there this week.';
      } else if (k === 3) {
        labelName = `${first.charAt(0)}. and K. ${last}`;
        conf = 0.91;
        why = 'Two names on the label; one matches the payer, and the address and date match.';
      }
    } else if (i >= 40) {
      matchMethod = 'ask';
      sourceFile = 'ups_manifest_nov8.csv';
      decision = 'ask';
      labelName = 'Reception (no name)';
      labelAddress = 'Fairview Tower, 221 Elm Street, 43215';
      conf = i === 40 ? 0.62 : 0.38;
      why = 'Two payments ship to Fairview Tower and neither label has a name. Below 0.80 confidence, so human decides.';
    }

    const manifestRecord: CarrierManifestRecord = {
      tracking_number: h.tracking_number || `TRK-${h.id.slice(0, 10)}`,
      carrier: (h.carrier as 'UPS' | 'USPS' | 'FedEx' | 'DHL') || 'UPS',
      source_file: sourceFile,
      recipient_name: labelName,
      street_address: labelAddress,
      zip_code: zip,
      label_printed_at: h.shipped_at || h.held_at,
      matched_order_id: h.order_id,
      confidence: conf,
      match_method: matchMethod,
      match_reason: why,
      decision
    };

    db.insertManifest(manifestRecord);
    manifestsCount++;
  });

  // 4. Seed Initial Audit Entries
  db.appendAuditEntry({
    actor: 'System',
    action: 'sync_transactions',
    target: 'Transaction Search, 2 windows',
    result: '200',
    detail: 'sandbox rows plus simulated hold history'
  });

  db.appendAuditEntry({
    actor: 'System',
    action: 'get_balances',
    target: 'USD',
    result: '200',
    detail: 'withheld 0.00 in sandbox'
  });

  db.appendAuditEntry({
    actor: 'Engine',
    action: 'reconcile_ledger',
    target: 'USD',
    result: 'match',
    detail: 'ledger 5,235.24 = withheld (simulated), difference $0.00'
  });

  // 5. Seed Initial Demo Dispute for A2A Negotiation
  if (!db.getDispute('DISP-SEED-001')) {
    db.insertDispute({
      dispute_id: 'DISP-SEED-001',
      order_id: 'ORD-789012',
      capture_id: 'CAP-789012',
      amount: 249.00,
      currency: 'USD',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      reason: 'ITEM_NOT_RECEIVED',
      buyer_message: 'Package has not arrived. Please refund or confirm where it was left.',
      respond_by: new Date(Date.now() + 864000000).toISOString(),
      created_at: new Date().toISOString()
    });
  }

  return {
    holdsCount: data.holds.length,
    evidenceCount: data.evidence.length,
    manifestsCount
  };
}

/**
 * Unhold Ledger & Domain Types
 */

export interface HoldRecord {
  id: string; // e.g. "ZBUGBH5UYAOGIFL5A"
  txn_id: string; // PayPal transaction ID (T0006)
  order_id: string; // PayPal order ID
  code: string; // "T2107" (Hold) or "T2103" (Reserve)
  kind: 'PAYMENT_HOLD' | 'RESERVE';
  amount: number;
  held_at: string; // ISO 8601
  exp_at: string | null; // Expected release date ISO 8601
  conf: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  rule: string; // e.g. "delivered+24h", "no_tracking", "in_transit"
  action: string | null; // e.g. "ADD_TRACKING", "ENTER_RESERVE_TERMS"
  reason: string;
  status: 'in_paypal' | 'seller_has' | 'not_shipped' | 'reserve' | 'unapproved';
  carrier: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  wi_date: string | null; // "What-if" expedited release date
  buyer: string;
  item: string;
  uploaded: boolean;
}

export interface CarrierManifestRecord {
  tracking_number: string;
  carrier: 'UPS' | 'USPS' | 'FedEx' | 'DHL';
  source_file: string; // e.g. "ups_manifest_nov8.csv"
  recipient_name: string;
  street_address: string;
  zip_code: string;
  label_printed_at: string;
  matched_order_id: string | null;
  confidence: number;
  match_method: 'id' | 'rule' | 'ai' | 'ask';
  match_reason: string;
  decision: 'auto' | 'you' | 'none' | 'ask';
}

export interface DisputeRecord {
  dispute_id: string;
  order_id: string;
  capture_id: string;
  amount: number;
  currency: string;
  status: string; // e.g. "WAITING_FOR_SELLER_RESPONSE", "RESOLVED"
  reason: string; // e.g. "ITEM_NOT_RECEIVED"
  buyer_message: string;
  respond_by: string;
  created_at: string;
  signed_sd_jwt?: string;
}

export interface AuditEntry {
  block_id: number;
  timestamp: string;
  actor: string; // e.g. "Cash-flow agent", "Buyer Assurance agent", "Seller", "System"
  action: string; // e.g. "add_tracking", "sign_delivery_proof", "preflight"
  target: string;
  request_id?: string;
  result: string; // e.g. "201", "block", "match"
  detail: string;
  prev_hash: string;
  hash: string;
}

export interface HoldSummary {
  as_of: string;
  total_withheld_usd: number;
  open_holds_count: number;
  health_score: number;
  health_band: string;
  speedable_holds_count: number;
  speedable_amount_usd: number;
  avg_days_sooner: number;
}

export interface EvidenceRecord {
  id: string;
  code: string;
  at: string;
  amount: number;
  ref: string | null;
}

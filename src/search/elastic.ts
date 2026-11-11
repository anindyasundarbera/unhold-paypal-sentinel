/**
 * Elastic Cloud Serverless: semantic + keyword search over the ledger (holds, audit chain, disputes,
 * evidence). Used for "find the order about the brass candle" style questions and evidence lookup.
 * The index is derived data; Supabase stays the system of record.
 */
import type { LedgerDB } from '../db/ledger_db.js';

const INDEX = 'unhold-ledger';

export function elasticConfigured(): boolean {
  return Boolean(process.env.ELASTIC_URL && process.env.ELASTIC_API_KEY);
}

async function es<T = any>(path: string, init: RequestInit = {}, timeoutMs = 45000): Promise<T> {
  const base = (process.env.ELASTIC_URL || '').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `ApiKey ${process.env.ELASTIC_API_KEY}`, 'Content-Type': 'application/json', ...((init.headers as Record<string, string>) || {}) },
      signal: controller.signal
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`Elastic ${res.status}: ${(json?.error?.reason || text).slice(0, 200)}`);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface LedgerDoc {
  id: string;
  kind: 'hold' | 'audit' | 'dispute' | 'evidence';
  ref: string;
  title: string;
  text: string;
  amount?: number;
  status?: string;
}

export async function buildDocs(db: LedgerDB): Promise<LedgerDoc[]> {
  const docs: LedgerDoc[] = [];
  for (const h of await db.getAllHolds()) {
    docs.push({
      id: `hold-${h.id}`, kind: 'hold', ref: h.order_id, amount: h.amount, status: h.status,
      title: `${h.buyer} · ${h.item} · ${h.order_id}`,
      text: `Held payment of $${h.amount.toFixed(2)} from ${h.buyer} for ${h.item}. State ${h.status}. ${h.carrier ? `Carrier ${h.carrier} tracking ${h.tracking_number || 'missing'}.` : 'No carrier yet.'} ${h.reason} Release rule: ${h.rule}.`
    });
  }
  for (const a of await db.getAuditChain()) {
    docs.push({ id: `audit-${a.block_id}`, kind: 'audit', ref: String(a.block_id), title: `Audit #${a.block_id} ${a.action}`, text: `${a.actor} ${a.action} on ${a.target}: ${a.result}. ${a.detail}` });
  }
  for (const d of await db.getAllDisputes()) {
    docs.push({ id: `dispute-${d.dispute_id}`, kind: 'dispute', ref: d.order_id, amount: d.amount, status: d.status, title: `Dispute ${d.dispute_id}`, text: `${d.reason} dispute for order ${d.order_id}, $${d.amount}. Buyer said: ${d.buyer_message}` });
  }
  for (const e of await db.getAllEvidence()) {
    docs.push({ id: `evidence-${e.id}`, kind: 'evidence', ref: e.ref || e.id, amount: e.amount, title: `Evidence ${e.code} ${e.id}`, text: `PayPal transaction ${e.id} code ${e.code} on ${e.at} for $${e.amount}${e.ref ? ` referencing ${e.ref}` : ''}.` });
  }
  return docs;
}

/** Rebuild the index from the ledger. Returns how many documents were indexed. */
export async function reindex(db: LedgerDB): Promise<{ indexed: number; ms: number }> {
  const started = Date.now();
  const docs = await buildDocs(db);
  try { await es(`/${INDEX}`, { method: 'DELETE' }); } catch { /* first run */ }
  await es(`/${INDEX}`, {
    method: 'PUT',
    body: JSON.stringify({
      mappings: {
        properties: {
          kind: { type: 'keyword' }, ref: { type: 'keyword' }, status: { type: 'keyword' }, amount: { type: 'double' },
          title: { type: 'text' }, text: { type: 'semantic_text' }
        }
      }
    })
  });
  const lines: string[] = [];
  for (const d of docs) {
    lines.push(JSON.stringify({ index: { _index: INDEX, _id: d.id } }));
    const { id, ...src } = d; void id;
    lines.push(JSON.stringify(src));
  }
  // Index in chunks so the semantic_text inference calls stay within request limits.
  for (let i = 0; i < lines.length; i += 200) {
    const res = await es<{ errors?: boolean; items?: Array<Record<string, { error?: { reason: string } }>> }>(
      '/_bulk?refresh=wait_for',
      { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: lines.slice(i, i + 200).join('\n') + '\n' },
      120000
    );
    if (res.errors) {
      const bad = res.items?.map((it) => Object.values(it)[0].error?.reason).find(Boolean);
      throw new Error(`Elastic bulk indexing failed: ${bad}`);
    }
  }
  return { indexed: docs.length, ms: Date.now() - started };
}

export interface SearchHit {
  kind: string;
  ref: string;
  title: string;
  snippet: string;
  amount?: number;
  status?: string;
  score: number;
}

export async function search(q: string, size = 12, kind?: string): Promise<{ total: number; took: number; hits: SearchHit[] }> {
  const filter = kind ? [{ term: { kind } }] : [];
  const res = await es<{ took: number; hits: { total: { value: number }; hits: Array<{ _score: number; _source: any }> } }>(`/${INDEX}/_search`, {
    method: 'POST',
    body: JSON.stringify({
      size,
      query: {
        bool: {
          should: [
            { semantic: { field: 'text', query: q } },
            { match: { title: { query: q, boost: 0.6 } } }
          ],
          minimum_should_match: 1,
          filter
        }
      },
      _source: ['kind', 'ref', 'title', 'amount', 'status']
    })
  });
  // The semantic_text body is not returned in _source; rebuild a snippet from the title/status.
  return {
    total: res.hits.total.value,
    took: res.took,
    hits: res.hits.hits.map((h) => ({
      kind: h._source.kind, ref: h._source.ref, title: h._source.title, snippet: `${h._source.kind} · ${h._source.status || 'n/a'}`,
      amount: h._source.amount, status: h._source.status, score: Number(h._score.toFixed(3))
    }))
  };
}

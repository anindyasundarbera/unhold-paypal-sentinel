/**
 * "Ask the grid": turns a plain-English question into AG Grid state
 * (filter model, sort, row grouping) using the LLM. The grid applies the
 * returned state; the model never sees or changes ledger data.
 */
import { chat, extractJson } from './llm.js';

export interface GridColumnSpec {
  field: string;
  headerName?: string;
  type?: 'text' | 'number' | 'date' | 'set';
  values?: string[];
}

export interface GridQueryResult {
  filterModel: Record<string, unknown>;
  sort: Array<{ colId: string; sort: 'asc' | 'desc' }>;
  rowGroup: string[];
  explanation: string;
  model: string;
  ms: number;
}

const ALLOWED_FILTER_TYPES = new Set([
  'equals', 'notEqual', 'contains', 'notContains', 'startsWith', 'endsWith', 'blank', 'notBlank',
  'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'inRange'
]);

export async function buildGridQuery(question: string, columns: GridColumnSpec[]): Promise<GridQueryResult> {
  const fields = new Set(columns.map((c) => c.field));
  const schema = columns
    .map((c) => `- ${c.field} (${c.type || 'text'})${c.headerName ? ` "${c.headerName}"` : ''}${c.values?.length ? ` values: ${c.values.slice(0, 12).join(', ')}` : ''}`)
    .join('\n');

  const system = `You convert a merchant's question about their held PayPal payments into AG Grid state.
Columns:
${schema}

Reply with ONLY a JSON object:
{"filterModel": {...}, "sort": [{"colId": "...", "sort": "asc|desc"}], "rowGroup": ["field"], "explanation": "one short sentence"}
filterModel uses AG Grid formats:
- text: {"filterType":"text","type":"contains|equals|startsWith|notBlank|blank","filter":"value"}
- number: {"filterType":"number","type":"greaterThan|lessThan|equals|inRange","filter":10,"filterTo":20}
- date: {"filterType":"date","type":"lessThan|greaterThan|inRange","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD"}
- set: {"filterType":"set","values":["a","b"]}
Only use the listed fields. Use empty objects/arrays when not needed.`;

  const reply = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: question.slice(0, 500) }
    ],
    { timeoutMs: 30000 }
  );
  const raw = extractJson<Partial<GridQueryResult>>(reply.text);

  // Validate: keep only known fields and filter shapes, so a bad reply cannot break the grid.
  const filterModel: Record<string, unknown> = {};
  for (const [field, f] of Object.entries(raw.filterModel || {})) {
    if (!fields.has(field) || !f || typeof f !== 'object') continue;
    const fm = f as Record<string, unknown>;
    if (fm.filterType === 'set' && Array.isArray(fm.values)) {
      filterModel[field] = { filterType: 'set', values: fm.values.map(String) };
    } else if (typeof fm.type === 'string' && ALLOWED_FILTER_TYPES.has(fm.type)) {
      filterModel[field] = fm;
    }
  }
  const sort = (raw.sort || [])
    .filter((s) => s && fields.has(s.colId) && (s.sort === 'asc' || s.sort === 'desc'))
    .slice(0, 3);
  const rowGroup = (raw.rowGroup || []).filter((g) => fields.has(g)).slice(0, 2);

  return {
    filterModel,
    sort,
    rowGroup,
    explanation: String(raw.explanation || 'Applied your question to the grid.').slice(0, 300),
    model: reply.model,
    ms: reply.ms
  };
}

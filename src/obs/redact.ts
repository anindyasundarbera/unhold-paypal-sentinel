/** Secret redaction used for every log line and every persisted agent step. */

const SENSITIVE_KEY = /(secret|password|passwd|token|api[_-]?key|authorization|cookie|signature|private[_-]?key|client[_-]?secret|bearer)/i;
// long opaque strings that look like credentials (PayPal/Kernel/Elastic/Channel3 keys, JWTs)
const KEYLIKE_VALUE = /^(sk[-_][A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}|[A-Za-z0-9+/=_-]{40,})$/;

export function redactValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (KEYLIKE_VALUE.test(value)) return '[redacted]';
    return value.length > 2000 ? value.slice(0, 2000) + '…[truncated]' : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v, depth + 1);
  }
  return out;
}

export function redactJson(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return '"[unserialisable]"';
  }
}

/** Pino `redact` paths for HTTP headers and common secret-bearing fields. */
export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-unhold-secret"]',
  'req.headers["paypal-auth-algo"]',
  'req.headers["paypal-transmission-sig"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.client_secret',
  '*.api_key',
  '*.apiKey',
  '*.secret',
  '*.token'
];

/** Tiny in-process metrics registry, exposed at GET /metrics in Prometheus text format. */

type Labels = Record<string, string | number>;
const counters = new Map<string, number>();
const histos = new Map<string, { count: number; sum: number; buckets: number[] }>();
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const started = Date.now();

const key = (name: string, labels: Labels = {}) =>
  name + (Object.keys(labels).length ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(',') + '}' : '');

export const metrics = {
  inc(name: string, labels: Labels = {}, by = 1) {
    const k = key(name, labels);
    counters.set(k, (counters.get(k) || 0) + by);
  },
  observe(name: string, labels: Labels, ms: number) {
    const k = key(name, labels);
    const h = histos.get(k) || { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    h.count += 1;
    h.sum += ms;
    BUCKETS.forEach((b, i) => { if (ms <= b) h.buckets[i] += 1; });
    histos.set(k, h);
  },
  render(): string {
    const lines: string[] = [];
    lines.push('# TYPE unhold_uptime_seconds gauge', `unhold_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`);
    lines.push('# TYPE unhold_process_memory_bytes gauge', `unhold_process_memory_bytes ${process.memoryUsage().rss}`);
    for (const [k, v] of counters) lines.push(`${k} ${v}`);
    for (const [k, h] of histos) {
      const [name, lab] = k.includes('{') ? [k.slice(0, k.indexOf('{')), k.slice(k.indexOf('{') + 1, -1)] : [k, ''];
      const sep = lab ? lab + ',' : '';
      BUCKETS.forEach((b, i) => lines.push(`${name}_bucket{${sep}le="${b}"} ${h.buckets[i]}`));
      lines.push(`${name}_bucket{${sep}le="+Inf"} ${h.count}`, `${name}_sum{${lab}} ${h.sum}`, `${name}_count{${lab}} ${h.count}`);
    }
    return lines.join('\n') + '\n';
  },
  snapshot() {
    return { counters: Object.fromEntries(counters), uptime_s: Math.round((Date.now() - started) / 1000) };
  }
};

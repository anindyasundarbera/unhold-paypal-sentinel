/**
 * OpenTelemetry tracing. Switches on when OTEL_EXPORTER_OTLP_ENDPOINT is set, which is exactly what
 * Astropods injects into a deployed agent (together with ASTRO_AGENT_NAME / ASTRO_AGENT_BUILD), so a
 * deployed Unhold agent shows up in the Astropods monitor with every agent step and tool call as a span.
 * With no endpoint everything here is a cheap no-op.
 */
import { trace, SpanStatusCode, type Span, type Attributes } from '@opentelemetry/api';

let sdk: { shutdown(): Promise<void> } | null = null;
export let tracingEnabled = false;

export async function startTracing(): Promise<boolean> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdk) return tracingEnabled;
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions');
    const node = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.ASTRO_AGENT_NAME ?? 'unhold-api',
        [ATTR_SERVICE_VERSION]: process.env.ASTRO_AGENT_BUILD ?? process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'dev'
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` })
    });
    node.start();
    sdk = node;
    tracingEnabled = true;
    console.log(`[TRACING] OpenTelemetry exporting to ${endpoint}`);
  } catch (err) {
    console.warn(`[TRACING] could not start OpenTelemetry: ${(err as Error).message}`);
  }
  return tracingEnabled;
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
}

const tracer = () => trace.getTracer('unhold');

/** Run `fn` inside a span; records errors and sets the span status. */
export async function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function currentTraceId(): string | null {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id && id !== '00000000000000000000000000000000' ? id : null;
}

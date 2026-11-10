// Import this first in every test file. Tests must never use a developer's real credentials
// (LLM, Zapier, Elastic, Kernel, PayPal...), so mark the process as a test before anything else loads.
process.env.NODE_ENV = 'test';
for (const k of [
  'ZAPIER_WEBHOOK_URL', 'ZAPIER_MCP_URL', 'ZAPIER_MCP_KEY', 'ELASTIC_URL', 'ELASTIC_API_KEY', 'KERNEL_API_KEY',
  'CHANNEL3_API_KEY', 'LLM_API_KEY', 'ASTROPODS_API_KEY', 'DATABASE_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT'
]) {
  delete process.env[k];
}

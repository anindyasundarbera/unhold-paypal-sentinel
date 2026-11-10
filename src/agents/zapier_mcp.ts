/**
 * Zapier MCP client. The agent uses Zapier's hosted MCP server as its "hands" for the human channel
 * (post the approval request to Slack, and anything else a seller connects), so no per-app integration
 * code lives in Unhold. Configure with ZAPIER_MCP_URL and ZAPIER_MCP_KEY (from the Zapier MCP server's
 * Connect tab) and SLACK_APPROVAL_CHANNEL.
 */

export function zapierMcpConfigured(): boolean {
  return Boolean(process.env.ZAPIER_MCP_URL && process.env.ZAPIER_MCP_KEY);
}

let sessionId: string | null = null;
let rpcId = 1;

async function rpc(method: string, params: unknown, expectResponse = true): Promise<any> {
  const res = await fetch(process.env.ZAPIER_MCP_URL as string, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZAPIER_MCP_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(expectResponse ? { jsonrpc: '2.0', id: rpcId++, method, params } : { jsonrpc: '2.0', method, params }),
    signal: AbortSignal.timeout(30000)
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (!res.ok) throw new Error(`Zapier MCP HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  if (!expectResponse) return null;
  const text = await res.text();
  const body = res.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() || '{}'
    : text;
  const json = JSON.parse(body);
  if (json.error) throw new Error(`Zapier MCP: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

async function ensureSession(): Promise<void> {
  if (sessionId) return;
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unhold-agent', version: '1.0' } });
  await rpc('notifications/initialized', {}, false);
}

export async function listZapierTools(): Promise<Array<{ name: string; description?: string }>> {
  await ensureSession();
  return (await rpc('tools/list', {})).tools || [];
}

export async function callZapierTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  await ensureSession();
  const r = await rpc('tools/call', { name, arguments: args });
  if (r?.isError) throw new Error(`Zapier tool ${name} failed: ${JSON.stringify(r.content).slice(0, 200)}`);
  return r;
}

/** Post a message to Slack through whichever Slack "send message" tool the Zapier MCP server exposes. */
export async function postToSlack(text: string, channel = process.env.SLACK_APPROVAL_CHANNEL): Promise<{ tool: string }> {
  if (!channel) throw new Error('SLACK_APPROVAL_CHANNEL is not set.');
  const tools = await listZapierTools();
  const tool = tools.find((t) => /slack/i.test(t.name) && /(send|post).*(channel|message)/i.test(t.name)) || tools.find((t) => /slack/i.test(t.name) && /message/i.test(t.name));
  if (!tool) throw new Error('No Slack "send message" tool is enabled on the Zapier MCP server.');
  await callZapierTool(tool.name, { instructions: `Send this message to the Slack channel ${channel}.`, channel, text, message: text });
  return { tool: tool.name };
}

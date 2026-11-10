import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LedgerDB } from './db/ledger_db.js';
import { seedLedger } from './seed/seeder.js';
import { PayPalClient } from './paypal/client.js';
import { generateWhyHeldReport } from './engine/why_held.js';
import { buildHoldWaterfall } from './engine/waterfall.js';
import { simulateCashReleases, planCashGoal } from './engine/monte_carlo.js';
import { matchAllManifests } from './engine/tracking_matcher.js';
import { executeBatchTrackingUpload, type BatchUploadOptions } from './engine/batch_uploader.js';
import { analyzePromptInjection } from './engine/prompt_guard.js';
import { issueDeliverySDJWT, verifyDeliverySDJWT, type DeliveryProofPayload } from './engine/sdjwt.js';
import { runAutonomousDisputeSettlement, type SettlementOptions } from './engine/a2a_negotiator.js';
import {
  parsePaymentNotification,
  verifyPaymentAuthenticity,
  auditPreFlightSellerProtection,
  type PreFlightAuditParams
} from './engine/payment_guard.js';
import {
  dispatchZapierEvent,
  getAstropodsPodSpec,
  queryAstropodsGateway,
  type ZapierEventPayload
} from './engine/lowcode_dispatcher.js';
import { ingestManifests } from './engine/manifest_ingest.js';
import { timingSafeEqual } from 'node:crypto';
import { buildGridQuery, type GridColumnSpec } from './engine/grid_query.js';
import { llmConfigured } from './engine/llm.js';
import * as elastic from './search/elastic.js';
import { channel3Configured, lookupProduct } from './engine/product_lookup.js';
import { checkCarrierStatus, kernelConfigured } from './engine/carrier_browser.js';
import type { CarrierManifestRecord, DisputeRecord } from './types/ledger.js';
import type { WebhookVerificationRequest } from './types/paypal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read .env if present
const candidateEnvPaths = [
  join(process.cwd(), '.env'),
  join(__dirname, '../.env'),
  join(__dirname, '../../.env'),
  join(__dirname, '../../../.env')
];
for (const p of candidateEnvPaths) {
  if (existsSync(p)) {
    const envContent = readFileSync(p, 'utf8');
    for (const line of envContent.split('\n')) {
      if (line.includes('=') && !line.startsWith('#')) {
        const idx = line.indexOf('=');
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';

export async function createServer(customDb?: LedgerDB, customPayPal?: PayPalClient) {
  const fastify = Fastify({
    logger: process.env.NODE_ENV !== 'test'
  });

  await fastify.register(cors, {
    origin: true
  });

  // Serve static UI wireframes and workbench assets
  const publicPath = join(__dirname, '../public');
  if (existsSync(publicPath)) {
    await fastify.register(fastifyStatic, {
      root: publicPath,
      prefix: '/',
      index: ['index.html'],
      decorateReply: true
    });

    fastify.get('/cockpit', async (req, reply) => {
      return reply.sendFile('index.html');
    });

    fastify.get('/deck', async (req, reply) => {
      return reply.sendFile('deck.html');
    });

    fastify.get('/doc', async (req, reply) => {
      return reply.sendFile('doc.html');
    });

    fastify.get('/docs', async (req, reply) => {
      return reply.sendFile('doc.html');
    });
  }

  // Preserve raw body Buffer for webhook signature verification
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
        const json = JSON.parse((body as Buffer).toString('utf8'));
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Supabase Postgres is the only ledger store (DATABASE_URL). Tests inject an in-memory Postgres.
  const db: LedgerDB = customDb ?? (await LedgerDB.connect());
  if ((await db.getAllHolds()).length === 0) {
    await seedLedger(db);
  }

  const clientId = process.env.PAYPAL_CLIENT_ID || 'sandbox_client_id';
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || 'sandbox_client_secret';
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  const paypal =
    customPayPal ||
    new PayPalClient({
      clientId,
      clientSecret,
      environment: (process.env.PAYPAL_ENVIRONMENT as 'sandbox' | 'live') || 'sandbox',
      webhookId
    });

  // --- Health Check for Render ---
  // --- UI config (AG Grid Enterprise licence + feature flags) ---
  // An AG Grid licence key is a front-end key by design; it is served here so it is not committed.
  fastify.get('/api/config', async () => ({
    agGridLicenseKey: process.env.AG_GRID_API_KEY || null,
    llm: llmConfigured(),
    paypalEnvironment: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
    simulatedHistory: true,
    simulateUploads: process.env.UNHOLD_SIMULATE_UPLOADS === 'true',
    integrations: {
      zapier: Boolean(process.env.ZAPIER_WEBHOOK_URL),
      astropods: Boolean(process.env.ASTROPODS_API_KEY),
      elastic: Boolean(process.env.ELASTIC_URL && process.env.ELASTIC_API_KEY),
      kernel: Boolean(process.env.KERNEL_API_KEY),
      channel3: Boolean(process.env.CHANNEL3_API_KEY),
      postman: Boolean(process.env.POSTMAN_API_KEY)
    }
  }));

  // --- Elastic: semantic + keyword search over the ledger ---
  fastify.get('/api/search', async (req, reply) => {
    const q = String((req.query as { q?: string; kind?: string }).q || '').trim();
    const kind = (req.query as { kind?: string }).kind;
    if (!q) return reply.status(400).send({ error: 'q is required' });
    if (!elastic.elasticConfigured()) return reply.status(503).send({ error: 'Elastic is not configured on the server.' });
    try {
      return await elastic.search(q.slice(0, 300), 15, kind);
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
  fastify.post('/api/search/reindex', async (_req, reply) => {
    if (!elastic.elasticConfigured()) return reply.status(503).send({ error: 'Elastic is not configured on the server.' });
    try {
      const r = await elastic.reindex(db);
      await db.appendAuditEntry({ actor: 'Elastic indexer', action: 'reindex', target: 'unhold-ledger', result: 'ok', detail: `indexed ${r.indexed} documents in ${r.ms} ms` });
      return r;
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
  // Index in the background at start-up so search works without a manual step.
  if (!customDb && elastic.elasticConfigured()) {
    elastic.reindex(db).then((r) => console.log(`[ELASTIC] indexed ${r.indexed} documents in ${r.ms} ms`)).catch((e) => console.warn(`[ELASTIC] start-up index failed: ${e.message}`));
  }

  // --- Channel3: product-graph evidence for a held order ---
  fastify.get('/api/holds/:id/product', async (req, reply) => {
    if (!channel3Configured()) return reply.status(503).send({ error: 'Channel3 is not configured on the server.' });
    const hold = await db.getHoldById((req.params as { id: string }).id);
    if (!hold) return reply.status(404).send({ error: 'Hold not found.' });
    try {
      return await lookupProduct(hold.item, hold.amount);
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  // --- Demo carrier page: stands in for UPS/USPS/FedEx/DHL tracking pages (synthetic numbers are unknown to them) ---
  fastify.get('/carrier/:trk', async (req, reply) => {
    const trk = (req.params as { trk: string }).trk;
    const hold = (await db.getAllHolds()).find((h) => h.tracking_number === trk);
    const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const status = !hold ? 'not_found' : hold.delivered_at ? 'delivered' : hold.shipped_at ? 'in_transit' : 'label_created';
    const label = { not_found: 'Tracking number not found', delivered: 'Delivered', in_transit: 'In transit', label_created: 'Label created' }[status];
    reply.type('text/html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Demo Carrier tracking ${esc(trk)}</title>
<body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<p style="color:#8a6d00;background:#fff8e1;padding:8px 12px;border-radius:6px">Demo carrier page. It stands in for the real carrier site, which does not know this synthetic tracking number.</p>
<h1>Tracking ${esc(trk)}</h1>
<p id="status" data-carrier-status="${status}" data-delivered-at="${esc(hold?.delivered_at || '')}"><strong>${label}</strong>${hold?.delivered_at ? ' on ' + esc(hold.delivered_at.slice(0, 10)) : ''}</p>
${hold ? `<p>${esc(hold.carrier || '')} · shipped ${esc((hold.shipped_at || '—').slice(0, 10))}</p>` : ''}
</body></html>`);
  });

  // --- Kernel: a cloud browser confirms delivery on the carrier page ---
  fastify.post('/api/holds/:id/carrier-check', async (req, reply) => {
    if (!kernelConfigured()) return reply.status(503).send({ error: 'Kernel is not configured on the server.' });
    const hold = await db.getHoldById((req.params as { id: string }).id);
    if (!hold) return reply.status(404).send({ error: 'Hold not found.' });
    if (!hold.tracking_number) return reply.status(400).send({ error: 'This hold has no tracking number yet.' });
    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (!baseUrl) return reply.status(503).send({ error: 'PUBLIC_BASE_URL is not set: Kernel needs a public URL to reach the carrier page.' });
    try {
      const r = await checkCarrierStatus(hold.tracking_number, baseUrl);
      await db.appendAuditEntry({
        actor: 'Kernel carrier check', action: 'carrier_status', target: hold.order_id, result: r.status || 'unknown',
        detail: `Cloud browser session ${r.session_id} read ${r.url}: ${r.status}${r.delivered_at ? ' on ' + r.delivered_at.slice(0, 10) : ''} (${r.ms} ms)`
      });
      return r;
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  // --- "Ask the grid": plain English -> AG Grid filter/sort/group state ---
  fastify.post('/api/ai/grid-query', async (req, reply) => {
    const body = (req.body || {}) as { question?: string; columns?: GridColumnSpec[] };
    if (!body.question || !Array.isArray(body.columns) || body.columns.length === 0) {
      return reply.status(400).send({ error: 'question and columns are required' });
    }
    if (!llmConfigured()) {
      return reply.status(503).send({ error: 'LLM is not configured on the server.' });
    }
    try {
      const result = await buildGridQuery(body.question, body.columns.slice(0, 40));
      await db.appendAuditEntry({
        actor: 'Ask the grid (LLM)',
        action: 'grid_query',
        target: 'holds grid',
        result: 'ok',
        detail: `"${body.question.slice(0, 120)}" -> ${result.explanation}`
      });
      return result;
    } catch (err) {
      return reply.status(502).send({ error: `Could not turn that into a grid query: ${(err as Error).message}` });
    }
  });

  fastify.get('/health', async () => {
    return {
      status: 'ok',
      service: 'unhold-api',
      environment: process.env.NODE_ENV || 'development',
      ledger: db.backend,
      timestamp: new Date().toISOString()
    };
  });

  // --- Ledger & Analytics Endpoints ---

  fastify.get('/api/summary', async () => {
    return await db.getSummary();
  });

  fastify.get('/api/holds', async (req) => {
    const query = req.query as { status?: string };
    return {
      holds: await db.getAllHolds(query.status)
    };
  });

  fastify.get('/api/waterfall', async (req) => {
    const query = req.query as { asOf?: string };
    const holds = await db.getAllHolds();
    return buildHoldWaterfall(holds, query.asOf || '2026-11-09T18:00:00Z');
  });

  fastify.get('/api/why-held', async () => {
    const holds = await db.getAllHolds();
    const evidence = await db.getAllEvidence();
    // Default sales history from seed
    const seedPath = join(__dirname, 'seed/unhold_seed.json');
    let sales: Array<{ d: string; v: number }> = [];
    if (existsSync(seedPath)) {
      const data = JSON.parse(readFileSync(seedPath, 'utf8'));
      sales = data.sales || [];
    }
    return generateWhyHeldReport(holds, sales, evidence);
  });

  fastify.post('/api/cash-goal/plan', async (req) => {
    const body = req.body as {
      goalAmount?: number;
      goalDay?: number;
      confidence?: number;
    };
    const holds = await db.getAllHolds();
    return planCashGoal(
      holds,
      body.goalAmount || 4500,
      body.goalDay ?? 11,
      body.confidence || 0.8
    );
  });

  fastify.get('/api/manifests', async () => {
    return {
      manifests: await db.getAllManifests()
    };
  });

  fastify.post('/api/manifests/match', async (req) => {
    const body = (req.body as { manifests?: CarrierManifestRecord[] }) || {};
    const manifests = body.manifests || (await db.getAllManifests());
    const holds = await db.getAllHolds();
    return matchAllManifests(manifests, holds);
  });

  // Inbound low-code door: Zapier posts parcel rows here (shared-secret header).
  fastify.post('/api/manifests/ingest', async (req, reply) => {
    const secret = process.env.INGEST_SHARED_SECRET;
    if (!secret) return reply.status(503).send({ error: 'Ingest is disabled: INGEST_SHARED_SECRET is not set.' });
    const sent = String(req.headers['x-unhold-secret'] || '');
    const a = Buffer.from(sent);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.status(401).send({ error: 'Invalid or missing x-unhold-secret header.' });
    }
    const report = await ingestManifests(db, req.body);
    if (report.stored === 0) return reply.status(400).send({ error: 'No valid parcel rows in the request.', ...report });
    return report;
  });

  fastify.post('/api/manifests/upload', async (req) => {
    const body = (req.body as BatchUploadOptions) || {};
    return executeBatchTrackingUpload(db, paypal, body);
  });

  // --- Disputes & Buyer Assurance Endpoints ---

  fastify.get('/api/disputes', async () => {
    return {
      disputes: await db.getAllDisputes()
    };
  });

  fastify.post('/api/disputes/ingest', async (req) => {
    const dispute = req.body as DisputeRecord;
    await db.insertDispute(dispute);
    return {
      status: 'INGESTED',
      dispute_id: dispute.dispute_id
    };
  });

  fastify.post('/api/disputes/:id/negotiate', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body as { options?: SettlementOptions }) || {};
    let dispute = await db.getDispute(params.id);
    if (!dispute) {
      if (params.id === 'DISP-SEED-001' || params.id.startsWith('DISP-') || params.id.startsWith('PP-D-')) {
        const demoDispute: DisputeRecord = {
          dispute_id: params.id,
          order_id: 'ORD-789012',
          capture_id: 'CAP-789012',
          amount: 249.00,
          currency: 'USD',
          status: 'WAITING_FOR_SELLER_RESPONSE',
          reason: 'ITEM_NOT_RECEIVED',
          buyer_message: 'Package has not arrived. Please refund or confirm where it was left.',
          respond_by: new Date(Date.now() + 864000000).toISOString(),
          created_at: new Date().toISOString()
        };
        await db.insertDispute(demoDispute);
        dispute = demoDispute;
      } else {
        return reply.status(404).send({ error: `Dispute ${params.id} not found` });
      }
    }
    return runAutonomousDisputeSettlement(dispute, db, body.options);
  });

  fastify.post('/api/prompt-guard/check', async (req) => {
    const body = req.body as { message?: string };
    return analyzePromptInjection(body.message || '');
  });

  fastify.post('/api/sdjwt/issue', async (req) => {
    const body = req.body as {
      proof: DeliveryProofPayload;
      selectiveFields: Array<keyof DeliveryProofPayload>;
    };
    return issueDeliverySDJWT(body.proof, body.selectiveFields);
  });

  fastify.post('/api/sdjwt/verify', async (req) => {
    const body = req.body as {
      sdJwt: string;
      publicKeyJwk: JsonWebKey;
    };
    return verifyDeliverySDJWT(body.sdJwt, body.publicKeyJwk);
  });

  // --- Payment Guard (Anti-Scam & Pre-Flight) Endpoints ---

  fastify.post('/api/payment-guard/verify-email', async (req) => {
    const body = req.body as {
      rawEmail: string;
      headers?: { from?: string; subject?: string };
    };
    const parsed = parsePaymentNotification(body.rawEmail || '', body.headers);
    return verifyPaymentAuthenticity(parsed, paypal, db);
  });

  fastify.post('/api/payment-guard/preflight', async (req) => {
    const body = req.body as PreFlightAuditParams;
    return await auditPreFlightSellerProtection(body, db);
  });

  fastify.get('/api/audit', async () => {
    const chain = await db.getAuditChain();
    const verification = await db.verifyLedgerAuditChain();
    return {
      chain,
      verification
    };
  });

  fastify.post('/api/audit/verify', async () => {
    return await db.verifyLedgerAuditChain();
  });

  // --- Low-Code Sponsor Integrations (Zapier & Astropods) ---

  fastify.post('/api/lowcode/zapier/trigger', async (req) => {
    const body = (req.body as ZapierEventPayload) || { event: 'test.ping', data: {} };
    return dispatchZapierEvent(body);
  });

  fastify.get('/api/lowcode/astropods/spec', async () => {
    return getAstropodsPodSpec();
  });

  fastify.post('/api/lowcode/astropods/query', async (req) => {
    const body = (req.body as { prompt?: string; model?: string }) || {};
    return queryAstropodsGateway(body.prompt || 'Hello Unhold Agent Pod', body.model);
  });

  // --- PayPal Real Webhook Receiver ---

  fastify.post('/webhooks/paypal', async (req, reply) => {
    const headers = req.headers;
    const body = req.body as Record<string, unknown>;
    const rawBodyBuffer = (req as unknown as { rawBody?: Buffer }).rawBody;

    const eventType = (body.event_type as string) || 'UNKNOWN_EVENT';
    const eventId = (body.id as string) || 'UNKNOWN_ID';
    const resource = (body.resource as Record<string, unknown>) || {};

    let verificationPassed = false;

    // Verify webhook signature if headers present
    if (
      headers['paypal-auth-algo'] &&
      headers['paypal-cert-url'] &&
      headers['paypal-transmission-id'] &&
      headers['paypal-transmission-sig'] &&
      headers['paypal-transmission-time']
    ) {
      try {
        const verifyReq: WebhookVerificationRequest = {
          auth_algo: headers['paypal-auth-algo'] as string,
          cert_url: headers['paypal-cert-url'] as string,
          transmission_id: headers['paypal-transmission-id'] as string,
          transmission_sig: headers['paypal-transmission-sig'] as string,
          transmission_time: headers['paypal-transmission-time'] as string,
          webhook_id: webhookId || '',
          webhook_event: body
        };

        const result = await paypal.verifyWebhookSignature(verifyReq);
        verificationPassed = result.verification_status === 'SUCCESS';
      } catch (err) {
        fastify.log.warn(`Webhook signature check warning: ${(err as Error).message}`);
        // In local/sandbox development without live tunnel, note fallback
        verificationPassed = process.env.NODE_ENV === 'test' || !webhookId;
      }
    } else {
      // Direct simulator or development post
      verificationPassed = process.env.NODE_ENV !== 'production';
    }

    // Process specific PayPal events
    let actionResult = 'acknowledged';
    let detail = `Ingested event ${eventType} (${eventId})`;

    if (eventType === 'PAYMENT.CAPTURE.PENDING') {
      const captureId = (resource.id as string) || '';
      const amountVal = (resource.amount as { value?: string })?.value || '0.00';
      const reason = (resource.status_details as { reason?: string })?.reason || 'PENDING_REVIEW';
      actionResult = 'held';
      detail = `Capture ${captureId} for $${amountVal} held: ${reason}`;
    } else if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureId = (resource.id as string) || '';
      actionResult = 'released';
      detail = `Capture ${captureId} completed and funds released`;
    } else if (eventType === 'CUSTOMER.DISPUTE.CREATED') {
      const disputeId = (resource.dispute_id as string) || `DISP-${eventId.slice(-8)}`;
      const amountVal = Number((resource.dispute_amount as { value?: string })?.value || '0.00');
      const currency = (resource.dispute_amount as { currency_code?: string })?.currency_code || 'USD';
      const reason = (resource.reason as string) || 'ITEM_NOT_RECEIVED';
      const buyerMsg =
        (resource.messages as Array<{ content?: string }>)?.[0]?.content ||
        (resource.buyer_message as string) ||
        'Buyer opened dispute';
      const respondBy =
        (resource.respond_by_date as string) ||
        new Date(Date.now() + 10 * 86400000).toISOString();

      const disputedTxns = resource.disputed_transactions as Array<{
        seller_transaction_id?: string;
        buyer_transaction_id?: string;
      }>;
      const orderId = disputedTxns?.[0]?.seller_transaction_id || (resource.id as string) || eventId;
      const captureId = disputedTxns?.[0]?.buyer_transaction_id || orderId;

      actionResult = 'dispute_opened';
      detail = `Dispute ${disputeId} opened for $${amountVal} (${reason}); funds placed on hold`;

      await db.insertDispute({
        dispute_id: disputeId,
        order_id: orderId,
        capture_id: captureId,
        amount: amountVal,
        currency,
        status: 'WAITING_FOR_SELLER_RESPONSE',
        reason,
        buyer_message: buyerMsg,
        respond_by: respondBy,
        created_at: new Date().toISOString()
      });
    }

    // Append to tamper-evident audit chain
    const auditEntry = await db.appendAuditEntry({
      actor: 'PayPal Webhook Gateway',
      action: eventType,
      target: eventId,
      result: actionResult,
      detail: `${detail} | signature_verified=${verificationPassed}`
    });

    return reply.status(200).send({
      status: 'SUCCESS',
      event_id: eventId,
      event_type: eventType,
      signature_verified: verificationPassed,
      audit_block_id: auditEntry.block_id,
      audit_hash: auditEntry.hash
    });
  });

  return fastify;
}

// Start server if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().then(async (server) => {
    try {
      await server.listen({ port: PORT, host: HOST });
      console.log(`\n======================================================`);
      console.log(`🚀 Unhold API Server running on http://${HOST}:${PORT}`);
      console.log(`📡 PayPal Webhook Endpoint: http://${HOST}:${PORT}/webhooks/paypal`);
      console.log(`💚 Health Check: http://${HOST}:${PORT}/health`);
      console.log(`======================================================\n`);
    } catch (err) {
      server.log.error(err);
      process.exit(1);
    }
  });
}

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

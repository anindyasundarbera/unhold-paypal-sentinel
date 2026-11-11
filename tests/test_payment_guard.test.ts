import './helpers/test_env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerDB } from '../src/db/ledger_db.js';
import { memoryLedger } from './helpers/memory_ledger.js';
import { seedLedger } from '../src/seed/seeder.js';
import { PayPalClient } from '../src/paypal/client.js';
import {
  parsePaymentNotification,
  verifyPaymentAuthenticity,
  auditPreFlightSellerProtection,
  type ParsedPaymentNotice
} from '../src/engine/payment_guard.js';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

process.env.NODE_ENV = 'test';

describe('Step 5: Payment Guard (Anti-Scam & Pre-Flight)', async () => {
  let db: LedgerDB;
  let paypal: PayPalClient;

  before(async () => {
    db = await memoryLedger();
    await seedLedger(db);
    paypal = new PayPalClient({
      clientId: 'sandbox_client',
      clientSecret: 'sandbox_secret',
      environment: 'sandbox'
    });
  });

  after(async () => {
    await db.close();
  });

  // -------------------------------------------------------------
  // Test 1: Email Notification Parsing
  // -------------------------------------------------------------
  test('parses authentic PayPal payment notification email correctly', async () => {
    const rawEmail = `
      From: "PayPal Service" <service@paypal.com>
      Subject: You received a payment of $149.99 USD from John Doe
      Date: Mon, 9 Nov 2026 12:30:00 -0800

      Hello Merchant,
      You received a payment of $149.99 USD from John Doe.
      Transaction ID: 4I3CM90TLF08RKM22
      Status: Payment Received - Pending Review
      Please ship to: 123 Elm Street, San Jose, CA 95131
    `;

    const notice = parsePaymentNotification(rawEmail, {
      from: 'service@paypal.com',
      subject: 'You received a payment of $149.99 USD from John Doe'
    });

    assert.equal(notice.is_legitimate_domain, true);
    assert.equal(notice.sender_domain, 'paypal.com');
    assert.equal(notice.transaction_id, '4I3CM90TLF08RKM22');
    assert.equal(notice.amount_usd, 149.99);
    assert.equal(notice.currency, 'USD');
    assert.equal(notice.urgency_cues.length, 0);
  });

  test('parses and detects counterfeit phishing notice with fake domain and urgency cues', async () => {
    const fakeEmail = `
      From: "PayPal Security Verification" <service@intl-paypal-verification.com>
      Subject: URGENT: Payment of $850.00 USD on hold!
      
      Dear Seller,
      Buyer has sent you $850.00 USD.
      Transaction ID: CAP-FAKE-PHISHING-001
      NOTE: Funds are on temporary hold until tracking is emailed to support!
      You must ship immediately to release funds! Do not contact PayPal until tracking provided.
    `;

    const notice = parsePaymentNotification(fakeEmail, {
      from: 'service@intl-paypal-verification.com',
      subject: 'URGENT: Payment of $850.00 USD on hold!'
    });

    assert.equal(notice.is_legitimate_domain, false);
    assert.equal(notice.sender_domain, 'intl-paypal-verification.com');
    assert.equal(notice.transaction_id, 'CAP-FAKE-PHISHING-001');
    assert.equal(notice.amount_usd, 850.0);
    assert.ok(notice.urgency_cues.length >= 2);
  });

  // -------------------------------------------------------------
  // Test 2: Live Payment Authenticity Verification & Phishing Block
  // -------------------------------------------------------------
  test('blocks nonexistent 404 ghost payment and logs security alert to audit chain', async () => {
    const fakeNotice: ParsedPaymentNotice = {
      sender_email: 'service@intl-paypal-verification.com',
      sender_domain: 'intl-paypal-verification.com',
      is_legitimate_domain: false,
      transaction_id: 'CAP-FAKE-PHISHING-001',
      amount_usd: 850.0,
      currency: 'USD',
      buyer_name: 'Scammer Doe',
      shipping_address: 'Fake Address 123',
      notice_type: 'SUSPICIOUS_UNKNOWN',
      urgency_cues: ['ship immediately to release funds'],
      raw_body_snippet: '...'
    };

    const report = await verifyPaymentAuthenticity(fakeNotice, paypal, db);

    assert.equal(report.verification_status, 'PHISHING_SCAM_BLOCKED');
    assert.equal(report.can_ship, false);
    assert.equal(report.seller_action, 'HALT_SHIPMENT_REPORT_SCAM');
    assert.ok(report.summary.includes('FRAUD ALERT'));
    assert.ok(report.red_flags.some((rf) => rf.includes('Spoofed email domain')));
    assert.ok(report.audit_entry);

    // Verify block was recorded in SQLite tamper-evident audit chain
    const auditChain = await db.getAuditChain();
    const lastAudit = auditChain[auditChain.length - 1];
    assert.equal(lastAudit.actor, 'Payment Guard (Anti-Scam)');
    assert.equal(lastAudit.action, 'BLOCK_PHISHING_ATTEMPT');
    assert.equal(lastAudit.result, 'BLOCKED');
  });

  test('detects payment amount mismatch between notice and real PayPal capture', async () => {
    // Mock PayPal client that returns $8.50 capture for an order claiming $850.00
    const mockPaypal = new PayPalClient({
      clientId: 'sandbox_client',
      clientSecret: 'sandbox_secret',
      environment: 'sandbox'
    });
    mockPaypal.getCapture = async () => ({
      id: 'CAP-TAMPER-001',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '8.50' },
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString()
    });

    const tamperedNotice: ParsedPaymentNotice = {
      sender_email: 'service@paypal.com',
      sender_domain: 'paypal.com',
      is_legitimate_domain: true,
      transaction_id: 'CAP-TAMPER-001',
      amount_usd: 850.0, // Fraudulent email claims $850
      currency: 'USD',
      buyer_name: 'P. Sneak',
      shipping_address: '123 Fake St',
      notice_type: 'PAYMENT_NOTIFICATION',
      urgency_cues: [],
      raw_body_snippet: '...'
    };

    const report = await verifyPaymentAuthenticity(tamperedNotice, mockPaypal, db);

    assert.equal(report.verification_status, 'AMOUNT_MISMATCH');
    assert.equal(report.can_ship, false);
    assert.equal(report.claimed_amount, 850.0);
    assert.equal(report.actual_amount, 8.5);
    assert.ok(report.red_flags.some((rf) => rf.includes('Amount mismatch')));
  });

  test('verifies legitimate PayPal capture and clears for pre-flight', async () => {
    const mockPaypal = new PayPalClient({
      clientId: 'sandbox_client',
      clientSecret: 'sandbox_secret',
      environment: 'sandbox'
    });
    mockPaypal.getCapture = async () => ({
      id: '4I3CM90TLF08RKM22',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '149.99' },
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString()
    });

    const authenticNotice: ParsedPaymentNotice = {
      sender_email: 'service@paypal.com',
      sender_domain: 'paypal.com',
      is_legitimate_domain: true,
      transaction_id: '4I3CM90TLF08RKM22',
      amount_usd: 149.99,
      currency: 'USD',
      buyer_name: 'E. Lindqvist',
      shipping_address: '45 Harbour Road',
      notice_type: 'PAYMENT_NOTIFICATION',
      urgency_cues: [],
      raw_body_snippet: '...'
    };

    const report = await verifyPaymentAuthenticity(authenticNotice, mockPaypal, db);

    assert.equal(report.verification_status, 'AUTHENTIC');
    assert.equal(report.can_ship, true);
    assert.equal(report.seller_action, 'PROCEED_TO_PREFLIGHT');
    assert.equal(report.actual_amount, 149.99);
  });

  // -------------------------------------------------------------
  // Test 3: Pre-Flight Seller Protection Auditor
  // -------------------------------------------------------------
  test('enforces $750 signature confirmation rule on high-value orders', async () => {
    // 1. $850 order without signature: AT_RISK, can_ship = false
    const unsignedAudit = await auditPreFlightSellerProtection(
      {
        order_id: 'ORD-HIGHVAL-01',
        capture_id: 'CAP-HIGHVAL-01',
        amount: 850.0,
        shipping_address: '100 Market St, San Francisco, CA 94105',
        checkout_address: '100 Market St, San Francisco, CA 94105',
        carrier: 'UPS',
        has_signature_confirmation: false
      },
      db
    );

    assert.equal(unsignedAudit.seller_protection_status, 'AT_RISK');
    assert.equal(unsignedAudit.can_ship, false);
    assert.equal(unsignedAudit.requires_signature, true);
    assert.ok(unsignedAudit.required_shipping_actions.includes('UPGRADE_TO_SIGNATURE_CONFIRMATION'));
    assert.ok(unsignedAudit.checklist.find((c) => c.check_name.includes('Signature') && c.status === 'FAIL'));

    // 2. $850 order with signature confirmation: PROTECTED, can_ship = true
    const signedAudit = await auditPreFlightSellerProtection(
      {
        order_id: 'ORD-HIGHVAL-01',
        capture_id: 'CAP-HIGHVAL-01',
        amount: 850.0,
        shipping_address: '100 Market St, San Francisco, CA 94105',
        checkout_address: '100 Market St, San Francisco, CA 94105',
        carrier: 'UPS',
        has_signature_confirmation: true
      },
      db
    );

    assert.equal(signedAudit.seller_protection_status, 'PROTECTED');
    assert.equal(signedAudit.can_ship, true);
    assert.equal(signedAudit.requires_signature, true);
    assert.equal(signedAudit.required_shipping_actions.length, 0);

    // 3. $150 order (under $750): signature not required
    const normalAudit = await auditPreFlightSellerProtection(
      {
        order_id: 'ORD-NORMAL-01',
        capture_id: 'CAP-NORMAL-01',
        amount: 150.0,
        shipping_address: '100 Market St, San Francisco, CA 94105',
        checkout_address: '100 Market St, San Francisco, CA 94105',
        carrier: 'USPS',
        has_signature_confirmation: false
      },
      db
    );

    assert.equal(normalAudit.seller_protection_status, 'PROTECTED');
    assert.equal(normalAudit.can_ship, true);
    assert.equal(normalAudit.requires_signature, false);
  });

  test('blocks shipment when destination address differs from PayPal checkout record', async () => {
    const mismatchAudit = await auditPreFlightSellerProtection(
      {
        order_id: 'ORD-MISMATCH-01',
        capture_id: 'CAP-MISMATCH-01',
        amount: 220.0,
        shipping_address: '99 Diverted Lane, New York, NY 10001', // Buyer asked to redirect
        checkout_address: '12 Original Way, Boston, MA 02108', // PayPal checkout address
        carrier: 'FedEx'
      },
      db
    );

    assert.equal(mismatchAudit.seller_protection_status, 'VOID');
    assert.equal(mismatchAudit.can_ship, false);
    assert.equal(mismatchAudit.address_confirmed, false);
    assert.ok(mismatchAudit.risk_factors.some((rf) => rf.includes('does not match PayPal transaction')));
    assert.ok(
      mismatchAudit.required_shipping_actions.includes('CANCEL_LABEL_SHIP_ONLY_TO_PAYPAL_ADDRESS')
    );
  });

  // -------------------------------------------------------------
  // Test 4: Fastify Server REST Endpoints
  // -------------------------------------------------------------
  describe('Fastify Server Payment Guard Endpoints', async () => {
    let server: FastifyInstance;
    let testDb: LedgerDB;

    before(async () => {
      testDb = await memoryLedger();
      await seedLedger(testDb);
      server = await createServer(testDb);
    });

    after(async () => {
      await server.close();
      await testDb.close();
    });

    test('POST /api/payment-guard/verify-email blocks fake payment notice', async () => {
      const phishingEmail = `
        From: "PayPal Security" <security@paypal-hold-release.net>
        Subject: Action Required: $950.00 USD Pending!

        You received $950.00 USD.
        Transaction ID: CAP-FAKE-NET-99
        Ship immediately to release funds!
      `;

      const res = await server.inject({
        method: 'POST',
        url: '/api/payment-guard/verify-email',
        payload: {
          rawEmail: phishingEmail,
          headers: { from: 'security@paypal-hold-release.net' }
        }
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.verification_status, 'PHISHING_SCAM_BLOCKED');
      assert.equal(data.can_ship, false);
      assert.equal(data.seller_action, 'HALT_SHIPMENT_REPORT_SCAM');
    });

    test('POST /api/payment-guard/preflight audits Seller Protection compliance', async () => {
      // 1. $800 order without signature confirmation -> AT_RISK
      const resUnsigned = await server.inject({
        method: 'POST',
        url: '/api/payment-guard/preflight',
        payload: {
          order_id: 'ORD-API-800',
          capture_id: 'CAP-API-800',
          amount: 800.0,
          shipping_address: '500 Howard St, San Francisco, CA 94105',
          checkout_address: '500 Howard St, San Francisco, CA 94105',
          carrier: 'UPS',
          has_signature_confirmation: false
        }
      });

      assert.equal(resUnsigned.statusCode, 200);
      const dataUnsigned = JSON.parse(resUnsigned.body);
      assert.equal(dataUnsigned.seller_protection_status, 'AT_RISK');
      assert.equal(dataUnsigned.can_ship, false);

      // 2. $800 order with signature confirmation -> PROTECTED
      const resSigned = await server.inject({
        method: 'POST',
        url: '/api/payment-guard/preflight',
        payload: {
          order_id: 'ORD-API-800',
          capture_id: 'CAP-API-800',
          amount: 800.0,
          shipping_address: '500 Howard St, San Francisco, CA 94105',
          checkout_address: '500 Howard St, San Francisco, CA 94105',
          carrier: 'UPS',
          has_signature_confirmation: true
        }
      });

      assert.equal(resSigned.statusCode, 200);
      const dataSigned = JSON.parse(resSigned.body);
      assert.equal(dataSigned.seller_protection_status, 'PROTECTED');
      assert.equal(dataSigned.can_ship, true);
    });
  });
});

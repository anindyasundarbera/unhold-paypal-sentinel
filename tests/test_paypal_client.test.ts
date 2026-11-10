import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '../src/paypal/client.js';

describe('PayPal REST Client Contract', async () => {
  test('authenticates and caches OAuth2 token', async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = async (url, init) => {
      callCount++;
      assert.match(String(url), /\/v1\/oauth2\/token/);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.body, 'grant_type=client_credentials');

      return new Response(
        JSON.stringify({
          access_token: 'A21AA_MOCK_TOKEN_123',
          token_type: 'Bearer',
          app_id: 'APP-123456',
          expires_in: 3600,
          nonce: 'nonce123'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new PayPalClient({
      clientId: 'mock_client_id',
      clientSecret: 'mock_client_secret',
      environment: 'sandbox',
      customFetch: mockFetch
    });

    const token1 = await client.getAccessToken();
    assert.equal(token1, 'A21AA_MOCK_TOKEN_123');
    assert.equal(callCount, 1);

    // Second call should return cached token without invoking fetch
    const token2 = await client.getAccessToken();
    assert.equal(token2, 'A21AA_MOCK_TOKEN_123');
    assert.equal(callCount, 1);
  });

  test('adds tracking with deterministic idempotency header', async () => {
    const capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    const mockFetch: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 'MOCK_TOKEN', expires_in: 3600 }),
          { status: 200 }
        );
      }

      if (urlStr.includes('/v2/checkout/orders/ORDER_999/track')) {
        const headers = init?.headers as Record<string, string>;
        Object.assign(capturedHeaders, headers);
        capturedBody = init?.body as string;

        return new Response(
          JSON.stringify({
            id: 'TRACKER-001',
            transaction_id: 'TXN-777',
            tracking_number: '1Z999AA10123456784',
            carrier: 'UPS',
            status: 'SHIPPED'
          }),
          { status: 201 }
        );
      }

      return new Response('Not Found', { status: 404 });
    };

    const client = new PayPalClient({
      clientId: 'id',
      clientSecret: 'secret',
      customFetch: mockFetch
    });

    const tracker = await client.addTracking(
      'ORDER_999',
      {
        tracking_number: '1Z999AA10123456784',
        carrier: 'UPS',
        notify_payer: false
      },
      'IDEM-REQ-7788'
    );

    assert.equal(tracker.id, 'TRACKER-001');
    assert.equal(tracker.tracking_number, '1Z999AA10123456784');
    assert.equal(capturedHeaders['PayPal-Request-Id'], 'IDEM-REQ-7788');
    assert.equal(capturedHeaders['Authorization'], 'Bearer MOCK_TOKEN');

    const parsedBody = JSON.parse(capturedBody);
    assert.equal(parsedBody.tracking_number, '1Z999AA10123456784');
    assert.equal(parsedBody.carrier, 'UPS');
  });

  test('passes PayPal-Mock-Response header for negative capture testing', async () => {
    let mockHeaderVal = '';

    const mockFetch: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 'MOCK_TOKEN', expires_in: 3600 }),
          { status: 200 }
        );
      }

      if (urlStr.includes('/v2/payments/captures/CAP-HELD-001')) {
        const headers = init?.headers as Record<string, string>;
        mockHeaderVal = headers['PayPal-Mock-Response'] || '';

        return new Response(
          JSON.stringify({
            id: 'CAP-HELD-001',
            status: 'PENDING',
            status_details: { reason: 'PENDING_REVIEW' },
            amount: { currency_code: 'USD', value: '180.00' },
            create_time: '2026-11-09T18:00:00Z',
            update_time: '2026-11-09T18:00:00Z'
          }),
          { status: 200 }
        );
      }

      return new Response('Not Found', { status: 404 });
    };

    const client = new PayPalClient({
      clientId: 'id',
      clientSecret: 'secret',
      customFetch: mockFetch
    });

    const capture = await client.getCapture(
      'CAP-HELD-001',
      JSON.stringify({ mock_application_codes: 'PENDING_REVIEW' })
    );

    assert.equal(capture.status, 'PENDING');
    assert.equal(capture.status_details?.reason, 'PENDING_REVIEW');
    assert.equal(
      mockHeaderVal,
      JSON.stringify({ mock_application_codes: 'PENDING_REVIEW' })
    );
  });
});

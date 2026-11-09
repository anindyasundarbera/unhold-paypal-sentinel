import { randomUUID } from 'node:crypto';
import type {
  PayPalTokenResponse,
  PayPalOrder,
  PayPalOrderCapture,
  PayPalTracker,
  CreateTrackerRequest,
  WebhookVerificationRequest,
  WebhookVerificationResponse
} from '../types/paypal.js';

export interface PayPalClientConfig {
  clientId: string;
  clientSecret: string;
  environment?: 'sandbox' | 'live';
  webhookId?: string;
  customFetch?: typeof fetch;
}

export class PayPalClient {
  private clientId: string;
  private clientSecret: string;
  private baseUrl: string;
  private webhookId?: string;
  private fetchFn: typeof fetch;

  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: PayPalClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.baseUrl =
      config.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    this.webhookId = config.webhookId;
    this.fetchFn = config.customFetch || fetch;
  }

  /**
   * Retrieves OAuth2 access token with in-memory caching.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.cachedToken && this.tokenExpiresAt > now + 60000) {
      return this.cachedToken;
    }

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await this.fetchFn(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PayPal OAuth authentication failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as PayPalTokenResponse;
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    return this.cachedToken;
  }

  /**
   * Helper to execute authenticated PayPal REST API requests.
   */
  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      requestId?: string;
      mockResponse?: string;
    } = {}
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    if (options.requestId) {
      headers['PayPal-Request-Id'] = options.requestId;
    }

    if (options.mockResponse) {
      headers['PayPal-Mock-Response'] = options.mockResponse;
    }

    const response = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PayPal API Error [${response.status}] on ${endpoint}: ${errText}`);
    }

    const data = (await response.json()) as T;
    return { data, status: response.status, headers: response.headers };
  }

  /**
   * Fetches order details by PayPal Order ID.
   * GET /v2/checkout/orders/{id}
   */
  async getOrder(orderId: string): Promise<PayPalOrder> {
    const res = await this.request<PayPalOrder>(`/v2/checkout/orders/${orderId}`);
    return res.data;
  }

  /**
   * Fetches payment capture details by Capture ID.
   * GET /v2/payments/captures/{id}
   */
  async getCapture(
    captureId: string,
    mockResponse?: string
  ): Promise<PayPalOrderCapture> {
    const res = await this.request<PayPalOrderCapture>(
      `/v2/payments/captures/${captureId}`,
      { mockResponse }
    );
    return res.data;
  }

  /**
   * Uploads tracking info to a PayPal Order with deterministic idempotency key.
   * POST /v2/checkout/orders/{id}/track
   */
  async addTracking(
    orderId: string,
    tracker: CreateTrackerRequest,
    requestId?: string
  ): Promise<PayPalTracker> {
    const reqId = requestId || randomUUID();
    const res = await this.request<PayPalTracker>(
      `/v2/checkout/orders/${orderId}/track`,
      {
        method: 'POST',
        body: tracker,
        requestId: reqId
      }
    );
    return res.data;
  }

  /**
   * Verifies incoming webhook signature via PayPal postback verification.
   * POST /v1/notifications/verify-webhook-signature
   */
  async verifyWebhookSignature(
    req: WebhookVerificationRequest
  ): Promise<WebhookVerificationResponse> {
    const res = await this.request<WebhookVerificationResponse>(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: {
          ...req,
          webhook_id: req.webhook_id || this.webhookId
        }
      }
    );
    return res.data;
  }

  /**
   * Lists transactions from Transaction Search.
   * GET /v1/reporting/transactions
   */
  async listTransactions(
    startDate: string,
    endDate: string,
    fields = 'all'
  ): Promise<unknown> {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      fields
    });
    const res = await this.request(`/v1/reporting/transactions?${params.toString()}`);
    return res.data;
  }
}

/**
 * PayPal REST API v1/v2 Types
 */

export interface PayPalTokenResponse {
  scope: string;
  access_token: string;
  token_type: string;
  app_id: string;
  expires_in: number;
  nonce: string;
}

export interface PayPalOrderCapture {
  id: string;
  status: 'COMPLETED' | 'PENDING' | 'DECLINED' | 'FAILED';
  status_details?: {
    reason?: 'PENDING_REVIEW' | 'ECHECK' | 'BUYER_COMPLAINT' | string;
  };
  amount: {
    currency_code: string;
    value: string;
  };
  seller_protection?: {
    status: 'ELIGIBLE' | 'PARTIALLY_ELIGIBLE' | 'NOT_ELIGIBLE';
    dispute_categories?: string[];
  };
  create_time: string;
  update_time: string;
}

export interface PayPalOrder {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  intent: 'CAPTURE' | 'AUTHORIZE';
  purchase_units: Array<{
    reference_id?: string;
    amount: {
      currency_code: string;
      value: string;
    };
    payments?: {
      captures?: PayPalOrderCapture[];
    };
    shipping?: {
      name?: { full_name?: string };
      address?: {
        address_line_1?: string;
        admin_area_2?: string;
        admin_area_1?: string;
        postal_code?: string;
        country_code?: string;
      };
      trackers?: PayPalTracker[];
    };
  }>;
  create_time: string;
  update_time: string;
}

export interface PayPalTracker {
  id: string;
  transaction_id: string;
  tracking_number: string;
  carrier: string;
  status: 'SHIPPED' | 'DELIVERED' | 'ON_HOLD' | 'CANCELLED';
  create_time?: string;
}

export interface CreateTrackerRequest {
  tracking_number: string;
  carrier: string;
  notify_payer?: boolean;
}

export interface WebhookVerificationRequest {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: Record<string, unknown>;
}

export interface WebhookVerificationResponse {
  verification_status: 'SUCCESS' | 'FAILURE';
}

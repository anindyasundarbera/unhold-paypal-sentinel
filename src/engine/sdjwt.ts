/**
 * RFC 9901 Selective Disclosure JWT (SD-JWT) Engine
 * Cryptographically issues and verifies privacy-preserving delivery assurance credentials
 * signed with ECDSA P-256 (ES256) and SHA-256 digests.
 *
 * Specification: IETF RFC 9901
 * https://datatracker.ietf.org/doc/rfc9901/
 */

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

export interface SDJWTIssuerKeyPair {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export interface DeliveryProofPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  order_id: string;
  carrier: string;
  tracking_number: string;
  delivered_at: string;
  status: 'DELIVERED';
  signature_on_delivery: boolean;
  dispute_id?: string;
  // Disclosable claims:
  recipient_name?: string;
  delivery_street_address?: string;
  postal_code?: string;
  gps_coordinates?: string;
  carrier_scan_facility?: string;
}

export interface IssueSDJWTResult {
  sdJwt: string; // <jwt>~<d1>~<d2>~...~
  token: string; // The JWS token part
  disclosures: string[];
  disclosedClaims: Record<string, unknown>;
  publicKeyJwk: JsonWebKey;
}

export interface VerifySDJWTResult {
  valid: boolean;
  issuer: string;
  subject: string;
  publicClaims: Record<string, unknown>;
  disclosedClaims: Record<string, unknown>;
  allVerifiedClaims: Record<string, unknown>;
  error?: string;
}

/**
 * Base64url encode Buffer or string.
 */
export function base64urlEncode(data: Uint8Array | Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return buf.toString('base64url');
}

/**
 * Base64url decode string to Buffer.
 */
export function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * Computes SHA-256 digest and returns base64url string.
 */
export async function sha256Base64url(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await subtle.digest('SHA-256', buf);
  return base64urlEncode(new Uint8Array(hash));
}

/**
 * Generates an ECDSA P-256 (ES256) key pair for signing and verification.
 */
export async function generateES256KeyPair(): Promise<SDJWTIssuerKeyPair> {
  const keyPair = await subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256'
    },
    true,
    ['sign', 'verify']
  );

  const publicKeyJwk = await subtle.exportKey('jwk', keyPair.publicKey);
  const privateKeyJwk = await subtle.exportKey('jwk', keyPair.privateKey);

  return { publicKeyJwk, privateKeyJwk };
}

/**
 * Issues an RFC 9901 SD-JWT for carrier delivery proof with selective disclosures.
 */
export async function issueDeliverySDJWT(
  proof: DeliveryProofPayload,
  selectiveFields: Array<keyof DeliveryProofPayload>,
  keyPair?: SDJWTIssuerKeyPair
): Promise<IssueSDJWTResult> {
  const keys = keyPair || (await generateES256KeyPair());

  // 1. Prepare Disclosures according to RFC 9901: [salt, claim_name, claim_value]
  const disclosures: string[] = [];
  const sdDigests: string[] = [];
  const disclosedClaims: Record<string, unknown> = {};

  for (const field of selectiveFields) {
    if (proof[field] !== undefined) {
      // 128-bit cryptographically secure random salt
      const saltBytes = new Uint8Array(16);
      webcrypto.getRandomValues(saltBytes);
      const salt = base64urlEncode(saltBytes);

      const disclosureArray = [salt, String(field), proof[field]];
      const disclosureJson = JSON.stringify(disclosureArray);
      const disclosureB64 = base64urlEncode(disclosureJson);

      const digest = await sha256Base64url(disclosureB64);
      disclosures.push(disclosureB64);
      sdDigests.push(digest);
      disclosedClaims[field as string] = proof[field];
    }
  }

  // 2. Build undislosed base JWT claims
  const mainPayload: Record<string, unknown> = {
    iss: proof.iss,
    sub: proof.sub,
    iat: proof.iat,
    exp: proof.exp,
    order_id: proof.order_id,
    carrier: proof.carrier,
    tracking_number: proof.tracking_number,
    delivered_at: proof.delivered_at,
    status: proof.status,
    signature_on_delivery: proof.signature_on_delivery,
    _sd: sdDigests,
    _sd_alg: 'sha-256'
  };

  if (proof.dispute_id) {
    mainPayload.dispute_id = proof.dispute_id;
  }

  // 3. JWS Header
  const header = {
    alg: 'ES256',
    typ: 'sd+jwt'
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(mainPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // 4. Import Private Key and Sign
  const privateKey = await subtle.importKey(
    'jwk',
    keys.privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sigBuffer = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = base64urlEncode(new Uint8Array(sigBuffer));
  const jwt = `${signingInput}.${sigB64}`;

  // 5. Construct RFC 9901 SD-JWT format: <jwt>~<disclosure1>~<disclosure2>~...~
  const sdJwt = `${jwt}~${disclosures.join('~')}~`;

  return {
    sdJwt,
    token: jwt,
    disclosures,
    disclosedClaims,
    publicKeyJwk: keys.publicKeyJwk
  };
}

/**
 * Verifies an RFC 9901 SD-JWT delivery proof against the issuer public key.
 */
export async function verifyDeliverySDJWT(
  sdJwtString: string,
  publicKeyJwk: JsonWebKey
): Promise<VerifySDJWTResult> {
  try {
    const parts = sdJwtString.split('~');
    const jwtString = parts[0];
    const disclosureStrings = parts.slice(1).filter((p) => p.length > 0);

    const jwtParts = jwtString.split('.');
    if (jwtParts.length !== 3) {
      return {
        valid: false,
        issuer: '',
        subject: '',
        publicClaims: {},
        disclosedClaims: {},
        allVerifiedClaims: {},
        error: 'Invalid JWS format in SD-JWT'
      };
    }

    const [headerB64, payloadB64, sigB64] = jwtParts;
    const signingInput = `${headerB64}.${payloadB64}`;

    // 1. Verify ES256 Signature
    const publicKey = await subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    const sigBytes = base64urlDecode(sigB64);
    const isSigValid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      new TextEncoder().encode(signingInput)
    );

    if (!isSigValid) {
      return {
        valid: false,
        issuer: '',
        subject: '',
        publicClaims: {},
        disclosedClaims: {},
        allVerifiedClaims: {},
        error: 'Cryptographic signature verification failed (ES256)'
      };
    }

    // 2. Parse Payload
    const payloadJson = base64urlDecode(payloadB64).toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;

    const sdDigests = Array.isArray(payload._sd) ? (payload._sd as string[]) : [];

    // 3. Verify Disclosures against _sd digests
    const disclosedClaims: Record<string, unknown> = {};

    for (const dStr of disclosureStrings) {
      const digest = await sha256Base64url(dStr);
      if (!sdDigests.includes(digest)) {
        return {
          valid: false,
          issuer: String(payload.iss || ''),
          subject: String(payload.sub || ''),
          publicClaims: payload,
          disclosedClaims: {},
          allVerifiedClaims: {},
          error: `Disclosure digest mismatch: ${digest} not in _sd claims`
        };
      }

      const decodedJson = base64urlDecode(dStr).toString('utf8');
      const [salt, claimName, claimValue] = JSON.parse(decodedJson) as [string, string, unknown];
      disclosedClaims[claimName] = claimValue;
    }

    const publicClaims: Record<string, unknown> = { ...payload };
    delete publicClaims._sd;
    delete publicClaims._sd_alg;

    const allVerifiedClaims = {
      ...publicClaims,
      ...disclosedClaims
    };

    return {
      valid: true,
      issuer: String(payload.iss || ''),
      subject: String(payload.sub || ''),
      publicClaims,
      disclosedClaims,
      allVerifiedClaims
    };
  } catch (err) {
    return {
      valid: false,
      issuer: '',
      subject: '',
      publicClaims: {},
      disclosedClaims: {},
      allVerifiedClaims: {},
      error: `SD-JWT parsing or verification exception: ${(err as Error).message}`
    };
  }
}

import { createHmac, timingSafeEqual } from 'crypto';

export type WebhookBody = {
  gatewayRef: string;
  status: 'SUCCESS' | 'FAILED';
  /** Unix seconds. Required on the signature but not stored on the body. */
  timestamp: number;
  /** Per-delivery nonce, so two identical bodies in the same second differ. */
  nonce: string;
  /** Optional issuer-supplied decline reason, surfaced on the transaction. */
  failureCode?: string;
  failureMessage?: string;
};

/** Reject callbacks whose signature is older than this. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Signature scheme for inbound bank callbacks.
 *
 * The original signed only `{gatewayRef, status}` with no timestamp or nonce,
 * which means a captured pair is replayable forever. Settlement happens to be
 * idempotent, so the worst case was bounded — but replay protection is an
 * explicit bank-integration and PCI DSS 4.0 §4.2.1 requirement, and the
 * timestamped form is what every modern bank actually sends.
 *
 * Signed payload is `"{timestamp}.{nonce}.{gatewayRef}.{status}"` — fixed
 * field order, derived from a narrow typed body, so a client cannot reorder
 * JSON keys to produce a different digest for the same parsed object.
 */
export function canonicalWebhookBody(body: WebhookBody): string {
  return [
    body.timestamp,
    body.nonce,
    body.gatewayRef,
    body.status,
    body.failureCode ?? '',
    body.failureMessage ?? '',
  ].join('.');
}

export function signWebhook(body: WebhookBody, secret: string): string {
  return createHmac('sha256', secret).update(canonicalWebhookBody(body)).digest('hex');
}

export type VerifyResult = { valid: true } | { valid: false; reason: 'missing' | 'malformed' | 'mismatch' | 'expired' };

export function verifyWebhook(
  body: WebhookBody,
  signature: string | undefined,
  secret: string,
  now: number = Date.now(),
): VerifyResult {
  if (!signature) {
    return { valid: false, reason: 'missing' };
  }

  const ageSeconds = Math.abs(now / 1000 - body.timestamp);
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'expired' };
  }

  const expected = Buffer.from(signWebhook(body, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length) {
    return { valid: false, reason: 'malformed' };
  }
  return timingSafeEqual(actual, expected) ? { valid: true } : { valid: false, reason: 'mismatch' };
}
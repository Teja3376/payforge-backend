import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ApiErrorBody, WebhookEvent } from '@payforge/types';

/**
 * Reference implementation of merchant-side webhook verification.
 *
 * PayForge signs `{timestamp}.{eventId}.{body}` with HMAC-SHA256 and sends the
 * result in `x-payforge-signature` as `t=<unix-seconds>,v1=<hex>`.
 *
 * Two rules make this safe to copy into a production handler:
 *  1. Read the raw request body as text. Parsing and re-serialising it changes
 *     key order and whitespace, and the digest will not match.
 *  2. Reject timestamps outside the tolerance window, or a captured delivery
 *     can be replayed indefinitely.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-payforge-signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type VerifyWebhookResult = { valid: true } | { valid: false; reason: string };

export function verifyWebhookSignature(input: {
  payload: string;
  eventId: string;
  header: string | undefined;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): VerifyWebhookResult {
  const { payload, eventId, header, secret } = input;
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!header) {
    return { valid: false, reason: 'missing signature header' };
  }

  const parts: Record<string, string> = {};
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index === -1) continue;
    parts[segment.slice(0, index).trim()] = segment.slice(index + 1).trim();
  }

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: 'missing or malformed timestamp' };
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp outside tolerance' };
  }

  const digest = parts.v1;
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) {
    return { valid: false, reason: 'malformed digest' };
  }

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.${eventId}.${payload}`).digest('hex'),
  );
  const actual = Buffer.from(digest);

  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? { valid: true }
    : { valid: false, reason: 'digest mismatch' };
}

/** Convenience wrapper: verify, then parse. */
export function parseWebhookEvent<T = unknown>(input: {
  payload: string;
  header: string | undefined;
  secret: string;
  toleranceSeconds?: number;
}): { valid: true; event: WebhookEvent<T> } | { valid: false; reason: string } {
  let event: WebhookEvent<T>;
  try {
    event = JSON.parse(input.payload) as WebhookEvent<T>;
  } catch {
    return { valid: false, reason: 'payload is not valid JSON' };
  }

  const result = verifyWebhookSignature({
    payload: input.payload,
    eventId: event.id,
    header: input.header,
    secret: input.secret,
    toleranceSeconds: input.toleranceSeconds,
  });

  return result.valid ? { valid: true, event } : result;
}

export type { ApiErrorBody };
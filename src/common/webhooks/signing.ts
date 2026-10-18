import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signature scheme for *outbound* webhooks PayForge sends to merchants.
 *
 * Deliberately different from the inbound bank scheme: PayForge signs
 * `{timestamp}.{eventId}.{body}` so a merchant can verify with nothing but the
 * signing secret they were shown when registering the endpoint, and so they can
 * reject stale deliveries themselves.
 *
 * Header format: `t=<unix-seconds>,v1=<hex hmac-sha256>`
 *
 * The eventId is passed separately rather than recovered by re-parsing the
 * body: the merchant already has it in the parsed event, and re-parsing on the
 * verify path invites subtle divergence from the sign path.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-payforge-signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function signOutbound(
  payload: string,
  timestamp: number,
  eventId: string,
  secret: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/**
 * Reference implementation of merchant-side verification.
 *
 * Shipped in `@payforge/node` so integrators do not have to reimplement it, and
 * used by our test suite to prove the scheme round-trips.
 */
export function verifyOutbound(input: {
  payload: string;
  eventId: string;
  header: string | undefined;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): { valid: true } | { valid: false; reason: string } {
  const { payload, eventId, header, secret } = input;
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!header) {
    return { valid: false, reason: 'missing signature header' };
  }

  const parts: Record<string, string> = {};
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index === -1) {
      continue;
    }
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
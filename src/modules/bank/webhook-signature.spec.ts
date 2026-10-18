import {
  canonicalWebhookBody,
  signWebhook,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
  type WebhookBody,
} from './webhook-signature';
import { signOutbound, verifyOutbound } from '../../common/webhooks/signing';

const SECRET = 'test-secret-'.repeat(4);

function body(overrides: Partial<WebhookBody> = {}): WebhookBody {
  return {
    gatewayRef: 'mock_6f1c0b2e3a4d4e5f',
    status: 'SUCCESS',
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'a1b2c3d4e5f6',
    ...overrides,
  };
}

describe('inbound bank webhook signature', () => {
  it('accepts a correctly signed body', () => {
    const input = body();
    expect(verifyWebhook(input, signWebhook(input, SECRET), SECRET)).toEqual({ valid: true });
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhook(body(), undefined, SECRET)).toEqual({ valid: false, reason: 'missing' });
  });

  it('rejects a signature computed with the wrong secret', () => {
    const input = body();
    const forged = signWebhook(input, 'a-different-secret-a-different-secret');
    expect(verifyWebhook(input, forged, SECRET)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a tampered status', () => {
    const input = body();
    const signature = signWebhook(input, SECRET);
    const tampered = { ...input, status: 'FAILED' as const };
    expect(verifyWebhook(tampered, signature, SECRET).valid).toBe(false);
  });

  it('rejects a tampered gatewayRef', () => {
    const input = body();
    const signature = signWebhook(input, SECRET);
    const tampered = { ...input, gatewayRef: 'mock_someoneelse' };
    expect(verifyWebhook(tampered, signature, SECRET).valid).toBe(false);
  });

  describe('replay protection', () => {
    it('accepts a body inside the tolerance window', () => {
      const input = body({ timestamp: Math.floor(Date.now() / 1000) - 60 });
      expect(verifyWebhook(input, signWebhook(input, SECRET), SECRET)).toEqual({ valid: true });
    });

    it('rejects a body older than the tolerance window', () => {
      // Regression: the original signed only {gatewayRef, status}, so a captured
      // pair was replayable forever.
      const stale = Math.floor(Date.now() / 1000) - (WEBHOOK_TOLERANCE_SECONDS + 60);
      const input = body({ timestamp: stale });
      expect(verifyWebhook(input, signWebhook(input, SECRET), SECRET)).toEqual({
        valid: false,
        reason: 'expired',
      });
    });

    it('rejects a body too far in the future', () => {
      const ahead = Math.floor(Date.now() / 1000) + (WEBHOOK_TOLERANCE_SECONDS + 600);
      const input = body({ timestamp: ahead });
      expect(verifyWebhook(input, signWebhook(input, SECRET), SECRET).valid).toBe(false);
    });

    it('distinguishes two identical payloads in the same second', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const first = body({ timestamp, nonce: 'nonceaaaa' });
      const second = body({ timestamp, nonce: 'noncebbbb' });
      expect(canonicalWebhookBody(first)).not.toBe(canonicalWebhookBody(second));
      expect(signWebhook(first, SECRET)).not.toBe(signWebhook(second, SECRET));
    });
  });

  it('includes decline details in the signed payload', () => {
    const success = body();
    const failure = body({ status: 'FAILED', failureCode: 'do_not_honor' });
    expect(canonicalWebhookBody(success)).not.toBe(canonicalWebhookBody(failure));
  });

  it('rejects a malformed-length signature without throwing', () => {
    // `timingSafeEqual` throws on length mismatch unless guarded first.
    expect(() => verifyWebhook(body(), 'abc', SECRET)).not.toThrow();
    expect(verifyWebhook(body(), 'abc', SECRET)).toEqual({ valid: false, reason: 'malformed' });
  });
});

describe('outbound merchant webhook signature', () => {
  const payload = JSON.stringify({
    id: 'evt_abc123',
    type: 'PAYMENT_SUCCEEDED',
    data: { object: 'payment', id: 'PF-PAY-A1B2C3D4E5F6' },
  });
  const eventId = 'evt_abc123';
  const now = Math.floor(Date.now() / 1000);

  it('round-trips a valid signature', () => {
    const header = signOutbound(payload, now, eventId, SECRET);
    expect(verifyOutbound({ payload, eventId, header, secret: SECRET })).toEqual({ valid: true });
  });

  it('rejects a tampered body', () => {
    const header = signOutbound(payload, now, eventId, SECRET);
    const result = verifyOutbound({
      payload: payload.replace('PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED'),
      eventId,
      header,
      secret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: 'digest mismatch' });
  });

  it('rejects a signature from a different secret', () => {
    const header = signOutbound(payload, now, eventId, 'another-secret-entirely-here-xxx');
    const result = verifyOutbound({ payload, eventId, header, secret: SECRET });
    expect(result.valid).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const stale = now - 3600;
    const header = signOutbound(payload, stale, eventId, SECRET);
    const result = verifyOutbound({ payload, eventId, header, secret: SECRET });
    expect(result).toEqual({ valid: false, reason: 'timestamp outside tolerance' });
  });

  it('rejects a missing header', () => {
    const result = verifyOutbound({ payload, eventId, header: undefined, secret: SECRET });
    expect(result).toEqual({ valid: false, reason: 'missing signature header' });
  });

  it('rejects a malformed digest', () => {
    const result = verifyOutbound({ payload, eventId, header: `t=${now},v1=short`, secret: SECRET });
    expect(result).toEqual({ valid: false, reason: 'malformed digest' });
  });

  it('binds the eventId into the digest', () => {
    const header = signOutbound(payload, now, eventId, SECRET);
    const result = verifyOutbound({ payload, eventId: 'evt_different', header, secret: SECRET });
    expect(result.valid).toBe(false);
  });
});
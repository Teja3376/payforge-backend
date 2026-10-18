import { createHmac } from 'node:crypto';
import { signOutbound } from './signing';

/**
 * Contract test: the server's signer and the SDK's verifier must agree.
 *
 * This file is compiled into the server build and imports the *published*
 * `@payforge/node` verifier, so a change to either side that breaks the
 * handshake fails CI rather than silently 401-ing every merchant's webhooks.
 */
describe('outbound webhook signing contract', () => {
   
  const sdk = require('@payforge/node') as {
    verifyWebhookSignature: (input: {
      payload: string;
      eventId: string;
      header: string | undefined;
      secret: string;
      toleranceSeconds?: number;
      nowSeconds?: number;
    }) => { valid: true } | { valid: false; reason: string };
    parseWebhookEvent: (input: {
      payload: string;
      header: string | undefined;
      secret: string;
      toleranceSeconds?: number;
    }) => { valid: true; event: unknown } | { valid: false; reason: string };
  };

  const secret = 'whsec_test_secret_value_for_contract_test';

  const event = {
    id: 'evt_9f2c1a7b4e6d0358aa11cc',
    type: 'PAYMENT_SUCCEEDED',
    createdAt: new Date().toISOString(),
    livemode: false,
    data: {
      object: 'payment',
      id: 'PF-PAY-A1B2C3D4E5F6',
      amount: 950.75,
      currency: 'INR',
      status: 'SUCCESS',
    },
  };

  const payload = JSON.stringify(event);
  const now = Math.floor(Date.now() / 1000);

  it('the SDK accepts a signature produced by the server', () => {
    const header = signOutbound(payload, now, event.id, secret);
    expect(
      sdk.verifyWebhookSignature({ payload, eventId: event.id, header, secret, nowSeconds: now }),
    ).toEqual({ valid: true });
  });

  it('the SDK parses an event the server signed', () => {
    const header = signOutbound(payload, now, event.id, secret);
    const result = sdk.parseWebhookEvent({ payload, header, secret });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.event).toMatchObject({ id: event.id, type: 'PAYMENT_SUCCEEDED' });
    }
  });

  it('the SDK rejects a tampered payload', () => {
    const header = signOutbound(payload, now, event.id, secret);
    const tampered = payload.replace('950.75', '9999999');
    expect(
      sdk.verifyWebhookSignature({ payload: tampered, eventId: event.id, header, secret, nowSeconds: now }),
    ).toEqual({ valid: false, reason: 'digest mismatch' });
  });

  it('the SDK rejects a wrong secret', () => {
    const header = signOutbound(payload, now, event.id, 'whsec_a_completely_different_secret');
    expect(
      sdk.verifyWebhookSignature({ payload, eventId: event.id, header, secret, nowSeconds: now }).valid,
    ).toBe(false);
  });

  it('the SDK rejects a stale delivery', () => {
    const stale = now - 3600;
    const header = signOutbound(payload, stale, event.id, secret);
    expect(
      sdk.verifyWebhookSignature({ payload, eventId: event.id, header, secret, nowSeconds: now }),
    ).toEqual({ valid: false, reason: 'timestamp outside tolerance' });
  });

  it('the header format is exactly what the docs promise', () => {
    const header = signOutbound(payload, now, event.id, secret);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('the digest matches an independent implementation', () => {
    // Guards against both sides agreeing on a *wrong* algorithm.
    const header = signOutbound(payload, now, event.id, secret);
    const expected = createHmac('sha256', secret)
      .update(`${now}.${event.id}.${payload}`)
      .digest('hex');
    expect(header).toBe(`t=${now},v1=${expected}`);
  });
});
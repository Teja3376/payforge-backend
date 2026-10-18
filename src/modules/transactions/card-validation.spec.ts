import { sanitizeCard, assertNotExpired } from './card-validation';
import { splitProRata } from '../webhooks/settlement.service';
import { sanitizeDetails, payloadHash } from './payload-hash';

describe('card validation', () => {
  describe('brand detection', () => {
    it.each([
      ['4111111111111111', 'VISA', '123'],
      ['5555555555554444', 'MASTERCARD', '123'],
      ['378282246310005', 'AMEX', '1234'],
      ['6011111111111117', 'DISCOVER', '123'],
      ['3530111333300000', 'JCB', '123'],
      ['6212345678901232', 'UNIONPAY', '123'],
    ])('maps %s to %s', (cardNumber, brand, cvv) => {
      expect(sanitizeCard(cardNumber, cvv, false).brand).toBe(brand);
    });

    it('maps the Maestro-range laser slug to MAESTRO', () => {
      // Regression: this BIN reports as `laser`, not `maestro`. The original
      // four-brand map rejected it as an unsupported network, which meant
      // Indian Maestro debit cards simply could not pay.
      expect(sanitizeCard('6304000000000000', '123', false).brand).toBe('MAESTRO');
    });

    it('maps diners_club_carte_blanche to DINERS_CLUB', () => {
      // The library returns this slug, which the original map did not cover.
      expect(sanitizeCard('30569309025904', '123', false).brand).toBe('DINERS_CLUB');
    });

    it('returns only the last four digits', () => {
      const result = sanitizeCard('4111111111111111', '123', false);
      expect(result.last4).toBe('1111');
      expect(Object.keys(result).sort()).toEqual(['brand', 'last4']);
    });
  });

  describe('CVV', () => {
    it('accepts the correct CVV length for the brand', () => {
      expect(() => sanitizeCard('4111111111111111', '123', false)).not.toThrow();
      expect(() => sanitizeCard('378282246310005', '1234', false)).not.toThrow();
    });

    it('rejects a CVV of the wrong length', () => {
      expect(() => sanitizeCard('4111111111111111', '1234', false)).toThrow(/security code/);
      expect(() => sanitizeCard('378282246310005', '123', false)).toThrow(/security code/);
    });
  });

  describe('invalid numbers', () => {
    it('rejects a number that fails the Luhn check', () => {
      expect(() => sanitizeCard('4111111111111112', '123', false)).toThrow(/not valid/);
    });

    it('rejects a number of an unsupported length', () => {
      expect(() => sanitizeCard('411111', '123', false)).toThrow();
    });
  });

  describe('test cards in live mode', () => {
    it('refuses a known test BIN when livemode is on', () => {
      expect(() => sanitizeCard('4242424242424242', '123', true)).toThrow(/test card/i);
    });

    it('permits the same BIN when livemode is off', () => {
      expect(() => sanitizeCard('4242424242424242', '123', false)).not.toThrow();
    });
  });

  describe('assertNotExpired', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');

    it('accepts a card expiring this month', () => {
      expect(() => assertNotExpired(6, 2026, now)).not.toThrow();
    });

    it('accepts the last day of the expiry month', () => {
      const lastDay = new Date('2026-06-30T23:59:59.000Z');
      expect(() => assertNotExpired(6, 2026, lastDay)).not.toThrow();
    });

    it('rejects a card whose expiry month has passed', () => {
      expect(() => assertNotExpired(5, 2026, now)).toThrow(/expired/);
    });

    it('rejects a card from a previous year', () => {
      expect(() => assertNotExpired(12, 2025, now)).toThrow(/expired/);
    });

    it('is independent of server timezone', () => {
      // The original compared against local time, so a card could be rejected a
      // day early or accepted a day late depending on the host timezone.
      const justBeforeExpiry = new Date('2026-06-30T23:59:59.000Z');
      expect(() => assertNotExpired(6, 2026, justBeforeExpiry)).not.toThrow();
      expect(() => assertNotExpired(6, 2026, new Date('2026-07-01T00:00:01.000Z'))).toThrow();
    });
  });
});

describe('sanitizeDetails (PCI chokepoint)', () => {
  it('drops PAN and CVV from card details', () => {
    const details = sanitizeDetails({
      method: 'CARD' as never,
      card: {
        holderName: 'Ada Lovelace',
        cardNumber: '4111111111111111',
        cvv: '123',
        expiryMonth: 12,
        expiryYear: 2030,
      },
      livemode: false,
    });

    expect(JSON.stringify(details)).not.toContain('4111111111111111');
    expect(JSON.stringify(details)).not.toContain('123');
    expect(details).toMatchObject({ last4: '1111', holderName: 'Ada Lovelace' });
  });

  it('never includes cardNumber or cvv as keys', () => {
    const details = sanitizeDetails({
      method: 'CARD' as never,
      card: {
        holderName: 'Ada',
        cardNumber: '4111111111111111',
        cvv: '123',
        expiryMonth: 12,
        expiryYear: 2030,
      },
      livemode: false,
    });
    expect(Object.keys(details)).not.toContain('cardNumber');
    expect(Object.keys(details)).not.toContain('cvv');
  });

  it('rejects missing details for the method', () => {
    expect(() => sanitizeDetails({ method: 'UPI' as never })).toThrow(/matches the payment method/);
  });
});

describe('payloadHash', () => {
  const details = {
    method: 'CARD' as const,
    holderName: 'Ada',
    brand: 'VISA',
    last4: '1111',
    expiryMonth: 12,
    expiryYear: 2030,
  };

  it('is stable for identical inputs', () => {
    expect(payloadHash({ paymentPublicId: 'PF-PAY-A', method: 'CARD' as never, details })).toBe(
      payloadHash({ paymentPublicId: 'PF-PAY-A', method: 'CARD' as never, details }),
    );
  });

  it('changes when the last4 changes', () => {
    expect(payloadHash({ paymentPublicId: 'PF-PAY-A', method: 'CARD' as never, details })).not.toBe(
      payloadHash({
        paymentPublicId: 'PF-PAY-A',
        method: 'CARD' as never,
        details: { ...details, last4: '4242' },
      }),
    );
  });

  it('changes when the expiry changes', () => {
    expect(payloadHash({ paymentPublicId: 'PF-PAY-A', method: 'CARD' as never, details })).not.toBe(
      payloadHash({
        paymentPublicId: 'PF-PAY-A',
        method: 'CARD' as never,
        details: { ...details, expiryYear: 2031 },
      }),
    );
  });
});

describe('splitProRata (partial refunds)', () => {
  it('splits proportionally', () => {
    expect(splitProRata(200n, 9800n, 10_000n, 5_000n)).toEqual({ fee: 100n, net: 4_900n });
  });

  it('returns the whole fee and net for a full refund', () => {
    expect(splitProRata(200n, 9800n, 10_000n, 10_000n)).toEqual({ fee: 200n, net: 9_800n });
  });

  it('keeps fee + net equal to the refunded part', () => {
    for (const part of [1n, 333n, 5_000n, 7_777n, 9_999n]) {
      const { fee, net } = splitProRata(200n, 9800n, 10_000n, part);
      expect(fee + net).toBe(part);
    }
  });

  it('guards against a zero gross', () => {
    expect(splitProRata(0n, 0n, 0n, 100n)).toEqual({ fee: 0n, net: 0n });
  });
});
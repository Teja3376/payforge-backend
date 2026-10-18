import { stableHash, assertIdempotencyKey, assertSamePayload } from './idempotency';

describe('idempotency', () => {
  describe('stableHash', () => {
    it('is order-independent', () => {
      // Regression: the original used JSON.stringify on a hand-built object,
      // so reordering keys silently changed the hash and turned a legitimate
      // retry into a spurious 409.
      expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
      expect(stableHash({ a: { x: 1, y: 2 }, b: 3 })).toBe(stableHash({ b: 3, a: { y: 2, x: 1 } }));
    });

    it('ignores undefined members', () => {
      expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
    });

    it('preserves array order', () => {
      expect(stableHash([1, 2, 3])).not.toBe(stableHash([3, 2, 1]));
    });

    it('distinguishes different payloads', () => {
      expect(stableHash({ amount: 100 })).not.toBe(stableHash({ amount: 200 }));
      expect(stableHash({ method: 'CARD' })).not.toBe(stableHash({ method: 'UPI' }));
    });

    it('distinguishes types that stringify alike', () => {
      expect(stableHash({ v: 1 })).not.toBe(stableHash({ v: '1' }));
      expect(stableHash({ v: true })).not.toBe(stableHash({ v: 'true' }));
    });

    it('handles null distinctly from undefined', () => {
      expect(stableHash({ v: null })).not.toBe(stableHash({ v: undefined }));
    });

    it('is stable across calls', () => {
      const input = { paymentPublicId: 'PF-PAY-A', method: 'CARD', details: { last4: '4242' } };
      expect(stableHash(input)).toBe(stableHash(input));
    });
  });

  describe('assertIdempotencyKey', () => {
    it('accepts a normal key', () => {
      expect(assertIdempotencyKey('order-1001')).toBe('order-1001');
    });

    it('rejects a missing key with a stable code', () => {
      expect(() => assertIdempotencyKey(undefined)).toThrow(/Idempotency-Key/);
      expect(() => assertIdempotencyKey('   ')).toThrow(/Idempotency-Key/);
      try {
        assertIdempotencyKey(undefined);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      }
    });

    it('rejects an over-long key', () => {
      expect(() => assertIdempotencyKey('x'.repeat(256))).toThrow(/255 characters or fewer/);
    });

    it('accepts a key at exactly the maximum length', () => {
      expect(assertIdempotencyKey('x'.repeat(255))).toHaveLength(255);
    });
  });

  describe('assertSamePayload', () => {
    it('passes for matching hashes', () => {
      expect(() => assertSamePayload('abc', 'abc')).not.toThrow();
    });

    it('throws a conflict for differing hashes', () => {
      try {
        assertSamePayload('abc', 'def');
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as { code?: string }).code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
      }
    });
  });
});
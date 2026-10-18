import { splitFee, toMinor, toMajorNumber, currencyExponent, addDays } from './money';

describe('money', () => {
  describe('currencyExponent', () => {
    it('defaults to 2 decimals', () => {
      expect(currencyExponent('USD')).toBe(2);
      expect(currencyExponent('INR')).toBe(2);
      expect(currencyExponent('EUR')).toBe(2);
    });

    it('honours zero-decimal currencies', () => {
      expect(currencyExponent('JPY')).toBe(0);
      expect(currencyExponent('KRW')).toBe(0);
    });

    it('honours three-decimal currencies', () => {
      expect(currencyExponent('KWD')).toBe(3);
      // Regression: the original only special-cased KWD, so every other
      // three-decimal Gulf currency was silently scaled by 1000x.
      expect(currencyExponent('BHD')).toBe(3);
      expect(currencyExponent('OMR')).toBe(3);
      expect(currencyExponent('JOD')).toBe(3);
      expect(currencyExponent('TND')).toBe(3);
    });

    it('is case-insensitive', () => {
      expect(currencyExponent('jpy')).toBe(0);
      expect(currencyExponent('kwd')).toBe(3);
    });
  });

  describe('toMinor', () => {
    it('converts using the currency exponent', () => {
      expect(toMinor(1580, 'JPY')).toBe(1580n);
      expect(toMinor(1580, 'USD')).toBe(158_000n);
      expect(toMinor(1.5, 'KWD')).toBe(1500n);
    });

    it('rounds half up at the minor-unit boundary', () => {
      expect(toMinor(10.005, 'USD')).toBe(1001n);
      expect(toMinor(10.004, 'USD')).toBe(1000n);
    });

    it('round-trips through toMajorNumber', () => {
      for (const [amount, currency] of [
        [1580, 'JPY'],
        [950.75, 'INR'],
        [1.234, 'KWD'],
        [0.01, 'USD'],
      ] as const) {
        expect(toMinor(toMajorNumber(toMinor(amount, currency), currency), currency)).toBe(
          toMinor(amount, currency),
        );
      }
    });

    it('rejects non-finite input', () => {
      // Regression: `amount: 1e308` used to produce a 311-digit BigInt and a
      // 500 from the database driver.
      expect(() => toMinor(Infinity, 'USD')).toThrow();
      expect(() => toMinor(NaN, 'USD')).toThrow();
    });
  });

  describe('splitFee', () => {
    it('applies the default 200 basis points', () => {
      expect(splitFee(100_000n)).toEqual({ fee: 2_000n, net: 98_000n });
    });

    it('always sums back to the gross amount', () => {
      // Property check: fee + net must equal gross exactly, for every odd
      // minor-unit amount, or value is created or destroyed.
      for (const gross of [1n, 3n, 7n, 99n, 1001n, 95_075n, 999_999_999n]) {
        const { fee, net } = splitFee(gross);
        expect(fee + net).toBe(gross);
        expect(fee).toBeGreaterThanOrEqual(0n);
        expect(net).toBeGreaterThanOrEqual(0n);
      }
    });

    it('rounds half up rather than truncating', () => {
      // 1 minor unit at 2% = 0.02; truncation would yield 0.
      expect(splitFee(1n).fee).toBe(0n);
      expect(splitFee(50n).fee).toBe(1n);
      expect(splitFee(150n).fee).toBe(3n);
    });

    it('honours a custom basis-point schedule', () => {
      expect(splitFee(100_000n, { basisPoints: 250 })).toEqual({ fee: 2_500n, net: 97_500n });
      expect(splitFee(100_000n, { basisPoints: 0 })).toEqual({ fee: 0n, net: 100_000n });
    });

    it('applies minimum and maximum fee bounds', () => {
      expect(splitFee(1_000n, { basisPoints: 200, minFeeMinor: 50n })).toEqual({ fee: 50n, net: 950n });
      expect(splitFee(100_000n, { basisPoints: 200, maxFeeMinor: 1_000n })).toEqual({
        fee: 1_000n,
        net: 99_000n,
      });
    });

    it('clamps a fee larger than gross but rejects a zero net', () => {
      // The fee is still clamped to gross. But net === 0 cannot be written to
      // `Ledgers` (CHECK amount > 0), so this combination must throw rather
      // than return an unwritable split.
      expect(() => splitFee(10n, { basisPoints: 10_000, minFeeMinor: 1_000n })).toThrow(
        /zero net/i,
      );
      expect(() => splitFee(1n, { basisPoints: 5_000 })).toThrow(/zero net/i);
      expect(splitFee(1n, { basisPoints: 4_900 })).toEqual({ fee: 0n, net: 1n });
    });

    it('rejects a non-positive gross amount', () => {
      expect(() => splitFee(0n)).toThrow();
      expect(() => splitFee(-1n)).toThrow();
    });
  });

  describe('addDays', () => {
    it('adds days across a month boundary', () => {
      const result = addDays(new Date('2026-01-30T00:00:00.000Z'), 3);
      expect(result.toISOString().slice(0, 10)).toBe('2026-02-02');
    });
  });
});
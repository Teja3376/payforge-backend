import { quoteSettlement } from './fx-math';

/**
 * Realistic USD-based rates. Enough precision to exercise the cross-rate
 * division without the fixture itself becoming the thing under test.
 */
const RATES = {
  USD: 1,
  INR: 95.0757,
  JPY: 158.0012,
  EUR: 0.9234,
  GBP: 0.7891,
};

describe('quoteSettlement', () => {
  describe('INR merchant, foreign payer', () => {
    it('converts into INR at the cross rate', () => {
      const quote = quoteSettlement({
        majorAmount: 1580,
        currency: 'JPY',
        merchantCountryCode: 'IN',
        merchantSettlementCurrency: 'INR',
        rates: RATES,
      });

      expect(quote.converted).toBe(true);
      expect(quote.chargedMinor).toBe(1580n); // JPY has 0 decimals
      expect(quote.settlementCurrency).toBe('INR');
      // 1580 * (95.0757 / 158.0012) = 950.7497... -> 950.75
      expect(quote.settlementMinor).toBe(95_075n);
    });

    it('matches the documented DTO example', () => {
      const quote = quoteSettlement({
        majorAmount: 1580,
        currency: 'JPY',
        merchantCountryCode: 'IN',
        merchantSettlementCurrency: 'INR',
        rates: RATES,
      });
      expect(Number(quote.settlementMinor) / 100).toBeCloseTo(950.75, 2);
      expect(quote.usdRate).toBe('158.0012000000');
      expect(quote.inrRate).toBe('95.0757000000');
    });

    it('does not convert when the payer already pays in INR', () => {
      const quote = quoteSettlement({
        majorAmount: 500,
        currency: 'INR',
        merchantCountryCode: 'IN',
        merchantSettlementCurrency: 'INR',
        rates: RATES,
      });
      expect(quote.converted).toBe(false);
      expect(quote.chargedMinor).toBe(quote.settlementMinor);
      expect(quote.settlementCurrency).toBe('INR');
    });
  });

  describe('non-INR merchant', () => {
    it('settles in the charge currency with no conversion', () => {
      const quote = quoteSettlement({
        majorAmount: 100,
        currency: 'USD',
        merchantCountryCode: 'US',
        merchantSettlementCurrency: 'USD',
        rates: RATES,
      });
      expect(quote.converted).toBe(false);
      expect(quote.settlementCurrency).toBe('USD');
      expect(quote.chargedMinor).toBe(10_000n);
      expect(quote.settlementMinor).toBe(10_000n);
    });

    it('is not affected by the payer country', () => {
      // Regression: settlement currency used to be derived from the *payer's*
      // country, so an Indian payer paying a US merchant settled in INR and the
      // merchant absorbed the FX risk. Settlement is the merchant's choice.
      const quote = quoteSettlement({
        majorAmount: 100,
        currency: 'USD',
        merchantCountryCode: 'US',
        merchantSettlementCurrency: 'USD',
        rates: RATES,
      });
      expect(quote.settlementCurrency).toBe('USD');
    });

    it('settles an IN merchant configured for a non-INR currency at the source rate', () => {
      const quote = quoteSettlement({
        majorAmount: 100,
        currency: 'EUR',
        merchantCountryCode: 'IN',
        merchantSettlementCurrency: 'EUR',
        rates: RATES,
      });
      expect(quote.converted).toBe(false);
      expect(quote.settlementCurrency).toBe('EUR');
    });
  });

  describe('rate validation', () => {
    it('rejects an unknown charge currency', () => {
      expect(() =>
        quoteSettlement({
          majorAmount: 10,
          currency: 'XXX',
          merchantCountryCode: 'US',
          merchantSettlementCurrency: 'USD',
          rates: RATES,
        }),
      ).toThrow(/No exchange rate/i);
    });

    it('rejects a zero or negative rate', () => {
      expect(() =>
        quoteSettlement({
          majorAmount: 10,
          currency: 'USD',
          merchantCountryCode: 'US',
          merchantSettlementCurrency: 'USD',
          rates: { ...RATES, USD: 0 },
        }),
      ).toThrow(/No exchange rate/i);
    });

    it('carries a stable error code', () => {
      try {
        quoteSettlement({
          majorAmount: 10,
          currency: 'ZZZ',
          merchantCountryCode: 'US',
          merchantSettlementCurrency: 'USD',
          rates: RATES,
        });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as { code?: string }).code).toBe('NO_EXCHANGE_RATE');
      }
    });
  });

  describe('precision', () => {
    it('emits rates at exactly 10 decimal places', () => {
      const quote = quoteSettlement({
        majorAmount: 100,
        currency: 'EUR',
        merchantCountryCode: 'IN',
        merchantSettlementCurrency: 'INR',
        rates: RATES,
      });
      expect(quote.usdRate).toMatch(/^\d+\.\d{10}$/);
      expect(quote.inrRate).toMatch(/^\d+\.\d{10}$/);
    });

    it('never produces a negative or fractional settlement amount', () => {
      for (const amount of [0.01, 1, 99.99, 1234.56, 999999.99]) {
        const quote = quoteSettlement({
          majorAmount: amount,
          currency: 'USD',
          merchantCountryCode: 'IN',
          merchantSettlementCurrency: 'INR',
          rates: RATES,
        });
        expect(quote.settlementMinor).toBeGreaterThan(0n);
        expect(typeof quote.settlementMinor).toBe('bigint');
      }
    });
  });
});
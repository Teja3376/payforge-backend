import Decimal from 'decimal.js';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { toMinor } from '../../common/money/money';

export type SettlementQuote = {
  chargedMinor: bigint;
  settlementMinor: bigint;
  settlementCurrency: string;
  usdRate: string;
  inrRate: string;
  converted: boolean;
};

/**
 * Quote what the merchant is settled for.
 *
 * Rates arrive as JSON numbers, which have already lost precision before
 * `decimal.js` sees them. Every arithmetic step is therefore stringified to
 * `Decimal` *before* it is used, so at most one rounding of the source data is
 * ever inherited rather than compounding through the division.
 *
 * Settlement currency is decided by the **merchant's** country, not the payer's.
 * The previous implementation keyed off `countryCode` on the *user*, so a US
 * payer paying an Indian merchant settled in USD and the merchant absorbed the
 * FX risk — the opposite of what the merchant configured.
 */
export function quoteSettlement(input: {
  majorAmount: number;
  currency: string;
  merchantCountryCode: string;
  merchantSettlementCurrency: string;
  rates: Record<string, number>;
}): SettlementQuote {
  const currency = input.currency.toUpperCase();
  const merchantCountryCode = input.merchantCountryCode.toUpperCase();
  const settlementCurrency = input.merchantSettlementCurrency.toUpperCase();

  const usdRate = requireRate(input.rates, currency);
  const inrPerUsd = requireRate(input.rates, 'INR');

  const chargedMinor = toMinor(input.majorAmount, currency);

  // Only INR-region merchants get an automatic INR leg. Everyone else settles
  // in their own configured currency, at the source rate, with no conversion.
  const shouldConvert = merchantCountryCode === 'IN' && settlementCurrency === 'INR' && currency !== 'INR';

  if (!shouldConvert) {
    return {
      chargedMinor,
      settlementMinor: chargedMinor,
      settlementCurrency: currency,
      usdRate: formatRate(usdRate),
      inrRate: formatRate(inrPerUsd),
      converted: false,
    };
  }

  const chargedMajor = new Decimal(input.majorAmount);
  const crossRate = new Decimal(inrPerUsd.toString()).div(new Decimal(usdRate.toString()));
  const settlementMajor = chargedMajor.mul(crossRate);

  return {
    chargedMinor,
    settlementMinor: BigInt(
      settlementMajor.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
    ),
    settlementCurrency,
    usdRate: formatRate(usdRate),
    inrRate: formatRate(inrPerUsd),
    converted: true,
  };
}

function requireRate(rates: Record<string, number>, code: string): number {
  const rate = rates[code];
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    throw ApiError.of(ErrorCode.NO_EXCHANGE_RATE, `No exchange rate is available for ${code}.`);
  }
  return rate;
}

/** 10 decimal places, matching the `Decimal(24, 10)` columns. */
function formatRate(rate: number): string {
  return new Decimal(rate.toString()).toFixed(10);
}
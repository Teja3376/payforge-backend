import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { toMinor } from '../../common/money/money';

export type SettlementQuote = {
  chargedMinor: bigint;
  settlementMinor: bigint;
  settlementCurrency: string;
  usdRate: string;
  inrRate: string;
};

export function quoteSettlement(input: {
  majorAmount: number;
  currency: string;
  countryCode: string;
  rates: Record<string, number>;
}): SettlementQuote {
  const currency = input.currency.toUpperCase();
  const countryCode = input.countryCode.toUpperCase();
  const usdRate = input.rates[currency];
  const inrPerUsd = input.rates.INR;

  if (usdRate == null || usdRate <= 0) {
    throw new BadRequestException(`No exchange rate for ${currency}`);
  }
  if (inrPerUsd == null || inrPerUsd <= 0) {
    throw new BadRequestException('No exchange rate for INR');
  }

  const chargedMinor = toMinor(input.majorAmount, currency);
  const convertToInr = countryCode === 'IN' && currency !== 'INR';

  if (!convertToInr) {
    return {
      chargedMinor,
      settlementMinor: chargedMinor,
      settlementCurrency: currency,
      usdRate: new Decimal(usdRate).toFixed(10),
      inrRate: new Decimal(inrPerUsd).toFixed(10),
    };
  }

  const chargedMajor = new Decimal(input.majorAmount);
  const inrMajor = chargedMajor.mul(inrPerUsd).div(usdRate);
  const settlementMinor = BigInt(inrMajor.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));

  return {
    chargedMinor,
    settlementMinor,
    settlementCurrency: 'INR',
    usdRate: new Decimal(usdRate).toFixed(10),
    inrRate: new Decimal(inrPerUsd).toFixed(10),
  };
}

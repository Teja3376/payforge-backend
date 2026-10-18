import Decimal from 'decimal.js';

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (code === 'JPY') {
    return 0;
  }
  if (code === 'KWD') {
    return 3;
  }
  return 2;
}

export function toMinor(major: number, currency: string): bigint {
  const factor = new Decimal(10).pow(currencyExponent(currency));
  const minor = new Decimal(major).mul(factor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return BigInt(minor.toFixed(0));
}

export function toMajorNumber(minor: bigint, currency: string): number {
  const factor = new Decimal(10).pow(currencyExponent(currency));
  return new Decimal(minor.toString()).div(factor).toNumber();
}

export function splitFee(gross: bigint): { fee: bigint; net: bigint } {
  const fee = (gross * 2n) / 100n;
  return { fee, net: gross - fee };
}

export function utcDateOnly(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function calendarMonthsInclusive(createdAt: Date, now: Date): number {
  const months =
    (now.getUTCFullYear() - createdAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - createdAt.getUTCMonth()) +
    1;
  return Math.max(1, months);
}

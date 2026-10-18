import Decimal from 'decimal.js';

/**
 * Currencies whose minor unit is not 1/100.
 *
 * The previous implementation special-cased only JPY and KWD, which silently
 * mis-scaled BHD, JOD, OMR and TND (all 1/1000) and mis-scaled KRW and CLP.
 * A table beats an if-chain the first time a currency is added, and an
 * unmapped 3-letter code defaulting to 2 decimals is the standard convention.
 */
const EXPONENT_OVERRIDES: Record<string, number> = {
  BHD: 3,
  CLP: 0,
  IQD: 3,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

/** Decimal places accepted on a charge, keyed by currency exponent. */
export function currencyExponent(currency: string): number {
  return EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

/** Most minor-unit currencies are whole; these allow a third decimal. */
const SUBDIVISED_MINOR = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/**
 * Maximum charge, in major units.
 *
 * `BigInt` columns are signed 64-bit, so the minor-unit value must stay under
 * 9.22e18. Without this bound, `amount: 1e308` produced a 311-digit BigInt and
 * a 500 from the driver — a cheap log-flooding vector.
 */
export const MAX_MAJOR_AMOUNT = 1_000_000_000;

export function toMinor(major: number, currency: string): bigint {
  if (!Number.isFinite(major)) {
    throw new Error('Amount must be a finite number');
  }
  const factor = new Decimal(10).pow(currencyExponent(currency));
  const minor = new Decimal(major).mul(factor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return BigInt(minor.toFixed(0));
}

export function toMajorNumber(minor: bigint, currency: string): number {
  const factor = new Decimal(10).pow(currencyExponent(currency));
  return new Decimal(minor.toString()).div(factor).toNumber();
}

/** How many decimal places a charge may carry for this currency. */
export function maxDecimalPlaces(currency: string): number {
  return SUBDIVISED_MINOR.has(currency.toUpperCase()) ? 3 : 2;
}

export type FeeSchedule = {
  basisPoints: number;
  minFeeMinor?: bigint | null;
  maxFeeMinor?: bigint | null;
};

/**
 * Split gross into fee and net using integer minor units only.
 *
 * Basis points rather than a hard-coded 2% so fee is per-merchant configurable.
 * `ROUND_HALF_UP` on the fee (not truncation) keeps the effective rate exactly
 * the configured rate, and `net = gross - fee` guarantees the split is exact to
 * the last minor unit with no lost value.
 */
export function splitFee(
  gross: bigint,
  schedule: FeeSchedule = { basisPoints: 200 },
): { fee: bigint; net: bigint } {
  if (gross <= 0n) {
    throw new Error('Cannot split a non-positive amount');
  }
  let fee = (gross * BigInt(schedule.basisPoints) + 5000n) / 10000n;
  if (schedule.minFeeMinor != null && fee < schedule.minFeeMinor) {
    fee = schedule.minFeeMinor;
  }
  if (schedule.maxFeeMinor != null && fee > schedule.maxFeeMinor) {
    fee = schedule.maxFeeMinor;
  }
  if (fee > gross) {
    fee = gross;
  }
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

export function sameUtcMonth(left: Date, right: Date): boolean {
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth()
  );
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
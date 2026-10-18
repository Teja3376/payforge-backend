import { CardValidator } from '@juspay/cards-validator';
import type { CardBrand } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors/api-error';

/**
 * Map the processor's brand slugs onto our enum.
 *
 * The original map covered only `visa | mastercard | amex | rupay` and fell
 * back to reading `details.card_type` — a field that does not exist in
 * `@juspay/cards-validator@0.1.2`, so the fallback was dead code written
 * against an imagined API.
 *
 * The list below is every brand the library can emit. Getting this right is not
 * cosmetic: probing the library directly shows that
 *   - `6304000000000000` (Maestro debit) reports as **`laser`**, not `maestro`
 *   - `30569309025904` (Diners) reports as **`diners_club_carte_blanche`**
 *
 * Both are legitimate, widely-issued instruments that the four-brand map
 * rejected outright as "Card network is not supported".
 */
const BRAND_MAP: Record<string, CardBrand> = {
  visa: 'VISA',
  visa_electron: 'VISA',
  mastercard: 'MASTERCARD',
  maestro: 'MAESTRO',
  // `laser` is what this library returns for many Maestro-range BINs.
  laser: 'MAESTRO',
  rupay: 'RUPAY',
  amex: 'AMEX',
  discover: 'DISCOVER',
  diners_club_carte_blanche: 'DINERS_CLUB',
  diners_club_international: 'DINERS_CLUB',
  jcb: 'JCB',
  unionpay: 'UNIONPAY',
  sodexo: 'OTHER',
};

/** BINs that are always test instruments and must not move real money. */
const TEST_BINS = new Set([
  '411111',
  '401288',
  '424242',
  '400005',
  '555555',
  '510510',
  '520082',
  '378282',
  '371449',
  '601111',
  '601100',
  '305693',
  '620000',
  '630400',
]);

type CardDetails = {
  card_brand?: string;
  valid: boolean;
  luhn_valid: boolean;
  length_valid: boolean;
  cvv_length: number[];
};

export type SanitizedCard = { brand: CardBrand; last4: string };

/**
 * Validate a card and return only what is safe to store.
 *
 * The PAN and CVV exist here as function arguments and go no further: this is
 * the single PCI chokepoint for the legacy direct-card path. Returning
 * `{brand, last4}` makes it impossible for a caller to persist more by
 * accident.
 */
export function sanitizeCard(cardNumber: string, cvv: string, livemode: boolean): SanitizedCard {
  const digits = cardNumber.replace(/[\s-]/g, '');

  const details = new CardValidator(digits).getCardDetails() as CardDetails;

  if (!details.valid) {
    if (details.luhn_valid === false) {
      throw ApiError.of(ErrorCode.CARD_INVALID, 'That card number is not valid.');
    }
    if (details.length_valid === false) {
      throw ApiError.of(
        ErrorCode.CARD_INVALID,
        'That card number has an unsupported length. Check the number and try again.',
      );
    }
    throw ApiError.of(ErrorCode.CARD_INVALID, 'That card number is not valid.');
  }

  if (!details.cvv_length.includes(cvv.length)) {
    throw ApiError.of(
      ErrorCode.CVV_INVALID,
      `That card expects a ${details.cvv_length.join(' or ')}-digit security code.`,
    );
  }

  if (livemode && TEST_BINS.has(digits.slice(0, 6))) {
    throw ApiError.of(
      ErrorCode.CARD_INVALID,
      'That is a test card number. Use a test API key to work with test cards.',
    );
  }

  const rawBrand = (details.card_brand ?? '').toLowerCase();
  const brand = BRAND_MAP[rawBrand];
  if (!brand) {
    throw ApiError.of(
      ErrorCode.CARD_BRAND_UNSUPPORTED,
      `Cards on the ${rawBrand || 'unknown'} network are not supported yet.`,
      { meta: { network: rawBrand } },
    );
  }

  return { brand, last4: digits.slice(-4) };
}

/**
 * Expiry check against UTC.
 *
 * The previous check compared against local server time, so a card expiring at
 * the end of the month was rejected up to a day early in some timezones and
 * accepted a day late in others.
 */
export function assertNotExpired(month: number, year: number, now = new Date()): void {
  // Valid through the last instant of the expiry month.
  const expiresAt = Date.UTC(year, month, 1) - 1;
  if (now.getTime() > expiresAt) {
    throw ApiError.of(ErrorCode.CARD_INVALID, 'That card has expired.');
  }
}
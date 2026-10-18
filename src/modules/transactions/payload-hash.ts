import { PaymentMethod } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { stableHash } from '../../common/idempotency/idempotency';
import { sanitizeCard } from './card-validation';

/**
 * The only card data that is ever persisted or hashed.
 *
 * `cardNumber` and `cvv` are structurally absent from this type, so it is not
 * possible to leak them by accident from a detail object — TypeScript rejects
 * the field before it can reach `payloadHash` or a `CardDetails` insert.
 *
 * Each variant carries its `method`, which makes the union self-discriminating:
 * `switch (details.method)` narrows correctly, so callers never have to cast.
 */
export type SafeMethodDetails =
  | {
      method: 'CARD';
      holderName: string;
      brand: string;
      last4: string;
      expiryMonth: number;
      expiryYear: number;
    }
  | { method: 'UPI'; vpa: string }
  | { method: 'NET_BANKING'; bankCode: string }
  | { method: 'WALLET'; provider: string };

export type MethodDetailsInput = {
  method: PaymentMethod;
  card?: { holderName: string; cardNumber: string; cvv: string; expiryMonth: number; expiryYear: number };
  upi?: { vpa: string };
  netBanking?: { bankCode: string };
  wallet?: { provider: string };
  livemode?: boolean;
};

/**
 * Reduce a request's payment details to the sanitised subset.
 *
 * This is the PCI chokepoint: everything downstream — the idempotency hash, the
 * `CardDetails` row, the API response — consumes this function's output, so
 * there is exactly one place where raw card data is dropped.
 */
export function sanitizeDetails(input: MethodDetailsInput): SafeMethodDetails {
  switch (input.method) {
    case PaymentMethod.CARD: {
      const card = input.card;
      if (!card) {
        throw missingDetails();
      }
      const sanitized = sanitizeCard(card.cardNumber, card.cvv, input.livemode ?? true);
      return {
        method: PaymentMethod.CARD,
        holderName: card.holderName,
        brand: sanitized.brand,
        last4: sanitized.last4,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
      };
    }
    case PaymentMethod.UPI:
      if (!input.upi) {
        throw missingDetails();
      }
      return { method: PaymentMethod.UPI, vpa: input.upi.vpa };
    case PaymentMethod.NET_BANKING:
      if (!input.netBanking) {
        throw missingDetails();
      }
      return { method: PaymentMethod.NET_BANKING, bankCode: input.netBanking.bankCode };
    case PaymentMethod.WALLET:
      if (!input.wallet) {
        throw missingDetails();
      }
      return { method: PaymentMethod.WALLET, provider: input.wallet.provider };
    default:
      throw ApiError.of(ErrorCode.UNSUPPORTED_PAYMENT_METHOD);
  }
}

export type CardDetailsVariant = Extract<SafeMethodDetails, { method: 'CARD' }>;

/** Build details for a previously tokenized instrument. */
export function detailsFromSavedMethod(saved: {
  brand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  holderName: string | null;
}): CardDetailsVariant {
  const currentYear = new Date().getUTCFullYear();
  return {
    method: 'CARD',
    holderName: saved.holderName ?? '',
    brand: saved.brand ?? 'OTHER',
    last4: saved.last4 ?? '',
    expiryMonth: saved.expiryMonth ?? 1,
    expiryYear: saved.expiryYear ?? currentYear,
  };
}

function missingDetails() {
  return ApiError.of(
    ErrorCode.METHOD_DETAILS_MISMATCH,
    'Send the details object that matches the payment method.',
  );
}

/**
 * Hash of everything that defines "the same request".
 *
 * Uses the order-independent `stableHash`, not `JSON.stringify`, so a
 * refactor that reorders object keys cannot turn a legitimate retry into a
 * spurious 409.
 */
export function payloadHash(input: {
  paymentPublicId: string;
  method: PaymentMethod;
  details: SafeMethodDetails;
}): string {
  return stableHash(input);
}
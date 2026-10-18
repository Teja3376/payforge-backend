/**
 * Shared types and enums for PayForge.
 *
 * This package is the single source of truth for the wire contract. The server
 * imports its enum values from Prisma; these mirror them exactly so an SDK user
 * can branch on `payment.status` without stringly-typed guesses.
 *
 * Keeping this dependency-free (zero runtime dependencies) means it is safe to
 * import from anywhere, including a browser bundle or a Lambda.
 */

export const Role = {
  USER: 'USER',
  MERCHANT: 'MERCHANT',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const AccountStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const PaymentStatus = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const TransactionStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  VOIDED: 'VOIDED',
  EXPIRED: 'EXPIRED',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const PaymentMethod = {
  CARD: 'CARD',
  UPI: 'UPI',
  NET_BANKING: 'NET_BANKING',
  WALLET: 'WALLET',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const CardBrand = {
  VISA: 'VISA',
  MASTERCARD: 'MASTERCARD',
  RUPAY: 'RUPAY',
  AMEX: 'AMEX',
  DISCOVER: 'DISCOVER',
  DINERS_CLUB: 'DINERS_CLUB',
  JCB: 'JCB',
  UNIONPAY: 'UNIONPAY',
  MAESTRO: 'MAESTRO',
  OTHER: 'OTHER',
} as const;
export type CardBrand = (typeof CardBrand)[keyof typeof CardBrand];

export const WebhookEventType = {
  PAYMENT_CREATED: 'PAYMENT_CREATED',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_CANCELLED: 'PAYMENT_CANCELLED',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  REFUND_SUCCEEDED: 'REFUND_SUCCEEDED',
  REFUND_FAILED: 'REFUND_FAILED',
  PAYOUT_PAID: 'PAYOUT_PAID',
  PAYOUT_FAILED: 'PAYOUT_FAILED',
} as const;
export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

export const PayoutStatus = {
  SCHEDULED: 'SCHEDULED',
  IN_TRANSIT: 'IN_TRANSIT',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

/** Every scope an API key may hold. Grant the minimum an integration needs. */
export const Scope = {
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_WRITE: 'payments:write',
  TRANSACTIONS_READ: 'transactions:read',
  TRANSACTIONS_WRITE: 'transactions:write',
  REFUNDS_READ: 'refunds:read',
  REFUNDS_WRITE: 'refunds:write',
  PAYOUTS_READ: 'payouts:read',
  PAYOUTS_WRITE: 'payouts:write',
  MERCHANT_READ: 'merchant:read',
  MERCHANT_WRITE: 'merchant:write',
  API_KEYS_MANAGE: 'apikeys:manage',
  WEBHOOKS_MANAGE: 'webhooks:manage',
  ALL: '*',
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type Money = { amount: number; currency: string };

export type Payment = {
  publicId: string;
  merchantPublicId: string;
  merchantName: string;
  payerPublicId: string;
  amount: number;
  currency: string;
  fxRateDate: string;
  usdRate: string;
  inrRate: string;
  settlementAmount: number;
  settlementCurrency: string;
  feeBasisPoints: number;
  refundedAmount: number;
  description?: string | null;
  status: PaymentStatus;
  expiresAt: string;
  createdAt: string;
};

export type MethodDetails =
  | { holderName: string; brand: CardBrand; last4: string; expiryMonth: number; expiryYear: number }
  | { vpa: string }
  | { bankCode: string }
  | { provider: string };

export type Transaction = {
  publicId: string;
  paymentId: string;
  merchantPublicId: string;
  method: PaymentMethod;
  methodDetails: MethodDetails | null;
  amount: number;
  currency: string;
  fee: number;
  netAmount: number;
  feeBasisPoints: number;
  status: TransactionStatus;
  failureCode: string | null;
  failureMessage: string | null;
  settledAt: string | null;
  createdAt: string;
};

export type Refund = {
  publicId: string;
  paymentId: string;
  amount: number;
  currency: string;
  feeReversed: number;
  netReversed: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  reason: string | null;
  createdAt: string;
};

export type Payout = {
  publicId: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  externalRef: string | null;
  failureReason: string | null;
  processedAt: string | null;
  createdAt: string;
};

export type Balance = { currency: string; amount: number; pending: number };

export type Merchant = {
  publicId: string;
  name: string;
  email: string;
  status: AccountStatus;
  countryCode: string;
  settlementCurrency: string;
  settlementDelayDays: number;
  feeBasisPoints: number;
  /**
   * Which environment this merchant transacts in.
   *
   * The server gates test-card acceptance on this field, not on `ApiKey.mode`:
   * `ApiKey.mode` is stored and displayed but never enforced.
   */
  mode?: 'TEST' | 'LIVE';
  /** The per-merchant fee schedule, when one has been set. */
  feeSchedule?: {
    basisPoints: number;
    minFeeMinor?: string | null;
    maxFeeMinor?: string | null;
  };
  kyc: { status: string } & Record<string, unknown>;
  balances: Balance[];
  createdAt: string;
};

export type LedgerEntry = {
  publicId: string;
  currency: string;
  type: 'CREDIT' | 'DEBIT';
  amount: number;
  balanceAfter: number | null;
  referenceId: string;
  createdAt: string;
};

export type ApiKeySummary = {
  publicId: string;
  name: string;
  prefix: string;
  scopes: string[];
  mode: 'LIVE' | 'TEST';
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

/** The response returned when a key is first created. The secret appears once. */
export type CreatedApiKey = ApiKeySummary & { key: string };

export type ClientSession = {
  clientSecret: string;
  expiresAt: string;
  providerSession: string;
};

export type SavedPaymentMethod = {
  publicId: string;
  customerRef: string | null;
  type: string;
  brand: CardBrand | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  holderName: string | null;
  status: string;
  createdAt: string;
};

export type WebhookEndpoint = {
  publicId: string;
  url: string;
  events: string[];
  status: 'ACTIVE' | 'DISABLED';
  description: string | null;
  failureCount: number;
  createdAt: string;
};

export type WebhookDelivery = {
  publicId: string;
  eventId: string;
  eventType: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD';
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

/** The single error envelope every PayForge endpoint returns. */
export type ApiErrorBody = {
  statusCode: number;
  error: string;
  /** Stable. Branch on this, not on `message`. */
  code: string;
  message: string;
  requestId: string;
  details?: string[];
};

export type Page<T> = {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type WebhookEvent<T = unknown> = {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  livemode: boolean;
  data: T;
};
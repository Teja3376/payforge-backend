import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

/** Nest ships no `TooManyRequestsException`, so map 429 onto the base class. */
class TooManyRequestsException extends HttpException {
  constructor(body: string | Record<string, unknown>) {
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Stable, machine-readable error codes.
 *
 * These strings are part of PayForge's public API contract. They are safe to
 * branch on from an SDK. The human-readable `message` is for humans and may be
 * reworded at any time; `code` will not change without a version bump.
 *
 * Always use `ApiError.of(...)` rather than throwing bare Nest exceptions so
 * that every error carries a code.
 */
export const ErrorCode = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  NO_EXCHANGE_RATE: 'NO_EXCHANGE_RATE',
  PAYMENT_FINALIZED: 'PAYMENT_FINALIZED',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  CARD_INVALID: 'CARD_INVALID',
  CARD_DECLINED: 'CARD_DECLINED',
  CARD_BRAND_UNSUPPORTED: 'CARD_BRAND_UNSUPPORTED',
  CVV_INVALID: 'CVV_INVALID',
  METHOD_DETAILS_MISMATCH: 'METHOD_DETAILS_MISMATCH',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',

  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  MERCHANT_CANNOT_RECEIVE: 'MERCHANT_CANNOT_RECEIVE',
  MERCHANT_NOT_ACTIVE: 'MERCHANT_NOT_ACTIVE',

  // 404
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  MERCHANT_NOT_FOUND: 'MERCHANT_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  REFUND_NOT_FOUND: 'REFUND_NOT_FOUND',
  PAYOUT_NOT_FOUND: 'PAYOUT_NOT_FOUND',
  DESTINATION_NOT_FOUND: 'DESTINATION_NOT_FOUND',
  API_KEY_NOT_FOUND: 'API_KEY_NOT_FOUND',
  CLIENT_SESSION_NOT_FOUND: 'CLIENT_SESSION_NOT_FOUND',

  // 409
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  PAYMENT_HAS_OPEN_TRANSACTION: 'PAYMENT_HAS_OPEN_TRANSACTION',
  TRANSACTION_FINALIZED: 'TRANSACTION_FINALIZED',
  PAYMENT_NOT_REFUNDABLE: 'PAYMENT_NOT_REFUNDABLE',
  REFUND_EXCEEDS_REMAINING: 'REFUND_EXCEEDS_REMAINING',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  ALREADY_IN_STATE: 'ALREADY_IN_STATE',
  KEY_PREFIX_COLLISION: 'KEY_PREFIX_COLLISION',

  // 422
  CLIENT_SESSION_EXPIRED: 'CLIENT_SESSION_EXPIRED',
  CLIENT_SESSION_CONSUMED: 'CLIENT_SESSION_CONSUMED',
  UNSUPPORTED_PAYMENT_METHOD: 'UNSUPPORTED_PAYMENT_METHOD',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',

  // 5xx
  BANK_CHARGE_FAILED: 'BANK_CHARGE_FAILED',
  BANK_UNAVAILABLE: 'BANK_UNAVAILABLE',
  EXCHANGE_RATES_UNAVAILABLE: 'EXCHANGE_RATES_UNAVAILABLE',
  PAYOUT_FAILED: 'PAYOUT_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

type StatusForCode = Record<ErrorCodeValue, number>;

const STATUS: StatusForCode = {
  [ErrorCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.AMOUNT_OUT_OF_RANGE]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UNSUPPORTED_CURRENCY]: HttpStatus.BAD_REQUEST,
  [ErrorCode.NO_EXCHANGE_RATE]: HttpStatus.BAD_REQUEST,
  [ErrorCode.PAYMENT_FINALIZED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.PAYMENT_EXPIRED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.CARD_INVALID]: HttpStatus.BAD_REQUEST,
  [ErrorCode.CARD_DECLINED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.CARD_BRAND_UNSUPPORTED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.CVV_INVALID]: HttpStatus.BAD_REQUEST,
  [ErrorCode.METHOD_DETAILS_MISMATCH]: HttpStatus.BAD_REQUEST,
  [ErrorCode.IDEMPOTENCY_KEY_REQUIRED]: HttpStatus.BAD_REQUEST,

  [ErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.INVALID_CREDENTIALS]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_EXPIRED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.TOKEN_REVOKED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.INVALID_API_KEY]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.INVALID_WEBHOOK_SIGNATURE]: HttpStatus.UNAUTHORIZED,

  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.INSUFFICIENT_SCOPE]: HttpStatus.FORBIDDEN,
  [ErrorCode.ACCOUNT_SUSPENDED]: HttpStatus.FORBIDDEN,
  [ErrorCode.MERCHANT_CANNOT_RECEIVE]: HttpStatus.FORBIDDEN,
  [ErrorCode.MERCHANT_NOT_ACTIVE]: HttpStatus.FORBIDDEN,

  [ErrorCode.PAYMENT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.TRANSACTION_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.MERCHANT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.USER_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.REFUND_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.PAYOUT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.DESTINATION_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.API_KEY_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.CLIENT_SESSION_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: HttpStatus.CONFLICT,
  [ErrorCode.IDEMPOTENCY_PAYLOAD_MISMATCH]: HttpStatus.CONFLICT,
  [ErrorCode.PAYMENT_HAS_OPEN_TRANSACTION]: HttpStatus.CONFLICT,
  [ErrorCode.TRANSACTION_FINALIZED]: HttpStatus.CONFLICT,
  [ErrorCode.PAYMENT_NOT_REFUNDABLE]: HttpStatus.CONFLICT,
  [ErrorCode.REFUND_EXCEEDS_REMAINING]: HttpStatus.CONFLICT,
  [ErrorCode.INSUFFICIENT_BALANCE]: HttpStatus.CONFLICT,
  [ErrorCode.EMAIL_TAKEN]: HttpStatus.CONFLICT,
  [ErrorCode.ALREADY_IN_STATE]: HttpStatus.CONFLICT,
  [ErrorCode.KEY_PREFIX_COLLISION]: HttpStatus.CONFLICT,

  [ErrorCode.CLIENT_SESSION_EXPIRED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.CLIENT_SESSION_CONSUMED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.UNSUPPORTED_PAYMENT_METHOD]: HttpStatus.UNPROCESSABLE_ENTITY,

  [ErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.ACCOUNT_LOCKED]: HttpStatus.TOO_MANY_REQUESTS,

  [ErrorCode.BANK_CHARGE_FAILED]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.BANK_UNAVAILABLE]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.EXCHANGE_RATES_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.PAYOUT_FAILED]: HttpStatus.BAD_GATEWAY,
  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Generic human-readable fallback, used when a code has no bespoke message. */
const DEFAULT_MESSAGE: Partial<Record<ErrorCodeValue, string>> = {
  [ErrorCode.VALIDATION_FAILED]: 'Some of the information you sent is not valid.',
  [ErrorCode.UNAUTHENTICATED]: 'Please sign in. This request has no login token.',
  [ErrorCode.TOKEN_EXPIRED]: 'Your login session has expired. Please sign in again.',
  [ErrorCode.TOKEN_REVOKED]: 'Your login session is no longer valid. Please sign in again.',
  [ErrorCode.INVALID_API_KEY]: 'The API key is missing or not valid.',
  [ErrorCode.FORBIDDEN]: 'You do not have permission to do this.',
  [ErrorCode.RATE_LIMITED]: 'Too many requests. Please slow down and retry shortly.',
  [ErrorCode.INTERNAL_ERROR]: 'Something went wrong on our side. Please try again.',
};

/**
 * An HttpException that always carries a stable machine-readable `code`.
 *
 * The HTTP exception filter unwraps this into the documented error envelope:
 * `{ statusCode, error, code, message, requestId, details? }`.
 */
export class ApiError extends HttpException {
  readonly code: ErrorCodeValue;
  readonly details?: string[];
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ErrorCodeValue,
    message?: string,
    options?: { details?: string[]; meta?: Record<string, unknown>; cause?: unknown },
  ) {
    super(
      {
        statusCode: STATUS[code],
        code,
        message: message ?? DEFAULT_MESSAGE[code] ?? 'Request failed.',
        ...(options?.details ? { details: options.details } : {}),
        ...(options?.meta ? { meta: options.meta } : {}),
      },
      STATUS[code],
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.code = code;
    this.details = options?.details;
    this.meta = options?.meta;
  }

  /**
   * Build the right concrete exception subclass for a code.
   *
   * Kept as static factories rather than one generic class so that Nest's own
   * `instanceof BadRequestException` handling keeps working.
   *
   * The `code` is attached as a property on the thrown exception *as well as*
   * embedded in the response body. Without this, `catch (e) { e.code }` is
   * `undefined` — the code only exists inside `getResponse()` — so any branch
   * that keys off the code silently takes the wrong path.
   */
  static of(
    code: ErrorCodeValue,
    message?: string,
    options?: { details?: string[]; meta?: Record<string, unknown>; cause?: unknown },
  ): HttpException & { code: ErrorCodeValue } {
    const body = {
      statusCode: STATUS[code],
      code,
      message: message ?? DEFAULT_MESSAGE[code] ?? 'Request failed.',
      ...(options?.details ? { details: options.details } : {}),
      ...(options?.meta ? { meta: options.meta } : {}),
    };
    const cause: { cause?: unknown } =
      options?.cause !== undefined ? { cause: options.cause } : {};

    return Object.assign(buildException(STATUS[code], body, cause), { code });
  }

  statusOf(code: ErrorCodeValue): number {
    return STATUS[code];
  }
}

function buildException(
  status: number,
  body: Record<string, unknown>,
  cause: { cause?: unknown },
): HttpException {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return new BadRequestException(body, cause);
    case HttpStatus.UNAUTHORIZED:
      return new UnauthorizedException(body, cause);
    case HttpStatus.FORBIDDEN:
      return new ForbiddenException(body, cause);
    case HttpStatus.NOT_FOUND:
      return new NotFoundException(body, cause);
    case HttpStatus.CONFLICT:
      return new ConflictException(body, cause);
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return new UnprocessableEntityException(body, cause);
    case HttpStatus.TOO_MANY_REQUESTS:
      return new TooManyRequestsException(body);
    case HttpStatus.BAD_GATEWAY:
      return new BadGatewayException(body, cause);
    case HttpStatus.SERVICE_UNAVAILABLE:
      return new ServiceUnavailableException(body, cause);
    default:
      return new HttpException(body, status, cause as never);
  }
}

export { STATUS as HTTP_STATUS_FOR_CODE };
import type {
  ApiErrorBody,
  ApiKeySummary,
  ClientSession,
  CreatedApiKey,
  LedgerEntry,
  Merchant,
  Page,
  Payment,
  Payout,
  Refund,
  SavedPaymentMethod,
  Scope,
  Transaction,
  WebhookDelivery,
  WebhookEndpoint,
} from '@payforge/types';

export class PayForgeError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly requestId: string;
  readonly details?: string[];

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'PayForgeError';
    this.code = body.code;
    this.statusCode = body.statusCode;
    this.requestId = body.requestId;
    this.details = body.details;
  }

  /** True for 401/403/429 and any 5xx — the retryable class. */
  get isRetryable(): boolean {
    return this.statusCode === 429 || this.statusCode >= 500;
  }

  /** True when the caller is missing a scope the endpoint requires. */
  get isScopeError(): boolean {
    return this.code === 'INSUFFICIENT_SCOPE';
  }

  /** True when a unique-constraint conflict means the request lost a race. */
  get isConflict(): boolean {
    return this.statusCode === 409;
  }
}

export type PayForgeClientOptions = {
  /**
   * API key. Server-side only — never ship this to a browser.
   *
   * Mutually exclusive with `accessToken`. The server rejects a request that
   * carries both credential types rather than guessing which was intended.
   */
  apiKey?: string;
  /**
   * A login access token, for operator and dashboard flows.
   *
   * The server accepts either an API key or a session JWT, never both. This
   * option existed to be the second half of that: without it the client could
   * only ever present an API key, so every `/auth/*` route was unreachable.
   */
  accessToken?: string | (() => string | Promise<string>);
  /** Defaults to `https://api.payforge.dev/v1`. */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 30_000. */
  timeoutMs?: number;
  /** Retries for 429 and 5xx, with exponential backoff. Defaults to 2. */
  maxRetries?: number;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
};

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Send no credential. Used by `/auth/login` and `/auth/refresh`. */
  anonymous?: boolean;
};

/** Response of POST /auth/login and POST /auth/refresh. */
export type SessionResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  user?: {
    publicId: string;
    email: string;
    role: string;
    merchantPublicId: string | null;
    merchantStatus: string | null;
  };
};

/** One row of GET /auth/sessions. */
export type SessionSummary = {
  publicId: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
};

const DEFAULT_BASE_URL = 'https://api.payforge.dev/v1';

/**
 * Thin, typed server SDK for the PayForge API.
 *
 * Deliberately a thin `fetch` wrapper: no client-side state machine, no
 * connection pool, no retry logic that could reorder requests. Everything the
 * server guarantees (idempotency, cursor pagination, stable error codes) is
 * surfaced as-is so the SDK cannot obscure it.
 *
 * It is *server-side* code. In a browser, use `@payforge/react` plus your own
 * backend — an API key must never ship to a client.
 */
export class PayForge {
  private readonly apiKey: string | undefined;
  private readonly accessToken: string | (() => string | Promise<string>) | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: PayForgeClientOptions) {
    if (!options.apiKey && !options.accessToken) {
      throw new Error(
        'A credential is required: pass `apiKey` for server integrations or `accessToken` for operator sessions.',
      );
    }
    if (options.apiKey && options.accessToken) {
      // The server rejects a request carrying both, so fail here with a clear
      // message rather than 401 on every call.
      throw new Error('Pass either `apiKey` or `accessToken`, not both.');
    }
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.extraHeaders = options.headers ?? {};

    if (typeof globalThis.window !== 'undefined' && this.apiKey) {
      // Not a security boundary — a bundler can strip this — but it turns a
      // silent leak into an immediate, obvious failure.
      throw new Error(
        'An API key was supplied in a browser environment. API keys must stay on your server; ' +
          'use `@payforge/react` with a client secret minted by your backend instead.',
      );
    }
  }

  // --- Authentication --------------------------------------------------------

  /**
   * Session authentication.
   *
   * These routes are unusable with an API key: they operate on a user's own
   * sessions rather than a merchant's.
   */
  auth = {
    login: (input: { email: string; password: string }) =>
      this.request<SessionResponse>('POST', '/auth/login', { body: input, anonymous: true }),

    refresh: (input: { refreshToken: string }) =>
      this.request<SessionResponse>('POST', '/auth/refresh', { body: input, anonymous: true }),

    logout: () => this.request<void>('POST', '/auth/logout'),

    changePassword: (input: { currentPassword: string; newPassword: string }) =>
      this.request<{ changed: boolean }>('POST', '/auth/password', { body: input }),

    listSessions: () => this.request<SessionSummary[]>('GET', '/auth/sessions'),

    revokeSession: (publicId: string) => this.request<void>('DELETE', `/auth/sessions/${publicId}`),
  };

  // --- Payments -------------------------------------------------------------

  /**
   * Stable `PayForge.PayForgeError` for `instanceof` checks without a second
   * import.
   */
  static readonly PayForgeError = PayForgeError;

  payments = {
    create: (
      input: {
        merchantPublicId: string;
        amount: number;
        currency: string;
        description?: string;
        metadata?: Record<string, unknown>;
      },
      options: { idempotencyKey: string },
    ) =>
      this.request<Payment>('POST', '/payments', {
        body: input,
        idempotencyKey: options.idempotencyKey,
      }),

    retrieve: (publicId: string) => this.request<Payment>('GET', `/payments/${publicId}`),

    cancel: (publicId: string, reason?: string) =>
      this.request<Payment>('POST', `/payments/${publicId}/cancel`, { body: { reason } }),

    list: (params: ListParams = {}) =>
      this.request<Page<Payment>>('GET', '/payments', { query: params }),
  };

  // --- Transactions ---------------------------------------------------------

  transactions = {
    /**
     * Prefer charging a `savedPaymentMethodId` over resending card data.
     */
    create: (
      input: {
        paymentPublicId: string;
        method: 'CARD' | 'UPI' | 'NET_BANKING' | 'WALLET';
        /** Single-use token from the hosted-fields iframe. PCI-safe. */
        gatewayToken?: string;
        /** A card previously saved against this merchant. */
        savedPaymentMethodId?: string;
        card?: {
          holderName: string;
          cardNumber: string;
          cvv: string;
          expiryMonth: number;
          expiryYear: number;
        };
        upi?: { vpa: string };
        netBanking?: { bankCode: string };
        wallet?: { provider: string };
      },
      options: { idempotencyKey: string },
    ) =>
      this.request<Transaction>('POST', '/transactions', {
        body: input,
        idempotencyKey: options.idempotencyKey,
      }),

    retrieve: (publicId: string) => this.request<Transaction>('GET', `/transactions/${publicId}`),

    list: (params: ListParams = {}) =>
      this.request<Page<Transaction>>('GET', '/transactions', { query: params }),
  };

  // --- Tokenization ---------------------------------------------------------

  /**
   * Mint a client secret for hosted card fields.
   *
   * This is the PCI-safe path: the PAN is captured inside the provider's iframe
   * and never transits PayForge servers.
   */
  clientSession = (input: { paymentId?: string } = {}) =>
    this.request<ClientSession>('POST', '/payments/client-session', { body: input });

  paymentMethods = {
    save: (input: {
      gatewayToken: string;
      customerRef?: string;
      brand?: string;
      last4?: string;
      expiryMonth?: number;
      expiryYear?: number;
      holderName?: string;
    }) => this.request<SavedPaymentMethod>('POST', '/payments/payment-methods', { body: input }),

    list: (params: { customerRef?: string } = {}) =>
      this.request<SavedPaymentMethod[]>('GET', '/payments/payment-methods', {
        query: params as Record<string, string | undefined>,
      }),
  };

  // --- Refunds --------------------------------------------------------------

  refunds = {
    /** Omit `amount` for a full refund of the remaining balance. */
    create: (
      input: { paymentId: string; amount?: number; reason?: string },
      options: { idempotencyKey: string },
    ) =>
      this.request<Refund>('POST', '/refunds', {
        body: input,
        idempotencyKey: options.idempotencyKey,
      }),

    retrieve: (publicId: string) => this.request<Refund>('GET', `/refunds/${publicId}`),

    list: (params: ListParams = {}) =>
      this.request<Page<Refund>>('GET', '/refunds', { query: params }),
  };

  // --- Payouts --------------------------------------------------------------

  payouts = {
    create: (
      input: { amount: number; currency: string; destinationId?: string },
      options: { idempotencyKey: string },
    ) =>
      this.request<Payout>('POST', '/payouts', {
        body: input,
        idempotencyKey: options.idempotencyKey,
      }),

    retrieve: (publicId: string) => this.request<Payout>('GET', `/payouts/${publicId}`),

    list: (params: ListParams = {}) =>
      this.request<Page<Payout>>('GET', '/payouts', { query: params }),

    addDestination: (input: {
      bankName: string;
      accountHolder: string;
      accountNumber: string;
      routingCode: string;
      currency: string;
      isDefault?: boolean;
    }) => this.request<unknown>('POST', '/payouts/destinations', { body: input }),

    listDestinations: () => this.request<unknown[]>('GET', '/payouts/destinations'),
  };

  // --- Merchant -------------------------------------------------------------

  merchant = {
    retrieve: () => this.request<Merchant>('GET', '/merchants/me'),

    update: (patch: { name?: string; countryCode?: string }) =>
      this.request<Merchant>('PATCH', '/merchants/me', { body: patch }),

    statement: (params: ListParams & { currency?: string } = {}) =>
      this.request<Page<LedgerEntry>>('GET', '/merchants/me/statement', {
        query: params as Record<string, string | undefined>,
      }),

    submitKyc: (details: Record<string, string>) =>
      this.request<Merchant>('POST', '/merchants/me/kyc', { body: details }),
  };

  // --- Webhooks -------------------------------------------------------------

  webhooks = {
    create: (input: { url: string; events: string[]; description?: string }) =>
      this.request<WebhookEndpoint & { secret: string }>('POST', '/webhooks/endpoints', {
        body: input,
      }),

    list: (params: ListParams = {}) =>
      this.request<Page<WebhookEndpoint>>('GET', '/webhooks/endpoints', { query: params }),

    update: (
      publicId: string,
      patch: { url?: string; events?: string[]; status?: 'ACTIVE' | 'DISABLED' },
    ) => this.request<WebhookEndpoint>('PATCH', `/webhooks/endpoints/${publicId}`, { body: patch }),

    rotateSecret: (publicId: string) =>
      this.request<{ publicId: string; secret: string }>(
        'POST',
        `/webhooks/endpoints/${publicId}/rotate-secret`,
      ),

    deliveries: (publicId: string, params: ListParams = {}) =>
      this.request<Page<WebhookDelivery>>('GET', `/webhooks/endpoints/${publicId}/deliveries`, {
        query: params,
      }),

    redeliver: (deliveryPublicId: string) =>
      this.request<unknown>('POST', `/webhooks/deliveries/${deliveryPublicId}/redeliver`),
  };

  // --- API keys -------------------------------------------------------------

  apiKeys = {
    /** Requires a key with the `apikeys:manage` scope. The secret is shown once. */
    create: (input: { name: string; scopes: Scope[]; mode?: 'LIVE' | 'TEST'; expiresInDays?: number }) =>
      this.request<CreatedApiKey>('POST', '/api-keys', { body: input }),

    list: () => this.request<ApiKeySummary[]>('GET', '/api-keys'),

    revoke: (publicId: string) =>
      this.request<ApiKeySummary>('POST', `/api-keys/${publicId}/revoke`),
  };

  // --- Transport ------------------------------------------------------------

  /**
   * Issue a request with retries.
   *
   * 429 and 5xx are retried, and only when an idempotency key was sent:
   * retrying an identical keyed request is safe, whereas retrying a
   * non-idempotent write after an ambiguous failure is how you get two payments
   * for one order. Anything else is surfaced immediately.
   *
   * (An earlier version of this comment claimed the opposite condition. The
   * code was always right; the comment was wrong.)
   */
  private async request<T>(
    method: NonNullable<RequestOptions['method']>,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.extraHeaders,
    };

    // Exactly one credential. The server rejects a request carrying both, so
    // the SDK never sends both even if `headers` happens to contain one: the
    // authenticated credential is applied last and wins.
    if (options.anonymous) {
      delete headers['x-api-key'];
      delete headers['authorization'];
    } else if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
      delete headers['authorization'];
    } else if (this.accessToken) {
      const token =
        typeof this.accessToken === 'function' ? await this.accessToken() : this.accessToken;
      headers['authorization'] = `Bearer ${token}`;
      delete headers['x-api-key'];
    }

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (options.idempotencyKey) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    const canRetry = options.idempotencyKey !== undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.send<T>(method, url, headers, options);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof PayForgeError && error.isRetryable && canRetry && attempt < this.maxRetries;
        if (!retryable) {
          throw error;
        }
        await sleep(2 ** attempt * 250 + Math.floor(Math.random() * 100));
      }
    }

    throw lastError;
  }

  private async send<T>(
    method: NonNullable<RequestOptions['method']>,
    url: URL,
    headers: Record<string, string>,
    options: RequestOptions,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    // Honour a caller-supplied signal alongside our own timeout.
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort);

    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();

      if (!response.ok) {
        let body: ApiErrorBody;
        try {
          body = JSON.parse(text) as ApiErrorBody;
        } catch {
          throw new PayForgeError({
            statusCode: response.status,
            error: 'Unknown',
            code: 'UNPARSEABLE_ERROR',
            message: text.slice(0, 300) || `Request failed with ${response.status}`,
            requestId: response.headers.get('x-request-id') ?? 'unknown',
          });
        }
        throw new PayForgeError(body);
      }

      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export type ListParams = {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
};

/**
 * Walk every page of a cursor-paginated endpoint.
 *
 * Yields individual items so callers do not have to manage cursors or worry
 * about the shape of the response envelope.
 *
 *   for await (const payment of paginate((cursor) =>
 *     payforge.payments.list({ limit: 100, cursor }),
 *   )) {
 *     console.log(payment.publicId);
 *   }
 */
export async function* paginate<T>(
  fetchPage: (cursor?: string) => Promise<{ data: T[]; hasMore: boolean; nextCursor: string | null }>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page: { data: T[]; hasMore: boolean; nextCursor: string | null } =
      await fetchPage(cursor);
    for (const item of page.data) {
      yield item;
    }
    if (!page.hasMore || !page.nextCursor) {
      return;
    }
    cursor = page.nextCursor;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { verifyWebhookSignature, parseWebhookEvent } from './webhooks';
export type { WebhookEndpoint, WebhookDelivery } from '@payforge/types';
export default PayForge;
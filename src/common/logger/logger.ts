import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

/**
 * Per-request context, propagated through pino automatically.
 *
 * Every log line emitted while handling a request carries `requestId` and, when
 * the caller authenticated, `actorId`/`actorType`. This is what makes a
 * support conversation ("my payout is stuck") answerable: you search the log
 * by the requestId from the error response.
 */
export type RequestContext = {
  requestId: string;
  actorId?: string;
  actorType?: string;
  merchantId?: string;
  method?: string;
  path?: string;
  ip?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, patch);
  }
}

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Fields that must never reach the log sink.
 *
 * Card data is redacted by key name rather than by DTO-aware scrubbing so it
 * holds for any future code path, including third-party error objects that
 * embed the request body.
 */
const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-payforge-signature"]',
  'cardNumber',
  'cvv',
  '*.cardNumber',
  '*.cvv',
  '*.card.cardNumber',
  '*.card.cvv',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'rawKey',
  'accountEnc',
  'routingEnc',
  'secretEnc',
  'accountNumber',
];

export function createLogger(options: { pretty: boolean }) {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACTED, censor: '[redacted]' },
    base: { service: 'payforge' },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: true, ignore: 'pid,hostname,service' },
          },
        }
      : {}),
    mixin() {
      // Actor identity is useful on every line; request shape is already
      // logged once per request by the middleware, so it is omitted here.
      const context = storage.getStore();
      if (!context) {
        return {};
      }
      const { actorId, actorType, merchantId } = context;
      return { actorId, actorType, merchantId };
    },
  });
}

export const logger = createLogger({
  pretty: process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY !== 'false',
});

export type Logger = typeof logger;
/**
 * OAuth-style scopes for API keys.
 *
 * API keys are the credential merchants use from their own servers. Scopes let
 * a merchant issue a read-only key for their dashboard and a write-capable key
 * for their checkout service, independently revocable.
 */
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
  /** Grants every scope above. Reserved for the platform's own automation. */
  ALL: '*',
} as const;

export type ScopeValue = (typeof Scope)[keyof typeof Scope];

export const ALL_SCOPES: ScopeValue[] = [
  Scope.PAYMENTS_READ,
  Scope.PAYMENTS_WRITE,
  Scope.TRANSACTIONS_READ,
  Scope.TRANSACTIONS_WRITE,
  Scope.REFUNDS_READ,
  Scope.REFUNDS_WRITE,
  Scope.PAYOUTS_READ,
  Scope.PAYOUTS_WRITE,
  Scope.MERCHANT_READ,
  Scope.MERCHANT_WRITE,
  Scope.API_KEYS_MANAGE,
  Scope.WEBHOOKS_MANAGE,
];

const SCOPE_SET = new Set<string>([...ALL_SCOPES, Scope.ALL]);

export function isValidScope(value: string): value is ScopeValue {
  return SCOPE_SET.has(value);
}

export function hasScope(granted: string[], required: ScopeValue): boolean {
  return granted.includes(Scope.ALL) || granted.includes(required);
}

/**
 * A key holding `a:b` satisfies a requirement of `a:b:c` — so
 * `transactions:read` grants `transactions:read:one`. Keeps scope strings
 * hierarchical without forcing merchants to enumerate every verb.
 */
export function satisfies(granted: string[], required: string): boolean {
  if (granted.includes(Scope.ALL)) {
    return true;
  }
  if (granted.includes(required)) {
    return true;
  }
  return granted.some((scope) => required.startsWith(`${scope}:`));
}
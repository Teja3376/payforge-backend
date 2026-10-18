import { createHash } from 'crypto';
import { ApiError, ErrorCode } from '../errors/api-error';

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Canonical, order-independent hash of a request payload.
 *
 * `JSON.stringify` on a hand-built object is order-dependent: reordering the
 * keys silently changes the hash and turns a legitimate retry into a spurious
 * "key reused with different payload" 409. Sorting keys recursively makes the
 * hash a function of the payload's *content*, not its serialisation.
 */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalize(v)}`)
    .join(',')}}`;
}

export function assertIdempotencyKey(key: string | undefined): string {
  if (!key || key.trim() === '') {
    throw ApiError.of(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Send an Idempotency-Key header for this request.',
    );
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw ApiError.of(
      ErrorCode.VALIDATION_FAILED,
      `Idempotency-Key must be ${MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer.`,
    );
  }
  return key;
}

export function assertSamePayload(storedHash: string, incomingHash: string): void {
  if (storedHash !== incomingHash) {
    throw ApiError.of(
      ErrorCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
      'This Idempotency-Key was already used with a different payload.',
    );
  }
}
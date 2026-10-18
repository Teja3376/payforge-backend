import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * AES-256-GCM envelope encryption for secrets PayForge must be able to read
 * back: payout bank details and outbound webhook signing secrets.
 *
 * These values are never returned to clients and never logged. The 32-byte key
 * is derived from `ENCRYPTION_KEY` via SHA-256 so that operators can supply any
 * passphrase-length string.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export function encryptSecret(plaintext: string, key: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(payload: string, key: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported ciphertext format');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  const decipher = createDecipheriv(ALGORITHM, deriveKey(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function deriveKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Hash an API key for lookup-then-verify.
 *
 * API keys are 256 bits of `randomBytes`, not user-chosen passwords, so a
 * single SHA-256 is appropriate — it is fast enough that we can look a key up
 * on every request without the latency of bcrypt/argon2. Salving per row is
 * unnecessary: there is no preimage to brute-force.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/** Constant-time compare for hex digests of equal expected length. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Mint an API key.
 *
 * Format: `pf_{live|test}_{prefix}_{secret}`
 *   - `prefix` (12 chars) is stored in plaintext and is the unique lookup key
 *   - `secret` (43 chars) is only ever shown once
 *
 * Splitting the key this way means a leaked database row cannot be used to
 * authenticate, and the lookup stays an indexed equality match.
 *
 * The prefix uses an **alphanumeric-only** alphabet. Base64url would let it
 * contain `_`, which is the field separator, so a fraction of generated keys
 * would split into the wrong number of fields and fail authentication even
 * though nothing was tampered with.
 */
const PREFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateApiKey(mode: 'live' | 'test'): {
  raw: string;
  prefix: string;
  hash: string;
} {
  const bytes = randomBytes(24);
  let prefix = '';
  for (let index = 0; index < 12; index += 1) {
    prefix += PREFIX_ALPHABET[bytes[index] % PREFIX_ALPHABET.length];
  }
  // Hex, not base64url: the secret is the final `_`-delimited field, so it
  // must not contain the delimiter or the key stops parsing cleanly.
  const secret = randomBytes(32).toString('hex');
  const raw = `pf_${mode}_${prefix}_${secret}`;
  return { raw, prefix, hash: hashApiKey(raw) };
}

/** Parse the lookup prefix out of a raw key, or null if it is not well formed. */
export function extractApiKeyPrefix(raw: string): string | null {
  const parts = raw.split('_');
  if (parts.length !== 4) {
    return null;
  }
  const [scheme, mode, prefix] = parts;
  if (scheme !== 'pf') {
    return null;
  }
  if (mode !== 'live' && mode !== 'test') {
    return null;
  }
  if (!/^[A-Za-z0-9]{12}$/.test(prefix)) {
    return null;
  }
  return prefix;
}

/** Opaque high-entropy token for client sessions and refresh tokens. */
export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}
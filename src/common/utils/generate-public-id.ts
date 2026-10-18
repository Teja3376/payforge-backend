import { randomBytes } from 'crypto';

/**
 * Public identifiers are the only identifiers ever exposed over the API, so
 * they must be unguessable rather than merely pretty.
 *
 * 12 base32 characters of CSPRNG output is 60 bits of entropy. The previous
 * implementation used 8 hex characters (32 bits), which both invites
 * enumeration and makes birthday collisions realistic on a `@unique` column
 * at payment volume.
 *
 * Format: `PF-PAY-XXXXXXXXXXXX` (base32 Crockford, no I/L/O/U to avoid
 * transcription errors when an id is read aloud or copied from a screenshot).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_LENGTH = 12;

export function generatePublicId(prefix: string): string {
  const normalizedPrefix = prefix?.trim();
  if (!normalizedPrefix) {
    throw new Error('Prefix is required to generate public id');
  }

  const bytes = randomBytes(ID_LENGTH);
  let out = '';
  for (let index = 0; index < ID_LENGTH; index += 1) {
    // 32 does not divide 256 evenly; discarding the top 4 bits of the last
    // byte would leak a little entropy, so mask to a multiple of 32 instead.
    out += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return `${normalizedPrefix.toUpperCase()}-${out}`;
}

/**
 * Retry wrapper for the rare `@unique` collision on a public id.
 *
 * With 60 bits the collision probability is negligible, but a failed insert
 * would surface to a customer as a 500, so retry a handful of times before
 * giving up.
 */
export async function withPublicId<T>(
  prefix: string,
  insert: (publicId: string) => Promise<T>,
  isCollision: (error: unknown) => boolean,
  attempts = 3,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await insert(generatePublicId(prefix));
    } catch (error) {
      if (attempt === attempts - 1 || !isCollision(error)) {
        throw error;
      }
    }
  }
  throw new Error('unreachable');
}

/** Matches `PF-XXX-XXXXXXXXXXXX`. Used to reject junk in path params early. */
export const PUBLIC_ID_PATTERN = /^PF-[A-Z]{2,8}-[0-9A-HJKMNP-TV-Z]{12}$/;

export function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
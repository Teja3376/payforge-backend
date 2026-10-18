import { generatePublicId, isPublicId, PUBLIC_ID_PATTERN, withPublicId } from './generate-public-id';
import {
  encryptSecret,
  decryptSecret,
  generateApiKey,
  hashApiKey,
  extractApiKeyPrefix,
  generateOpaqueToken,
} from '../crypto/crypto';
import { satisfies, hasScope, Scope } from '../scopes/scopes';

describe('generatePublicId', () => {
  it('produces a prefixed, uppercase id', () => {
    expect(generatePublicId('pf-pay')).toMatch(/^PF-PAY-[0-9A-HJKMNP-TV-Z]{12}$/);
  });

  it('is validated by isPublicId', () => {
    expect(isPublicId(generatePublicId('pf-trx'))).toBe(true);
  });

  it('carries far more entropy than the previous 8-hex implementation', () => {
    // 8 hex chars = 32 bits. 12 base32 chars = 60 bits. At 10^7 payments the
    // old scheme had a birthday collision probability of a few percent.
    const ids = new Set(Array.from({ length: 20_000 }, () => generatePublicId('pf-pay')));
    expect(ids.size).toBe(20_000);
  });

  it('omits visually ambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) {
      const body = generatePublicId('pf-pay').split('-')[2];
      expect(body).not.toMatch(/[ILOU]/);
    }
  });

  it('throws without a prefix', () => {
    expect(() => generatePublicId('')).toThrow(/Prefix is required/);
  });

  describe('isPublicId', () => {
    it('rejects malformed ids', () => {
      expect(isPublicId('nonsense')).toBe(false);
      expect(isPublicId('PF-PAY-TOOSHORT')).toBe(false);
      expect(isPublicId('pf-pay-a1b2c3d4e5f6')).toBe(false); // must be uppercase
      expect(isPublicId(`${'A'.repeat(13)}`)).toBe(false);
    });

    it('accepts a well-formed id', () => {
      expect(PUBLIC_ID_PATTERN.test('PF-PAY-A1B2C3D4E5F6')).toBe(true);
    });
  });

  describe('withPublicId', () => {
    it('returns the inserted value', async () => {
      await expect(withPublicId('pf-pay', async (id) => `ok:${id}`, () => false)).resolves.toMatch(
        /^ok:PF-PAY-/,
      );
    });

    it('retries when the collision predicate matches', async () => {
      let attempts = 0;
      const result = await withPublicId(
        'pf-pay',
        async (id) => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error('unique violation'), { code: 'P2002' });
          }
          return id;
        },
        () => true,
      );
      expect(attempts).toBe(2);
      expect(result).toMatch(/^PF-PAY-/);
    });

    it('gives up after the attempt limit', async () => {
      await expect(
        withPublicId('pf-pay', async () => {
          throw Object.assign(new Error('unique violation'), { code: 'P2002' });
        }, () => true, 2),
      ).rejects.toThrow();
    });

    it('does not retry a non-collision error', async () => {
      let attempts = 0;
      await expect(
        withPublicId(
          'pf-pay',
          async () => {
            attempts += 1;
            throw new Error('connection refused');
          },
          (error) => (error as { code?: string }).code === 'P2002',
        ),
      ).rejects.toThrow('connection refused');
      expect(attempts).toBe(1);
    });
  });
});

describe('crypto', () => {
  const KEY = 'a'.repeat(48);

  describe('encryptSecret / decryptSecret', () => {
    it('round-trips', () => {
      const plaintext = '50100234567890';
      expect(decryptSecret(encryptSecret(plaintext, KEY), KEY)).toBe(plaintext);
    });

    it('produces a different ciphertext each time', () => {
      const first = encryptSecret('same-value', KEY);
      const second = encryptSecret('same-value', KEY);
      expect(first).not.toBe(second);
    });

    it('does not leak the plaintext', () => {
      expect(encryptSecret('super-secret-account', KEY)).not.toContain('super-secret');
    });

    it('fails with the wrong key', () => {
      const ciphertext = encryptSecret('value', KEY);
      expect(() => decryptSecret(ciphertext, 'b'.repeat(48))).toThrow();
    });

    it('rejects a tampered ciphertext', () => {
      const ciphertext = encryptSecret('value', KEY);
      const parts = ciphertext.split('.');
      parts[3] = parts[3].slice(0, -2) + 'AA';
      expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
    });

    it('rejects an unknown ciphertext format', () => {
      expect(() => decryptSecret('not-encrypted', KEY)).toThrow(/Unsupported ciphertext/);
    });
  });

  describe('API keys', () => {
    it('mints a key with the expected shape', () => {
      const { raw, prefix, hash } = generateApiKey('live');
      expect(raw).toMatch(new RegExp(`^pf_live_${prefix}_[A-Za-z0-9_-]+$`));
      expect(prefix).toHaveLength(12);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never stores the secret half', () => {
      const { raw, hash, prefix } = generateApiKey('test');
      expect(hashApiKey(raw)).toBe(hash);
      expect(raw).not.toBe(hash);
      expect(hash.includes(prefix)).toBe(false);
    });

    it('produces unique keys', () => {
      const keys = new Set(Array.from({ length: 500 }, () => generateApiKey('live').raw));
      expect(keys.size).toBe(500);
    });

    it('extracts the lookup prefix', () => {
      const { raw, prefix } = generateApiKey('live');
      expect(extractApiKeyPrefix(raw)).toBe(prefix);
    });

    it('rejects a malformed key', () => {
      expect(extractApiKeyPrefix('not-a-key')).toBeNull();
      expect(extractApiKeyPrefix('pf_prod_abcdefghijkl_secret')).toBeNull();
      expect(extractApiKeyPrefix('xx_live_abcdefghijkl_secret')).toBeNull();
    expect(extractApiKeyPrefix('pf_live_short_secret')).toBeNull();
    expect(extractApiKeyPrefix('pf_live_abcdefghijkl')).toBeNull();
    });
  });

  it('generates distinct opaque tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(500);
    expect(tokens.values().next().value).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('scopes', () => {
  it('matches an exact scope', () => {
    expect(satisfies(['payments:read'], 'payments:read')).toBe(true);
    expect(satisfies(['payments:read'], 'payments:write')).toBe(false);
  });

  it('lets a wildcard grant everything', () => {
    expect(satisfies([Scope.ALL], 'anything:at:all')).toBe(true);
  });

  it('does not let a broader scope grant a narrower sibling', () => {
    // `payments:write` must NOT imply `refunds:write`.
    expect(satisfies(['payments:write'], 'refunds:write')).toBe(false);
  });

  it('treats a colon-delimited grant as hierarchical', () => {
    expect(satisfies(['transactions'], 'transactions:read')).toBe(true);
    expect(satisfies(['transactions:read'], 'transactions:read:one')).toBe(true);
  });

  it('exposes hasScope for direct checks', () => {
    expect(hasScope([Scope.PAYOUTS_WRITE], Scope.PAYOUTS_WRITE)).toBe(true);
    expect(hasScope([Scope.PAYOUTS_WRITE], Scope.PAYOUTS_READ)).toBe(false);
  });
});
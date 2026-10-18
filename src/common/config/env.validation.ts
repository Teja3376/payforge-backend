const REQUIRED_ENV = [
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'WEBHOOK_SIGNING_KEY',
  'BANK_WEBHOOK_SECRET',
  'EXCHANGE_RATE_API_KEY',
  'SUPER_ADMIN_EMAIL',
  'SUPER_ADMIN_PASSWORD',
] as const;

const OPTIONAL_ENV = [
  'PORT',
  'NODE_ENV',
  'LOG_LEVEL',
  'CORS_ORIGINS',
  'ENABLE_DEV_TOOLS',
  'SWAGGER_ENABLED',
  'PLATFORM_FEE_BASIS_POINTS',
  'FX_PROVIDER_URL',
  'PAYOUT_ADAPTER',
] as const;

const MIN_SECRET_LENGTH = 32;

/**
 * Fails fast at boot rather than at the first request.
 *
 * The previous version only checked presence, so a one-character `JWT_SECRET`
 * booted successfully. It also required `MOCK_BANK_SECRET`, which is the
 * *mock* bank's signing key — the production bank secret is separate now.
 */
export function validateEnv(config: Record<string, unknown>) {
  const missing = REQUIRED_ENV.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY', 'WEBHOOK_SIGNING_KEY', 'BANK_WEBHOOK_SECRET'] as const) {
    const value = String(config[key]);
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `${key} must be at least ${MIN_SECRET_LENGTH} characters (got ${value.length}). Generate one with: openssl rand -hex 32`,
      );
    }
  }

  if (String(config.SUPER_ADMIN_PASSWORD).length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const origins = config.CORS_ORIGINS;
  if (typeof origins === 'string' && origins.trim() !== '') {
    for (const origin of origins.split(',').map((value) => value.trim())) {
      if (origin === '*') {
        throw new Error('CORS_ORIGINS must not contain "*". List explicit origins.');
      }
    }
  }

  for (const key of OPTIONAL_ENV) {
    if (!(key in config)) {
      config[key] = undefined;
    }
  }

  return config;
}
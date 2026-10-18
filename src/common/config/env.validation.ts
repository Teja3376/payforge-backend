const REQUIRED_ENV = [
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_SECRET',
  'MOCK_BANK_SECRET',
  'EXCHANGE_RATE_API_KEY',
  'SUPER_ADMIN_EMAIL',
  'SUPER_ADMIN_PASSWORD',
] as const;

export function validateEnv(config: Record<string, unknown>) {
  const missing = REQUIRED_ENV.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  return config;
}

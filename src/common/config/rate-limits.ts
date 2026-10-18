/**
 * Central rate-limit configuration.
 *
 * Read once at module load so the `@Throttle` decorators and the
 * `ThrottlerModule.forRoot` buckets cannot drift apart. Values are overridable
 * by environment variable so a test run, or a NAT'd office egress IP sharing
 * one address, can be accommodated without editing code.
 */
function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const RateLimit = {
  /** Authenticated traffic, per IP, per minute. */
  global: {
    limit: num(process.env.RATE_LIMIT_GLOBAL, 300),
    ttl: num(process.env.RATE_LIMIT_GLOBAL_TTL_MS, 60_000),
  },
  /**
   * `/auth/login` and friends, per IP, per minute.
   *
   * Tight on purpose: it is the credential-stuffing surface, and every attempt
   * also costs a bcrypt comparison of CPU.
   */
  auth: {
    limit: num(process.env.RATE_LIMIT_AUTH, 10),
    ttl: num(process.env.RATE_LIMIT_AUTH_TTL_MS, 60_000),
  },
  /** Bank callbacks arrive in bursts from the processor. */
  bank: {
    limit: num(process.env.RATE_LIMIT_BANK, 600),
    ttl: num(process.env.RATE_LIMIT_BANK_TTL_MS, 60_000),
  },
  /** Merchant self-registration, per IP, per minute. */
  register: {
    limit: num(process.env.RATE_LIMIT_REGISTER, 5),
    ttl: num(process.env.RATE_LIMIT_REGISTER_TTL_MS, 60_000),
  },
  /** Refresh-token exchange. */
  refresh: {
    limit: num(process.env.RATE_LIMIT_REFRESH, 30),
    ttl: num(process.env.RATE_LIMIT_REFRESH_TTL_MS, 60_000),
  },
} as const;
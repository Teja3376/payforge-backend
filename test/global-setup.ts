import { startDatabase, TEST_DATABASE_URL } from './database';
import { applyMigrations, assertSchemaGuards } from './migrate';

/**
 * Boots a real PostgreSQL instance and applies the shipped migrations.
 *
 * The unit suite cannot prove the things that matter most about money, because
 * it never touches a database. Unique constraints, `SELECT … FOR UPDATE`,
 * compare-and-set under concurrency, partial unique indexes and CHECK
 * constraints are the mechanisms the ledger's correctness actually rests on —
 * and none of them exist in a mocked Prisma client.
 *
 * The binary ships via `embedded-postgres`, so this needs neither Homebrew nor
 * Docker. It runs on a fixed port and a temporary data directory removed on
 * teardown, so it cannot collide with a developer's own database.
 */
export default async function globalSetup(): Promise<void> {
  const url = await startDatabase();

  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';

  // Deterministic crypto material: real secrets are not needed to prove
  // invariants, and a fixed key keeps failures reproducible.
  process.env.JWT_SECRET ??= 'integration-jwt-secret-at-least-32-characters';
  process.env.ENCRYPTION_KEY ??= 'integration-encryption-key-at-least-32-chars';
  process.env.WEBHOOK_SIGNING_KEY ??= 'integration-webhook-key-at-least-32-characters';
  process.env.BANK_WEBHOOK_SECRET ??= 'integration-bank-webhook-secret-32-chars';
  process.env.MOCK_BANK_SECRET ??= 'integration-mock-bank-secret';
  process.env.ADMIN_EMAIL ??= 'it-admin@payforge.test';
  process.env.ADMIN_PASSWORD ??= 'integration-admin-password-12';
  process.env.WEBHOOK_SIGNING_TOLERANCE_SECONDS ??= '300';
  process.env.ENABLE_DEV_TOOLS ??= 'false';
  process.env.LOG_LEVEL ??= 'silent';
  process.env.FX_PROVIDER_URL ??= 'http://127.0.0.1:9/fx';
  process.env.FX_PROVIDER_API_KEY ??= 'fx-test-key';

  const applied = await applyMigrations(url);
  await assertSchemaGuards(url);

  process.stdout.write(
    `\n  integration database ready: ${url}\n  migrations applied: ${applied.length}\n`,
  );
}
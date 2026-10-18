#!/usr/bin/env node
/**
 * Boots a complete, live PayForge stack for API-level testing.
 *
 * PostgreSQL, the shipped migrations, seeded exchange rates, then the real
 * application. Nothing is mocked and nothing is stubbed: personas drive the
 * same HTTP API a merchant's integration would, against the same database, so
 * whatever passes here is genuinely wired up.
 *
 *   scripts/live-stack.sh start    # background, logs to scripts/live/stack.log
 *   scripts/live-stack.sh status
 *   scripts/live-stack.sh stop
 *
 * `ENABLE_DEV_TOOLS=true` registers POST /dev/bank/settle, which stands in for
 * a provider callback so a charge can be driven to a terminal state over HTTP.
 * It requires a super-admin session and loopback access.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { startDatabase, isReused, TEST_DATABASE_URL } from './postgres';

export const API_PORT = Number(process.env.LIVE_API_PORT ?? 3100);
export const API_BASE = `http://127.0.0.1:${API_PORT}/v1`;

/**
 * Admin credentials.
 *
 * AuthService.onModuleInit bootstraps the first super admin from these, so they
 * have to be set before AppModule is imported (ConfigModule validates then).
 */
export const CREDENTIALS = {
  admin: {
    email: process.env.SUPER_ADMIN_EMAIL ?? 'admin@payforge.test',
    password: process.env.SUPER_ADMIN_PASSWORD ?? 'payforge-admin-pass-2026',
  },
};

/**
 * Apply the shipped migrations in order.
 *
 * `prisma migrate deploy` is not used: the baseline is a squashed schema dump
 * and Prisma refuses it (P3005). Running the SQL directly is also more
 * faithful — it applies the real CHECK constraints and the append-only trigger.
 */
async function applyMigrations(url: string): Promise<string[]> {
  const dir = join(process.cwd(), 'prisma', 'migrations');
  const names = readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .filter((n) => {
      try {
        return readdirSync(join(dir, n)).includes('migration.sql');
      } catch {
        return false;
      }
    })
    .sort();

  const client = new Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    for (const name of names) {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      await client.query(sql);
      applied.push(name);
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** Confirm the database-level money guards actually exist. */
async function assertSchemaGuards(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const trigger = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'Ledgers_append_only'`,
    );
    if (trigger.rowCount !== 1) {
      throw new Error('append-only ledger trigger is missing — money tests are meaningless');
    }
    const checks = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contype='c' AND conname='Ledgers_amount_positive'`,
    );
    if (checks.rowCount !== 1) {
      throw new Error('Ledgers_amount_positive CHECK is missing');
    }
    const index = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname='Transactions_one_open_per_payment'`,
    );
    if (index.rowCount !== 1) {
      throw new Error('double-charge partial unique index is missing');
    }
  } finally {
    await client.end();
  }
}

/** Every dependency the readiness probe should check. */
async function seedRates(url: string): Promise<void> {
  const now = new Date();
  const rateDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // rateDate is unique, so this has to be an upsert rather than an insert —
    // FxService also fetches one at boot.
    await client.query(
      `INSERT INTO "ExchangeRateSnapshot" ("id","rateDate","baseCode","rates","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'USD', '{"USD":1,"INR":83.25,"EUR":0.92,"GBP":0.79}', now(), now())
       ON CONFLICT ("rateDate") DO NOTHING`,
      [rateDate],
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.SUPER_ADMIN_EMAIL ??= CREDENTIALS.admin.email;
  process.env.SUPER_ADMIN_PASSWORD ??= CREDENTIALS.admin.password;
  // Stands in for a provider callback so charges can be driven over HTTP.
  process.env.ENABLE_DEV_TOOLS = 'true';

  process.stdout.write('starting postgres…\n');
  const url = await startDatabase();
  process.stdout.write(`  postgres ready on port ${new URL(url).port}\n`);

  const applied = isReused()
    ? ['(adopted the live stack database)']
    : await applyMigrations(url);
  await assertSchemaGuards(url);
  await seedRates(url);
  process.stdout.write(`  migrations: ${applied.length}\n`);

  // Imported after the environment is set, because ConfigModule validates it.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { ValidationPipe, BadRequestException, VersioningType } = await import('@nestjs/common');
  const { validationMessages } = await import('../../src/common/validation/validation-messages');

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Mirror src/main.ts. The first version of this harness omitted these, which
  // silently disabled every class-validator rule: `basisPoints: 10000`
  // returned an opaque 500 instead of a 400, unknown fields were accepted, and
  // a missing field reached Prisma and crashed the request.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors: never[]) => new BadRequestException(validationMessages(errors)),
    }),
  );

  await app.init();
  await app.listen(API_PORT, '127.0.0.1');

  process.stdout.write(`\n  API listening on ${API_BASE}\n`);
  process.stdout.write(`  admin: ${CREDENTIALS.admin.email} / ${CREDENTIALS.admin.password}\n`);
  process.stdout.write('  inspect with: npx ts-node -P scripts/live/tsconfig.json scripts/live/db.ts counts\n\n');

  const shutdown = async () => {
    process.stdout.write('\nshutting down…\n');
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  process.stderr.write(`stack failed to start: ${String(e)}\n`);
  process.exit(1);
});
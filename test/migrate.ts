import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Apply the shipped migrations in order.
 *
 * `prisma migrate deploy` is not used because the baseline migration is a
 * squashed schema dump and Prisma refuses it (P3005) against a database it
 * considers non-empty. Running the SQL directly is also the more faithful
 * test: it applies the exact CHECK constraints, unique indexes and the
 * append-only trigger that a real deployment gets.
 *
 * The constraints matter enormously here. `Ledgers_append_only` and
 * `CHECK (amount > 0)` are the database-level backstops for the very
 * defects these scenarios hunt for, so testing against a schema without them
 * would prove nothing.
 */
export async function applyMigrations(databaseUrl: string): Promise<string[]> {
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const directories = readdirSync(migrationsDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return readdirSync(join(migrationsDir, name)).includes('migration.sql');
      } catch {
        return false;
      }
    })
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const applied: string[] = [];

  for (const name of directories) {
    const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
    try {
      await client.query(sql);
      applied.push(name);
    } catch (error) {
      throw new Error(
        `migration ${name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await client.end();
  return applied;
}

/** Confirm the database-level money guards are actually present. */
export async function assertSchemaGuards(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const trigger = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'Ledgers_append_only'`,
    );
    if (trigger.rowCount !== 1) {
      throw new Error('append-only ledger trigger is missing — money tests are meaningless');
    }

    const checks = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'Ledgers%'`,
    );
    if (!checks.rows.some((r) => r.conname === 'Ledgers_amount_positive')) {
      throw new Error('Ledgers_amount_positive CHECK is missing');
    }

    const oneOpen = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'Transactions_one_open_per_payment'`,
    );
    if (oneOpen.rowCount !== 1) {
      throw new Error('double-charge partial unique index is missing');
    }
  } finally {
    await client.end();
  }
}
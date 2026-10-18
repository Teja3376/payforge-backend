import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

/**
 * Boots a real PostgreSQL instance for API-level testing.
 *
 * The unit suite cannot prove the things that matter most about money, because
 * it never touches a database. Unique constraints, `SELECT … FOR UPDATE`,
 * compare-and-set under concurrency and the CHECK constraints are the
 * mechanisms the ledger's correctness rests on, and none of them exist in a
 * mocked Prisma client — so these scenarios run against a real engine.
 *
 * The binaries ship as an npm package (`@embedded-postgres/darwin-x64`), so
 * this needs neither Homebrew nor Docker. A fixed port, a temp data directory
 * removed on teardown, and trust-auth on loopback only.
 */
const BIN_DIR = resolve(
  process.cwd(),
  'node_modules/@embedded-postgres/darwin-x64/native/bin',
);

export const TEST_PORT = Number(process.env.PG_IT_PORT ?? 55432);
export const TEST_DATABASE = 'payforge_it';
export const TEST_USER = 'payforge';
export const DATA_DIR = `/tmp/payforge-it-${process.pid}`;

export const TEST_DATABASE_URL =
  `postgresql://${TEST_USER}@127.0.0.1:${TEST_PORT}/${TEST_DATABASE}?schema=public`;

function bin(name: string): string {
  const path = join(BIN_DIR, name);
  if (!existsSync(path)) {
    throw new Error(
      `PostgreSQL binary not found at ${path}. Run npm install — the binaries ship as an npm package.`,
    );
  }
  return path;
}

let started = false;
let reused = false;

/** True when a cluster is already answering on the test port. */
async function isListening(): Promise<boolean> {
  const client = new Client({
    connectionString: `postgresql://${TEST_USER}@127.0.0.1:${TEST_PORT}/postgres`,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start (or adopt) the cluster.
 *
 * When `scripts/live-stack.sh start` is already holding the port this reuses it
 * rather than failing on a clash — the unit suite must not fight the live
 * server for a database.
 */
export async function startDatabase(): Promise<string> {
  if (started) return TEST_DATABASE_URL;
  if (await isListening()) {
    reused = true;
    return TEST_DATABASE_URL;
  }

  rmSync(DATA_DIR, { recursive: true, force: true });

  execFileSync(bin('initdb'), [
    '-D', DATA_DIR,
    '-U', TEST_USER,
    '--auth=trust',
    '--no-sync',
    '-E', 'UTF8',
  ]);

  execFileSync(bin('pg_ctl'), [
    '-D', DATA_DIR,
    '-l', join(DATA_DIR, 'server.log'),
    '-o', `-p ${TEST_PORT} -h 127.0.0.1 -k ${DATA_DIR}`,
    '-w',
    'start',
  ]);

  const admin = new Client({
    connectionString: `postgresql://${TEST_USER}@127.0.0.1:${TEST_PORT}/postgres`,
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();

  started = true;
  return TEST_DATABASE_URL;
}

/** Stop the cluster — unless we adopted it, in which case leave it running. */
export async function stopDatabase(): Promise<void> {
  if (reused) {
    reused = false;
    return;
  }
  if (!started) return;
  try {
    execFileSync(bin('pg_ctl'), ['-D', DATA_DIR, '-m', 'immediate', '-w', 'stop']);
  } catch {
    // A database that already died is not a test failure at teardown.
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  started = false;
}

export function isReused(): boolean {
  return reused;
}

export default { startDatabase, stopDatabase, isReused, TEST_DATABASE_URL };
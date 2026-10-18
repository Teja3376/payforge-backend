import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

/**
 * Boots a real PostgreSQL instance for the integration suite.
 *
 * The unit suite cannot prove the things that matter most about money, because
 * it never touches a database. Unique constraints, `SELECT … FOR UPDATE`,
 * compare-and-set under concurrency, partial unique indexes and CHECK
 * constraints are the mechanisms the ledger's correctness actually rests on —
 * and none of them exist in a mocked Prisma client.
 *
 * The `postgres`, `initdb` and `pg_ctl` binaries ship as an npm package, so
 * this needs neither Homebrew nor Docker. The binaries are driven directly
 * rather than through the npm wrapper: that wrapper is ESM-only, which does
 * not survive Jest's CommonJS transform, and shelling out keeps the lifecycle
 * explicit and the failure messages readable.
 *
 * The data directory is removed on teardown, so this cannot collide with a
 * developer's own database or leave state behind.
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
      `PostgreSQL binary not found at ${path}. Run: npm install (the binaries ship as an npm package).`,
    );
  }
  return path;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let started = false;

export async function startDatabase(): Promise<string> {
  if (started) return TEST_DATABASE_URL;

  rmSync(DATA_DIR, { recursive: true, force: true });

  // Trust auth on loopback only: this is a throwaway cluster that never leaves
  // the machine, and a password would only add friction.
  run(bin('initdb'), [
    '-D', DATA_DIR,
    '-U', TEST_USER,
    '--auth=trust',
    '--no-sync',
    '-E', 'UTF8',
  ]);

  run(bin('pg_ctl'), [
    '-D', DATA_DIR,
    '-l', join(DATA_DIR, 'server.log'),
    '-o', `-p ${TEST_PORT} -h 127.0.0.1 -k ${DATA_DIR}`,
    '-w', // wait until accepting connections
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

export async function stopDatabase(): Promise<void> {
  if (!started) return;
  try {
    run(bin('pg_ctl'), ['-D', DATA_DIR, '-m', 'immediate', '-w', 'stop']);
  } catch {
    // A database that already died is not a test failure at teardown.
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  started = false;
}

export default { startDatabase, stopDatabase, TEST_DATABASE_URL };
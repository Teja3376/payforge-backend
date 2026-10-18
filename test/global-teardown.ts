import { stopDatabase } from './database';

/** Stops the database and removes its data directory. */
export default async function globalTeardown(): Promise<void> {
  await stopDatabase();
}
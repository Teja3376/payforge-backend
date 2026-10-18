/**
 * Shared test setup.
 *
 * Keeps the unit suite's ~3 second runtime honest: nothing here touches a
 * database, so the 190 fast tests are unaffected. Integration suites opt in by
 * importing from `./helpers`, which is where the database client lives.
 */
jest.setTimeout(120_000);

// The logger writes to stdout at boot for several services. Silence it so a
// failing assertion is readable.
process.env.LOG_LEVEL ??= 'silent';
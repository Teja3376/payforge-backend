/**
 * Jest configuration.
 *
 * Previously the suite lived entirely in `package.json` and only ever ran
 * against mocks — there was no way to exercise a unique constraint, a row
 * lock, or two concurrent writers. This config adds a `test/` root for
 * integration scenarios that run against a real PostgreSQL instance.
 *
 * `maxWorkers: 1` is deliberate. Several scenarios assert on global totals
 * (ledger balance, merchant balance) and run concurrent writers against the
 * same database; running suites in parallel would interleave them.
 */
module.exports = {
  displayName: 'PayForge',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { tsconfig: '<rootDir>/test/tsconfig.json', isolatedModules: true },
    ],
  },
  collectCoverageFrom: ['src/**/*.ts', '!**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: '<rootDir>/coverage',
  testEnvironment: 'node',
  testTimeout: 120_000,
  maxWorkers: 1,
  // The PostgreSQL binaries are driven through execFileSync, so nothing from
  // node_modules needs transforming beyond the existing exceptions.
  transformIgnorePatterns: ['node_modules/(?!(@juspay/cards-validator|@nestjs)/)'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
};
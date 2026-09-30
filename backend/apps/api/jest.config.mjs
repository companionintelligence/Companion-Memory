export default {
  testEnvironment: 'node',
  rootDir: '.',
  // `scripts` is here for scripts/support/__tests__, which compiles the module
  // graph `make seed` / `make signup` boot. Coverage stays scoped to src below.
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  transform: {
    '^.+\\.[tj]s$': ['@swc/jest'],
  },

  transformIgnorePatterns: [
    // Ignore .yarn/cache packages EXCEPT ESM-only ones that require transformation
    // (jose arrives via PortalAuthModule, so anything booting the whole App needs it)
    '\\.yarn/cache/(?!(p-limit|yocto-queue|parse-duration|jose)-npm-)',
    '\\.pnp\\.cjs$',
  ],

  // Mirrors the `paths` block in tsconfig.json — enumerated for the same
  // reason: '^@ci/(.*)$' swallowed the whole @ci scope, so a real workspace
  // dependency named @ci/<anything> would have been redirected into src/ and
  // failed to resolve. Keep the two lists in sync.
  moduleNameMapper: {
    '^@ci/common$': '<rootDir>/src/common',
    '^@ci/common/(.*)$': '<rootDir>/src/common/$1',
    '^@ci/domains$': '<rootDir>/src/domains',
    '^@ci/domains/(.*)$': '<rootDir>/src/domains/$1',
    '^@ci/application$': '<rootDir>/src/application',
    '^@ci/configuration$': '<rootDir>/src/configuration',
    '^@ci/instrument$': '<rootDir>/src/instrument',
    // A real workspace package rather than a path alias, so this is not part of
    // the tsconfig `paths` mirror above. It is mapped anyway, at its SOURCE:
    // package.json points `main` at dist/, which jest would otherwise resolve —
    // running the suite against whatever was last built, or failing outright on
    // a clean checkout.
    '^@ci/tool-core$': '<rootDir>/../../packages/tool-core/src/index.ts',
  },

  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],

  // Ratchet, per docs/architecture/test-strategy.md §4: a floor that only ever
  // moves up. Scoped rather than global because the global number is still low;
  // new domains land with a real floor from day one instead of inheriting it.
  //
  // The planning floor is set just under what the suite achieves WITHOUT a
  // database, since TaskService.tenancy.integration.test.ts skips unless a
  // database is configured (PLANNING_TEST_DATABASE_URL or the DATABASE_URL fallback).
  coverageThreshold: {
    './src/domains/planning/': {
      statements: 88,
      branches: 76,
      functions: 76,
      lines: 90,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WHY THIS IS SET, AND WHY IT IS NOT OPTIONAL ON A TWO-CORE RUNNER.
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Nearly every suite here imports a barrel that pulls in a large slice of the
  // Nest module graph. Jest gives each test FILE its own module registry and
  // holds it for the lifetime of the process that ran it, so the cost of those
  // imports accumulates: one process running all 404 files ends up holding 404
  // copies of that graph.
  //
  // Whether that matters depends entirely on the worker count, which jest
  // derives from the CPU count. On a developer machine (10+ cores) the files
  // are split across ~11 workers and no single heap gets close to a limit. A
  // GitHub-hosted runner for a private repo has TWO cores, so `maxWorkers`
  // comes out at 1 — and jest's `shouldRunInBand` treats one worker as a reason
  // to skip the worker pool entirely and run in the main process. The whole
  // suite then accumulates in one heap, against node's default old-space limit
  // of ~2 GB on a 7 GB box. Somewhere past suite ~270 that heap fills, V8 drops
  // into a GC death spiral, and the run stops making progress WITHOUT ever
  // erroring — it just goes quiet until the job timeout kills it. That is what
  // had "Run backend tests" being cancelled on every commit, including main.
  //
  // Setting a memory limit fixes both halves of that. Jest's own rule is
  // "when specifying a memory limit, workers should be used", so this forces
  // the pool back on even at maxWorkers: 1, and the worker is then recycled
  // whenever its heap passes the limit — which bounds the accumulation instead
  // of letting it run to the ceiling. The value is a fraction of the ~2 GB
  // limit, chosen so a restart happens well before GC pressure starts costing
  // more than the restart does.
  workerIdleMemoryLimit: '768MB',

  setupFilesAfterEnv: ['reflect-metadata'],
};

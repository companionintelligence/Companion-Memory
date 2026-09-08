export default {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  transform: {
    '^.+\\.[tj]s$': ['@swc/jest'],
  },

  testMatch: ['**/__tests__/**/*.test.ts'],
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],

  // A floor from day one rather than a cleanup later. The package is pure
  // functions and one plain class, so there is no infrastructure to excuse an
  // untested branch — see docs/architecture/test-strategy.md §4 for the
  // ratchet this follows.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 80,
      functions: 85,
      lines: 85,
    },
  },
};

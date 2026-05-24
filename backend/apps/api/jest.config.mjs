export default {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  moduleFileExtensions: ['ts', 'js', 'json'],

  transform: {
    '^.+\\.[tj]s$': ['@swc/jest'],
  },

  transformIgnorePatterns: [
    // Ignore .yarn/cache packages EXCEPT ESM-only ones that require transformation
    '\\.yarn/cache/(?!(p-limit|yocto-queue|parse-duration)-npm-)',
    '\\.pnp\\.cjs$',
  ],

  moduleNameMapper: {
    '^@ci/(.*)$': '<rootDir>/src/$1',
  },

  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],

  setupFilesAfterEnv: ['reflect-metadata'],
};

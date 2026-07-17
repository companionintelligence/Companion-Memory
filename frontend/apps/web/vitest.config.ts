import path from 'node:path';

import { defineConfig } from 'vitest/config';

// Standalone test config (kept separate from vite.config.ts so the PWA / tailwind
// build plugins don't load under test). Two projects share this config:
//   - `node`: pure-logic units (*.node.test.ts) run in the fast node environment.
//   - `dom`:  component / hook tests run in jsdom with the shared setup file.
// Files opt into the node project with the `.node.test.ts` / `.node.spec.ts`
// suffix; everything else runs in jsdom.
const alias = {
  '@': path.resolve(__dirname, './src'),
  // Mirror vite.config.ts: this package is type-only and fails to resolve at
  // runtime, so any `@/graphql` import (gql.ts) needs the shim under test too.
  '@graphql-typed-document-node/core': path.resolve(__dirname, './src/graphql/typed-document-node-shim.ts'),
};

export default defineConfig({
  resolve: { alias },
  // Vitest transforms .tsx via esbuild; use the React 19 automatic JSX runtime
  // (matches tsconfig's "jsx": "react-jsx"). No Fast Refresh plugin needed under test.
  esbuild: { jsx: 'automatic' },
  test: {
    // describe/it/expect/vi available without imports; also lets @testing-library/jest-dom
    // augment the global `expect`.
    globals: true,
    // Do not process Tailwind / leaflet CSS imports under test (treated as no-ops).
    css: false,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/**/*.stories.{ts,tsx}',
        'src/graphql/**', // generated
        'src/test/**', // harness
        'src/main.tsx',
        'src/**/index.ts',
      ],
      // Thresholds are intentionally left unset while coverage is being built up,
      // so CI stays non-blocking. Ratchet these on once the suite stabilizes:
      // thresholds: { statements: 60, branches: 50, functions: 60, lines: 60 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.node.{test,spec}.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['src/**/*.node.{test,spec}.{ts,tsx}', 'node_modules/**'],
        },
      },
    ],
  },
});

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

// Coverage globs, kept absolute on purpose — see `allowExternal` below. With
// that flag on, @vitest/coverage-v8 hands `test-exclude` `relativePath: false`,
// so every include/exclude pattern is matched against a file's ABSOLUTE path.
// A relative `src/**/*.ts` then matches nothing at all and the report comes out
// empty (measured: lcov.info with zero SF: lines), which is why these are built
// from __dirname rather than written by hand.
const webSrc = path.resolve(__dirname, 'src');
const packagesDir = path.resolve(__dirname, '../../packages');

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
    // 20s, not vitest's 5s default, and deliberately not "tidy me back down".
    // `docs/qa/baseline-2026-08-29.md` §3.2 measured the full suite: 3,328 tests,
    // 673s wall clock, 7 failures — ALL of them literally "Test timed out in
    // 5000ms", spread over three files, and ALL of them passing when the file was
    // re-run in isolation, where the longest single test took 4.4s. So the 5s
    // ceiling was not catching slow tests, it was catching contention between
    // parallel workers, and the suite could not fail for a real reason without
    // also failing for a fake one. hookTimeout matches, because a beforeEach that
    // mounts the same heavy tree is subject to exactly the same contention.
    // Anything that actually hangs still fails here — 20s against a 4.4s worst
    // case is a wide margin, not an absent one.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // `frontend/packages/*/src` is in here because the web suite EXECUTES it:
      // a dozen-plus @ci/common modules alone are imported by these tests (grep
      // `from '@ci/common/src/`), plus @ci/capture, @ci/editor and @ci/shadcn.
      // That is the cross-target layer the iOS/Android/desktop shells reuse, and
      // this suite is the only place it is covered at all — with only `src/**`
      // included, all of it was invisible, so the report gave a comfortable
      // number that said nothing whatsoever about the code every target depends
      // on.
      //
      // `allowExternal` is what makes that second pattern do anything: it
      // defaults to false, which drops every file outside this project's root
      // from the report — silently, so a widened `include` alone looks like it
      // worked and measures nothing. It also flips these patterns to
      // absolute-path matching (see the note on `webSrc` above), hence the
      // interpolated constants rather than relative globs.
      //
      // Know this before setting a threshold off the packages half: `all` only
      // walks files under this project's root, so a `frontend/packages/*` file
      // appears in the report ONLY if some test actually imported it. Measured
      // on 2026-09-07 — a full run reports 152 package files of the 166 on
      // disk, and the shortfall is not spread evenly: @ci/shadcn lands 102/102
      // (its barrel re-exports everything) while @ci/editor lands 1 of 8 and
      // each Capacitor plugin 1 of 3. So the packages denominator is
      // "shared-layer code some test loads", not "shared-layer code", and a
      // percentage taken from it flatters the least-tested packages most.
      allowExternal: true,
      include: [`${webSrc}/**/*.{ts,tsx}`, `${packagesDir}/*/src/**/*.{ts,tsx}`],
      exclude: [
        `${webSrc}/**/*.{test,spec}.{ts,tsx}`,
        `${webSrc}/**/*.stories.{ts,tsx}`,
        `${webSrc}/graphql/**`, // generated
        `${webSrc}/test/**`, // harness
        `${webSrc}/main.tsx`,
        `${webSrc}/**/index.ts`,
        // Same two exclusions as above, for the newly included packages: their
        // own test and story files are not production code, and counting them
        // inflates the very baseline the thresholds below are meant to be set
        // from.
        `${packagesDir}/*/src/**/*.{test,spec}.{ts,tsx}`,
        `${packagesDir}/*/src/**/*.stories.{ts,tsx}`,
      ],
      // Thresholds are intentionally left unset while coverage is being built up,
      // so CI stays non-blocking. The numbers below are an ILLUSTRATION, not a
      // measurement — and now that `include` also spans frontend/packages/*, any
      // previously observed percentage is stale. Ratchet these on only from a
      // fresh measured baseline of the widened include list:
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

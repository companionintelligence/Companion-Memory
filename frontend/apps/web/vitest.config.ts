import { defineConfig } from 'vitest/config';

// Standalone test config (kept separate from vite.config.ts so the PWA / tailwind
// build plugins don't load under test). Pure-logic units run in the node
// environment; add `environment: 'jsdom'` here if/when component tests are added.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});

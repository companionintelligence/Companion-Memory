import { defineConfig } from 'vitest/config';

/**
 * The suite that came across from `domains/import/cli/__tests__` unchanged.
 *
 * `globals: true` because those files call `describe`/`it`/`expect` without
 * importing them — they were written against jest's injected globals, and the
 * point of the move was to run the same assertions somewhere that does not have
 * to boot NestJS to do it. Nothing in them stubs a module or a timer, so there
 * was no jest API to port: the clients take an injected `fetch`, the commands
 * take an injected context, and the waits take an injected clock.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});

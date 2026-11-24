import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { IdentiKeyError, type IdentiKeyErrorCode } from '../errors';

/** Shared by the specs in this domain. Not a spec itself: its name does not match jest's `testMatch`. */

const FIXTURES = join(__dirname, 'fixtures');

export const fixture = (relative: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIXTURES, relative)));

export const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));
export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * The constants of the Rust crate's `tests/vectors.rs`, so the same scenarios can be replayed here.
 * The challenge itself is `fixtures/auth-v1/challenge.bin`.
 */
export const VECTOR = {
  audience: 'identikey-vector',
  now: 1_700_000_000,
  ttlSeconds: 120,
  skewSeconds: 30,
  ed25519Seed: new Uint8Array(32).fill(0x11),
  p256Secret: new Uint8Array(32).fill(0x22),
} as const;

/** The code a synchronous call refuses with, or 'no error'. Anything that is not an IdentiKeyError is rethrown. */
export function codeOf(fn: () => unknown): IdentiKeyErrorCode | 'no error' {
  try {
    fn();
  } catch (error) {
    if (error instanceof IdentiKeyError) {
      return error.code;
    }

    throw error;
  }

  return 'no error';
}

/** Narrow a value that the test knows is present, without a `!`. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('test expected a value');
  }

  return value;
}

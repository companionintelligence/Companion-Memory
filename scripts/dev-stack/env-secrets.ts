/**
 * env-secrets: keep the placeholder secrets committed in `.env.default` out of
 * running dev stacks.
 *
 * `.env.default` ships every secret as a `replace-me-...` string so that the file
 * can be committed. `make init` used to copy it to `.env` unchanged, so every dev
 * stack signed sessions and tokens, and ran its object store, with values anyone
 * with the repo can read. That only stays harmless while nothing but this machine
 * reaches the stack, and `make tunnel` publishes it to the internet.
 *
 * Two jobs, run through ./env-secrets-cli.ts:
 *
 *   - `make init` mints fresh random values into the `.env` it has just copied.
 *   - `make tunnel` refuses to start while `.env` still holds a placeholder.
 *
 * Only values that are still placeholders are ever replaced, so a `.env` a stack
 * already runs on keeps every value its volumes were set up with. The database
 * passwords and the field-encryption key are not `replace-me-` strings and stay
 * as they are for the same reason: Postgres fixes its passwords when the volume
 * is created, and the field key has to decrypt what is already stored. Neither
 * is reachable off this machine (the database port binds to loopback).
 */
import crypto from 'node:crypto';

/** What every committed placeholder secret in `.env.default` starts with. */
export const PLACEHOLDER_PREFIX = 'replace-me-';

/**
 * A `KEY=value` or `KEY="value"` line, the two shapes `.env.default` uses.
 * Groups: key, the quote (empty when unquoted), the value.
 */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=("?)(.*)\2\s*$/;

/**
 * PS_JWT_SECRET_B64URL is not a secret of its own: it is base64url(POWERSYNC_JWT_SECRET),
 * unpadded, and the PowerSync service verifies with it the tokens the API signs
 * with the other. It has to move with POWERSYNC_JWT_SECRET or every token fails.
 */
const DERIVED_FROM_POWERSYNC_SECRET = 'PS_JWT_SECRET_B64URL';

export function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Random lowercase hex of exactly `length` characters. */
export function randomHex(length: number): string {
  return crypto
    .randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

/**
 * The length a minted value gets: the placeholder's own, which `.env.default`
 * keeps at the format and length the code expects, and never under 32 hex
 * characters (128 bits). Only the seed user's 20-character password is raised.
 */
function mintedLength(placeholder: string): number {
  return Math.max(placeholder.length, 32);
}

export interface MintResult {
  text: string;
  /** The keys that were placeholders and now hold fresh values, in file order. */
  minted: string[];
}

/**
 * Replace every placeholder value in a dotenv file's text with fresh random hex,
 * keeping the line's quoting, and re-derive PS_JWT_SECRET_B64URL when it still
 * matches the placeholder POWERSYNC_JWT_SECRET it was derived from. Every other
 * line, comments and blank lines included, comes back untouched.
 */
export function mintPlaceholderSecrets(
  text: string,
  random: (length: number) => string = randomHex,
): MintResult {
  const minted: string[] = [];
  const replaced = new Map<string, { from: string; to: string }>();

  const lines = text.split('\n').map((line) => {
    const match = ASSIGNMENT.exec(line);

    if (!match || !match[3].startsWith(PLACEHOLDER_PREFIX)) {
      return line;
    }

    const [, key, quote, placeholder] = match;
    const fresh = random(mintedLength(placeholder));

    replaced.set(key, { from: placeholder, to: fresh });
    minted.push(key);

    return `${key}=${quote}${fresh}${quote}`;
  });

  const powersync = replaced.get('POWERSYNC_JWT_SECRET');

  const out = lines.map((line) => {
    const match = ASSIGNMENT.exec(line);

    if (
      !powersync ||
      !match ||
      match[1] !== DERIVED_FROM_POWERSYNC_SECRET ||
      match[3] !== base64url(powersync.from)
    ) {
      return line;
    }

    return `${match[1]}=${match[2]}${base64url(powersync.to)}${match[2]}`;
  });

  return { text: out.join('\n'), minted };
}

/** The keys in a dotenv file's text whose value is still a committed placeholder. */
export function placeholderKeys(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const match = ASSIGNMENT.exec(line);

    return match && match[3].startsWith(PLACEHOLDER_PREFIX) ? [match[1]] : [];
  });
}

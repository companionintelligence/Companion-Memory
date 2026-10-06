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
 *   - `make tunnel` refuses to start while `.env` still holds a placeholder, or
 *     leaves out a secret whose fallback is its own variable name.
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
 * An assignment line in any shape dotenv (what `make dev` loads `.env` with)
 * accepts: an optional `export `, spaces around `=`, single, double or no
 * quotes, and a trailing `# comment`. `.env.default` itself only uses `KEY=value`
 * and `KEY="value"`, but a hand-edited `.env` may use any of them, and a line
 * this did not recognise was a placeholder `make tunnel` let through.
 *
 * Groups: what comes before the key, the key, the `=` with its spacing, the
 * quote (empty when unquoted), the value, and what follows the value.
 */
const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(["']?)(.*?)\4(\s*(?:#.*)?)$/;

interface Assignment {
  before: string;
  key: string;
  equals: string;
  quote: string;
  value: string;
  after: string;
}

function parseAssignment(line: string): Assignment | null {
  const match = ASSIGNMENT.exec(line);

  if (!match) {
    return null;
  }

  const [, before, key, equals, quote, value, after] = match;

  return { before, key, equals, quote, value, after };
}

/** The line with its value replaced, everything around the value kept. */
function withValue({ before, key, equals, quote, after }: Assignment, value: string): string {
  return `${before}${key}${equals}${quote}${value}${quote}${after}`;
}

/**
 * The secrets whose `config/default.json` fallback, when the variable is unset,
 * is the variable's own name (`"authTokenSecret": "AUTH_TOKEN_SECRET"`). A `.env`
 * that leaves one out runs on a value as public as any placeholder, and the API
 * only warns about it outside production.
 */
export const NAME_FALLBACK_SECRETS = [
  'AUTH_TOKEN_SECRET',
  'AUTH_REFRESH_TOKEN_SECRET',
  'AUTH_SESSION_PEPPER',
  'AUTH_CSRF_TOKEN_SECRET',
  'OBJECT_STORE_USERNAME',
  'OBJECT_STORE_PASSWORD',
];

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
    const assignment = parseAssignment(line);

    if (!assignment || !assignment.value.startsWith(PLACEHOLDER_PREFIX)) {
      return line;
    }

    const fresh = random(mintedLength(assignment.value));

    replaced.set(assignment.key, { from: assignment.value, to: fresh });
    minted.push(assignment.key);

    return withValue(assignment, fresh);
  });

  const powersync = replaced.get('POWERSYNC_JWT_SECRET');

  const out = lines.map((line) => {
    const assignment = parseAssignment(line);

    if (
      !powersync ||
      !assignment ||
      assignment.key !== DERIVED_FROM_POWERSYNC_SECRET ||
      assignment.value !== base64url(powersync.from)
    ) {
      return line;
    }

    return withValue(assignment, base64url(powersync.to));
  });

  return { text: out.join('\n'), minted };
}

/** The keys in a dotenv file's text whose value is still a committed placeholder. */
export function placeholderKeys(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const assignment = parseAssignment(line);

    return assignment?.value.startsWith(PLACEHOLDER_PREFIX) ? [assignment.key] : [];
  });
}

/**
 * The `NAME_FALLBACK_SECRETS` a dotenv file's text leaves unset, empty, or set
 * to the variable's own name, so the API falls back to (or is handed) the name
 * itself. dotenv keeps the last of two assignments to one key, and so does this.
 */
export function unsetSecretKeys(text: string): string[] {
  const values = new Map(
    text.split('\n').flatMap((line) => {
      const assignment = parseAssignment(line);

      return assignment ? [[assignment.key, assignment.value] as const] : [];
    }),
  );

  return NAME_FALLBACK_SECRETS.filter((key) => {
    const value = values.get(key);

    return !value || value === key;
  });
}

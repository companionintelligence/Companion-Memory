import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  base64url,
  mintPlaceholderSecrets,
  PLACEHOLDER_PREFIX,
  placeholderKeys,
  unsetSecretKeys,
} from './env-secrets';

const ROOT = process.cwd();
const TEMPLATE = fs.readFileSync(path.join(ROOT, '.env.default'), 'utf8');
const CLI = path.join(ROOT, 'scripts/dev-stack/env-secrets-cli.ts');

/** KEY -> raw value (quotes kept) for every assignment line. */
function values(text: string): Map<string, string> {
  return new Map(
    text
      .split('\n')
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
}

/** The secrets a dev stack is reachable with: what must never stay a committed value. */
const MUST_MINT = [
  'AUTH_TOKEN_SECRET',
  'AUTH_REFRESH_TOKEN_SECRET',
  'AUTH_SESSION_PEPPER',
  'AUTH_CSRF_TOKEN_SECRET',
  'SIDECAR_AUTH_SECRET',
  'OBJECT_STORE_USERNAME',
  'OBJECT_STORE_PASSWORD',
  'POWERSYNC_JWT_SECRET',
  'AUTH_DEFAULT_USER_PASSWORD',
];

test('.env.default still ships every secret this mints as a placeholder', () => {
  // If a key stops being a `replace-me-` string, mint stops replacing it and a
  // fresh `make init` copies the committed value again without anyone noticing.
  assert.deepEqual(placeholderKeys(TEMPLATE).sort(), [...MUST_MINT].sort());
});

test('mint replaces every placeholder in a fresh copy of .env.default, and nothing else', () => {
  const { text, minted } = mintPlaceholderSecrets(TEMPLATE);
  const before = values(TEMPLATE);
  const after = values(text);

  assert.deepEqual([...minted].sort(), [...MUST_MINT].sort());
  assert.deepEqual(placeholderKeys(text), [], 'no placeholder is left behind');

  for (const key of MUST_MINT) {
    const value = (after.get(key) ?? '').replace(/^"|"$/g, '');

    assert.doesNotMatch(value, new RegExp(`^${PLACEHOLDER_PREFIX}`), `${key} is still a placeholder`);
    assert.match(
      value,
      /^[0-9a-f]{32,}$/,
      `${key} should be at least 32 random hex characters, got ${value}`,
    );
  }

  // The quoted line stays quoted.
  assert.match(after.get('AUTH_DEFAULT_USER_PASSWORD') ?? '', /^"[0-9a-f]+"$/);

  // Values a running stack's volumes depend on stay exactly as they were.
  for (const key of [
    'DATABASE_ADMIN_PASSWORD',
    'DATABASE_PASSWORD',
    'POWERSYNC_DATABASE_PASSWORD',
    'AUTH_FIELD_ENCRYPTION_KEY',
  ]) {
    assert.equal(after.get(key), before.get(key), `${key} must not change`);
  }

  // Comments, blank lines and every other assignment come back as they went in.
  const untouched = (t: string) =>
    t
      .split('\n')
      .filter(
        (line) =>
          !/^(?:[A-Z_]+_SECRET|AUTH_SESSION_PEPPER|OBJECT_STORE_\w+|AUTH_DEFAULT_USER_PASSWORD|PS_JWT_SECRET_B64URL)=/.test(
            line,
          ),
      );

  assert.deepEqual(untouched(text), untouched(TEMPLATE));
});

test('mint gives each stack its own values', () => {
  const first = values(mintPlaceholderSecrets(TEMPLATE).text);
  const second = values(mintPlaceholderSecrets(TEMPLATE).text);

  for (const key of MUST_MINT) {
    assert.notEqual(first.get(key), second.get(key), `${key} came out the same twice`);
  }
});

test('PS_JWT_SECRET_B64URL moves with POWERSYNC_JWT_SECRET', () => {
  const template = values(TEMPLATE);

  // The precondition the derivation relies on: the template's B64URL is the
  // placeholder secret, encoded.
  assert.equal(template.get('PS_JWT_SECRET_B64URL'), base64url(template.get('POWERSYNC_JWT_SECRET') ?? ''));

  const after = values(mintPlaceholderSecrets(TEMPLATE).text);
  const secret = after.get('POWERSYNC_JWT_SECRET') ?? '';

  assert.notEqual(secret, template.get('POWERSYNC_JWT_SECRET'));
  assert.equal(after.get('PS_JWT_SECRET_B64URL'), base64url(secret));
});

test('a .env whose secrets are already real is left exactly as it is', () => {
  const real = mintPlaceholderSecrets(TEMPLATE).text;
  const again = mintPlaceholderSecrets(real);

  assert.equal(again.text, real);
  assert.deepEqual(again.minted, []);
});

test('a PS_JWT_SECRET_B64URL someone set by hand is not overwritten', () => {
  const text = 'POWERSYNC_JWT_SECRET=replace-me-powersync\nPS_JWT_SECRET_B64URL=bXktb3duLWtleQ\n';

  assert.match(mintPlaceholderSecrets(text).text, /^PS_JWT_SECRET_B64URL=bXktb3duLWtleQ$/m);
});

test('placeholderKeys reads quoted and bare values and skips commented-out lines', () => {
  const text = [
    'AUTH_TOKEN_SECRET=replace-me-a',
    'AUTH_DEFAULT_USER_PASSWORD="replace-me-pw"',
    '# OBJECT_STORE_PASSWORD=replace-me-c',
    'OBJECT_STORE_USERNAME=0123456789abcdef0123456789abcdef',
    'NOTE="not replace-me-at the start"',
  ].join('\n');

  assert.deepEqual(placeholderKeys(text), ['AUTH_TOKEN_SECRET', 'AUTH_DEFAULT_USER_PASSWORD']);
});

test('every line shape dotenv loads is found and minted in place', () => {
  // dotenv, which `make dev` loads .env with, reads all of these as a
  // placeholder. Each one used to pass `make tunnel`'s check untouched.
  const text = [
    'export AUTH_TOKEN_SECRET=replace-me-a',
    "AUTH_REFRESH_TOKEN_SECRET='replace-me-b'",
    'AUTH_SESSION_PEPPER = replace-me-c',
    'AUTH_CSRF_TOKEN_SECRET="replace-me-d" # rotated by hand',
    'OBJECT_STORE_USERNAME=replace-me-e\r',
  ].join('\n');

  assert.deepEqual(placeholderKeys(text), [
    'AUTH_TOKEN_SECRET',
    'AUTH_REFRESH_TOKEN_SECRET',
    'AUTH_SESSION_PEPPER',
    'AUTH_CSRF_TOKEN_SECRET',
    'OBJECT_STORE_USERNAME',
  ]);

  const { text: minted } = mintPlaceholderSecrets(text, (length) => 'f'.repeat(length));
  const fresh = 'f'.repeat(32);

  // Only the value changes: the export, the quotes, the spacing, the comment
  // and the line ending all stay.
  assert.deepEqual(minted.split('\n'), [
    `export AUTH_TOKEN_SECRET=${fresh}`,
    `AUTH_REFRESH_TOKEN_SECRET='${fresh}'`,
    `AUTH_SESSION_PEPPER = ${fresh}`,
    `AUTH_CSRF_TOKEN_SECRET="${fresh}" # rotated by hand`,
    `OBJECT_STORE_USERNAME=${fresh}\r`,
  ]);
  assert.deepEqual(placeholderKeys(minted), []);
});

test('unsetSecretKeys names a secret the API would replace with its own variable name', () => {
  const real = mintPlaceholderSecrets(TEMPLATE).text;

  assert.deepEqual(unsetSecretKeys(real), []);

  const withoutToken = real
    .split('\n')
    .filter((line) => !line.startsWith('AUTH_TOKEN_SECRET='))
    .join('\n');

  assert.deepEqual(unsetSecretKeys(withoutToken), ['AUTH_TOKEN_SECRET']);
  assert.deepEqual(unsetSecretKeys(`${real}\nAUTH_CSRF_TOKEN_SECRET=AUTH_CSRF_TOKEN_SECRET\n`), [
    'AUTH_CSRF_TOKEN_SECRET',
  ]);
  assert.deepEqual(unsetSecretKeys(`${real}\nOBJECT_STORE_PASSWORD=\n`), ['OBJECT_STORE_PASSWORD']);
});

/** Run the CLI the way the Makefile does, against a scratch file. */
function cli(command: string, file: string): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, ['--import', 'tsx', CLI, command, file], {
    encoding: 'utf8',
    cwd: ROOT,
  });

  return { status: res.status, stderr: res.stderr };
}

test('check (what `make tunnel` runs first) refuses placeholders and a missing .env, and passes a minted one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, '.env');

  const missing = cli('check', file);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist/);

  fs.writeFileSync(file, TEMPLATE);
  const placeholders = cli('check', file);
  assert.equal(placeholders.status, 1);
  assert.match(placeholders.stderr, /AUTH_TOKEN_SECRET/);
  assert.match(placeholders.stderr, /OBJECT_STORE_PASSWORD/);

  assert.equal(cli('mint', file).status, 0);
  assert.deepEqual(placeholderKeys(fs.readFileSync(file, 'utf8')), []);
  assert.equal(cli('check', file).status, 0);

  // A minted .env that leaves a secret out falls back to the committed name.
  const minted = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(
    file,
    minted
      .split('\n')
      .filter((line) => !line.startsWith('AUTH_SESSION_PEPPER='))
      .join('\n'),
  );
  const unset = cli('check', file);
  assert.equal(unset.status, 1);
  assert.match(unset.stderr, /does not set AUTH_SESSION_PEPPER/);
});

/**
 * A target's recipe lines, blank lines inside it included, comments dropped.
 * Stops at the next target or `.PHONY`.
 */
function recipe(target: string): string[] {
  const lines = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${target}:`));

  assert.notEqual(start, -1, `no '${target}:' target in the Makefile`);

  const out: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('.PHONY') || /^[A-Za-z0-9_.-]+:/.test(line)) {
      break;
    }

    if (line.startsWith('\t') && !/^\t@?#/.test(line)) {
      out.push(line.trim());
    }
  }

  return out;
}

test('make init mints secrets into the .env it copies, and removes it if that fails', () => {
  const lines = recipe('init');
  const copy = lines.findIndex((line) => line.includes('cp .env.default .env'));

  assert.notEqual(copy, -1, 'init still creates .env from .env.default');
  assert.match(
    lines[copy + 1] ?? '',
    /^yarn tsx scripts\/dev-stack\/env-secrets-cli\.ts mint \.env \|\| \{ rm -f \.env; exit 1; \}/,
    'the line after the copy must mint the fresh .env, and drop it when minting fails',
  );
  assert.match(lines[copy], /&& \\$/, 'the mint must only run once the copy has succeeded');
});

test('make tunnel checks .env for placeholders before it starts cloudflared', () => {
  const lines = recipe('tunnel');
  const check = lines.findIndex(
    (line) => line === '@yarn tsx scripts/dev-stack/env-secrets-cli.ts check .env',
  );
  const run = lines.findIndex((line) => line.startsWith('cloudflared tunnel'));

  assert.notEqual(check, -1, 'tunnel must run the placeholder check');
  assert.notEqual(run, -1, 'tunnel still runs cloudflared');
  assert.ok(check < run, 'the check has to come before the tunnel opens');
});

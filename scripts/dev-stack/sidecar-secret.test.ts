import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import dotenv from 'dotenv';

import { ensureSidecarAuthSecret } from './sidecar-secret';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-stack-env-'));

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function tempEnvFile(contents?: string): string {
  const file = path.join(fs.mkdtempSync(path.join(scratch, 'case-')), '.env');

  if (contents !== undefined) {
    fs.writeFileSync(file, contents);
  }

  return file;
}

test('ensureSidecarAuthSecret: mints one into a .env that predates it, and the same value into env', () => {
  const file = tempEnvFile('AUTH_TOKEN_SECRET=abc\n');
  const env: NodeJS.ProcessEnv = {};

  assert.equal(ensureSidecarAuthSecret(file, env), true);

  const parsed = dotenv.parse(fs.readFileSync(file));
  assert.match(parsed.SIDECAR_AUTH_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(env.SIDECAR_AUTH_SECRET, parsed.SIDECAR_AUTH_SECRET);
  assert.equal(parsed.AUTH_TOKEN_SECRET, 'abc');
});

test('ensureSidecarAuthSecret: a second run, with .env reloaded, changes nothing', () => {
  const file = tempEnvFile('AUTH_TOKEN_SECRET=abc\n');
  ensureSidecarAuthSecret(file, {});
  const after = fs.readFileSync(file, 'utf8');

  const reloaded: NodeJS.ProcessEnv = { ...dotenv.parse(after) };

  assert.equal(ensureSidecarAuthSecret(file, reloaded), false);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('ensureSidecarAuthSecret: leaves an explicit value alone, from .env or the shell', () => {
  const original = 'SIDECAR_AUTH_SECRET=from-the-file\n';
  const file = tempEnvFile(original);
  const env: NodeJS.ProcessEnv = { SIDECAR_AUTH_SECRET: 'from-the-file' };

  assert.equal(ensureSidecarAuthSecret(file, env), false);
  assert.equal(env.SIDECAR_AUTH_SECRET, 'from-the-file');
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  const bare = tempEnvFile('AUTH_TOKEN_SECRET=abc\n');
  assert.equal(ensureSidecarAuthSecret(bare, { SIDECAR_AUTH_SECRET: 'from-the-shell' }), false);
  assert.equal(fs.readFileSync(bare, 'utf8'), 'AUTH_TOKEN_SECRET=abc\n');
});

test('ensureSidecarAuthSecret: does not glue the key onto a last line with no newline', () => {
  const file = tempEnvFile('AUTH_TOKEN_SECRET=abc');
  ensureSidecarAuthSecret(file, {});

  const parsed = dotenv.parse(fs.readFileSync(file));
  assert.equal(parsed.AUTH_TOKEN_SECRET, 'abc');
  assert.match(parsed.SIDECAR_AUTH_SECRET, /^[0-9a-f]{64}$/);
});

test('ensureSidecarAuthSecret: never creates a missing .env, which would stop make init copying the template', () => {
  const file = tempEnvFile();
  const env: NodeJS.ProcessEnv = {};

  assert.equal(ensureSidecarAuthSecret(file, env), true);
  assert.equal(fs.existsSync(file), false);
  assert.match(env.SIDECAR_AUTH_SECRET ?? '', /^[0-9a-f]{64}$/);
});

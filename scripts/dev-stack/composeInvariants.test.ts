/**
 * Pins the database service's crash-safety settings, because nothing else does
 * and the failure they prevent is invisible until it is expensive.
 *
 * The mechanism (measured 2026-09-28, written up beside `init: true` in
 * docker-compose.yml): with the postmaster as PID 1, the kernel hands every
 * orphaned process in the container to it, and the postmaster treats a child it
 * did not fork that exits above 1 as a crashed backend — it kills every session
 * and runs crash recovery. A CMD-SHELL healthcheck is a reliable source of such
 * orphans: `sh -c` forks under dash, so when a slow probe outruns its timeout
 * Docker SIGKILLs the shell and the orphaned `pg_isready` exits 2. The database
 * then "crash-restarts every few minutes" with `untracked child process ...
 * exited with exit code 2` in its log, which reads like a Postgres bug.
 *
 * Three settings close that, in three places that drifted apart before:
 *   1. `init: true`                     — tini is PID 1 and reaps orphans itself.
 *   2. exec-form healthcheck            — the probe IS the process Docker kills.
 *   3. timeout >= 10s                   — a merely slow probe is not a dead one.
 * and `scripts/publish/publish.sh` re-declares the database service for the
 * store bundle, in a schema that has neither `init` nor an array `test`. Its
 * equivalent of exec-form is a shell string that `exec`s the probe.
 *
 * `make test-db` starts its throwaway Postgres with `--init` and an exec-form
 * probe for the same reason, and its crash sentinel exists to catch the
 * regression these tests cannot see (a `docker exec ... sh -c` someone adds).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parse } from 'yaml';

const ROOT = process.cwd();

/** Seconds in a compose/runtipi duration such as `10s`, `1m30s`, `500ms`. */
function durationSeconds(value: string | number): number {
  if (typeof value === 'number') {
    // A bare number in compose is nanoseconds; nobody writes that, and if they
    // did it would be far below the floor these tests enforce.
    return value / 1e9;
  }

  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  const unit: Record<string, number> = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
  let total = 0;
  let matched = 0;

  for (const m of value.matchAll(re)) {
    total += Number(m[1]) * unit[m[2]];
    matched += m[0].length;
  }

  assert.equal(matched, value.replace(/\s/g, '').length, `unparseable duration: ${value}`);

  return total;
}

interface ComposeFile {
  services?: Record<
    string,
    {
      init?: boolean;
      healthcheck?: { test?: unknown; timeout?: string | number };
    }
  >;
}

function loadCompose(file: string): ComposeFile {
  return parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as ComposeFile;
}

const COMPOSE_FILES = fs
  .readdirSync(ROOT)
  .filter((f) => /^docker-compose(\.[a-z]+)?\.yml$/.test(f))
  .sort();

test('durationSeconds: understands the compose spellings the healthchecks use', () => {
  assert.equal(durationSeconds('10s'), 10);
  assert.equal(durationSeconds('1m30s'), 90);
  assert.equal(durationSeconds('500ms'), 0.5);
  assert.equal(durationSeconds('5s'), 5);
  assert.throws(() => durationSeconds('ten seconds'), /unparseable/);
});

test('docker-compose.yml: the database runs under an init process', () => {
  const db = loadCompose('docker-compose.yml').services?.database;

  assert.ok(db, 'docker-compose.yml defines a database service');
  assert.strictEqual(db.init, true, 'services.database.init must be true — see the comment beside it');
});

test('docker-compose.yml: the database healthcheck is exec-form, with a timeout of at least 10s', () => {
  const healthcheck = loadCompose('docker-compose.yml').services?.database?.healthcheck;

  assert.ok(healthcheck, 'the database has a healthcheck');
  assert.ok(Array.isArray(healthcheck.test), 'healthcheck.test must be a list (exec form), not a string');
  assert.equal(
    healthcheck.test[0],
    'CMD',
    `healthcheck.test must start with CMD, not ${String(healthcheck.test[0])}: CMD-SHELL wraps the probe in sh -c, which is the orphan-maker`,
  );
  assert.ok(healthcheck.test.length >= 2, 'CMD needs a command after it');
  assert.ok(healthcheck.timeout != null, 'the healthcheck must state its timeout');
  assert.ok(
    durationSeconds(healthcheck.timeout) >= 10,
    `healthcheck.timeout is ${String(healthcheck.timeout)}; under IO load a probe is slow long before the database is sick, so it needs at least 10s`,
  );
});

test('no compose overlay weakens the database settings', () => {
  // Compose merges overlays over the base file, so an overlay that re-declares
  // the healthcheck or init silently replaces the checked values above. None does
  // today; if one starts, it has to keep them.
  assert.ok(COMPOSE_FILES.includes('docker-compose.yml'), 'found the base file');

  for (const file of COMPOSE_FILES.filter((f) => f !== 'docker-compose.yml')) {
    const db = loadCompose(file).services?.database;

    if (db?.init !== undefined) {
      assert.strictEqual(db.init, true, `${file} sets services.database.init to something other than true`);
    }

    if (db?.healthcheck?.test !== undefined) {
      assert.ok(
        Array.isArray(db.healthcheck.test) && db.healthcheck.test[0] === 'CMD',
        `${file} redefines the database healthcheck in a form other than exec (CMD)`,
      );
    }

    if (db?.healthcheck?.timeout !== undefined) {
      assert.ok(
        durationSeconds(db.healthcheck.timeout) >= 10,
        `${file} redefines the database healthcheck timeout below 10s`,
      );
    }
  }
});

/**
 * What `scripts/publish/publish.sh` actually emits, not what its comments say:
 * lift `generate_compose` out of the script (the script runs `main` when
 * sourced, so it cannot be sourced) and run it under bash. It is a heredoc with
 * no command substitutions that need anything but bash, which is why this is
 * safe to execute in a test.
 */
function generatePublishedManifest(): {
  services: {
    name: string;
    healthCheck?: { test?: unknown; timeout?: string; interval?: string };
    init?: unknown;
  }[];
} {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/publish/publish.sh'), 'utf8');
  const fn = script.match(/^generate_compose\(\) \{[\s\S]*?^COMPOSE_EOF\n\}/m);

  assert.ok(fn, 'found generate_compose() in scripts/publish/publish.sh');

  const res = spawnSync('bash', ['-c', `${fn[0]}\ngenerate_compose registry.example version-1`], {
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `generate_compose failed: ${res.stderr}`);

  return JSON.parse(res.stdout);
}

test('publish.sh: the generated database healthcheck is exec-form, with a timeout of at least 10s', () => {
  const manifest = generatePublishedManifest();
  const db = manifest.services.find((s) => s.name === 'database');

  assert.ok(db, 'the published bundle has a database service');
  assert.ok(db.healthCheck, 'the published database has a healthCheck');

  // The runtipi schema types `test` as a STRING (see the comment in publish.sh),
  // so array form is not available here. The equivalent is a shell string that
  // begins with `exec`, replacing the shell with the probe: the process Docker
  // kills on a timeout is then pg_isready itself, and nothing is orphaned.
  const test = db.healthCheck.test;

  assert.equal(typeof test, 'string', 'runtipi types healthCheck.test as a string');
  assert.match(
    test as string,
    /^exec\s+pg_isready\b/,
    `healthCheck.test must start with 'exec pg_isready' (got ${JSON.stringify(test)}): a bare shell string is wrapped in sh -c, and dash forks instead of exec'ing`,
  );
  assert.ok(db.healthCheck.timeout, 'the published healthCheck states its timeout');
  assert.ok(
    durationSeconds(db.healthCheck.timeout) >= 10,
    `published healthCheck.timeout is ${db.healthCheck.timeout}; needs at least 10s`,
  );
});

test('publish.sh: no service in the published bundle uses a CMD-SHELL style probe against the database', () => {
  // The bundle schema has no `init` key at all (that gap is documented in
  // publish.sh), so the only defence it has is the probe form — assert nobody
  // has smuggled a `sh -c` wrapper back in.
  const db = generatePublishedManifest().services.find((s) => s.name === 'database');

  assert.doesNotMatch(String(db?.healthCheck?.test), /\bsh\s+-c\b|CMD-SHELL/);
});

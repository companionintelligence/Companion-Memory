import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  APP_DATABASE,
  CONTAINER_PREFIX,
  EMPTY_DATABASE,
  KEEP_ENV_NAMES,
  KEEP_ENV_PREFIXES,
  LABEL_KEY,
  LABEL_VALUE,
  LOCAL_IMAGE,
  PS_FORMAT,
  STALE_AFTER_MS,
  TEST_ADMIN_URL_VARS,
  TEST_DATABASE_URL_VARS,
  assertOnlyThrowaway,
  buildTestEnv,
  chooseImage,
  escapeRegex,
  formatDuration,
  isDatabaseShaped,
  isOurs,
  jestChoosesWorkers,
  jestFiltersByName,
  newContainerName,
  parseCiDatabaseImage,
  parseDockerPort,
  parseInspectContainers,
  parsePsRows,
  parseTestDbArgs,
  randomPassword,
  scrubEnv,
  selectStale,
  type ContainerInfo,
} from './testDb';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const HOURS = 60 * 60 * 1000;
const ours = (
  name: string,
  ageMs: number,
  labels: Record<string, string> = { [LABEL_KEY]: LABEL_VALUE },
): ContainerInfo => ({
  id: `id-${name}`,
  name,
  createdAt: NOW - ageMs,
  labels,
});

// -- container ownership ------------------------------------------------------

test('isOurs needs the name prefix AND the label', () => {
  assert.equal(isOurs(ours('ci-testdb-ab12cd34', 0)), true);
  assert.equal(isOurs(ours('ci-testdb-ab12cd34', 0, {})), false, 'right name, no label');
  assert.equal(
    isOurs(ours('ci-testdb-ab12cd34', 0, { [LABEL_KEY]: '0' })),
    false,
    'right name, wrong label value',
  );
  assert.equal(isOurs(ours('some-other-db', 0)), false, 'label but wrong name');
  assert.equal(
    isOurs(ours('ci-server-nervous-jackson-7a51b2-database-1', 0, {})),
    false,
    "the owner's stack",
  );
});

test('selectStale: only our containers, only past the age limit', () => {
  const stale = selectStale(
    [
      ours('ci-testdb-old1', 3 * HOURS),
      ours('ci-testdb-fresh', 10 * 60 * 1000),
      ours('ci-testdb-edge', STALE_AFTER_MS),
      ours('ci-testdb-justover', STALE_AFTER_MS + 1),
    ],
    NOW,
  );

  assert.deepEqual(
    stale.map((c) => c.name),
    ['ci-testdb-old1', 'ci-testdb-justover'],
  );
});

test("selectStale never selects a container that is not ours, however old — including the owner's real stack", () => {
  const stale = selectStale(
    [
      ours('ci-server-nervous-jackson-7a51b2-database-1', 9999 * HOURS, {}),
      ours('ci-testdb-unlabelled', 9999 * HOURS, {}),
      ours('postgres-other', 9999 * HOURS, { [LABEL_KEY]: LABEL_VALUE }),
      ours('hub-video-pg', 9999 * HOURS, { 'com.docker.compose.project': 'x' }),
    ],
    NOW,
  );

  assert.deepEqual(stale, []);
});

test('selectStale leaves a container with an unreadable creation time alone', () => {
  const unknown: ContainerInfo = { ...ours('ci-testdb-mystery', 0), createdAt: null };

  assert.deepEqual(selectStale([unknown], NOW), []);
});

test('selectStale honours a different age limit', () => {
  assert.equal(selectStale([ours('ci-testdb-a', 10 * 60 * 1000)], NOW, 5 * 60 * 1000).length, 1);
});

test('parseInspectContainers reads id, name (slash stripped), created and labels; drops malformed lines', () => {
  const out = [
    `abc123|/ci-testdb-aa11bb22|2026-09-29T04:14:26.123456789Z|{"ci.test-db":"1"}`,
    `def456|/ci-server-x-database-1|2026-09-01T00:00:00Z|{"com.docker.compose.project":"ci-server-x"}`,
    `broken line`,
    `ghi789|/ci-testdb-cc33dd44|not-a-date|{"ci.test-db":"1"}`,
    `jkl012|/ci-testdb-ee55ff66|2026-09-29T04:14:26Z|null`,
    ``,
  ].join('\n');
  const parsed = parseInspectContainers(out);

  assert.deepEqual(
    parsed.map((c) => [
      c.id,
      c.name,
      c.createdAt === null ? null : new Date(c.createdAt).toISOString(),
      c.labels,
    ]),
    [
      ['abc123', 'ci-testdb-aa11bb22', '2026-09-29T04:14:26.123Z', { 'ci.test-db': '1' }],
      [
        'def456',
        'ci-server-x-database-1',
        '2026-09-01T00:00:00.000Z',
        { 'com.docker.compose.project': 'ci-server-x' },
      ],
      ['ghi789', 'ci-testdb-cc33dd44', null, { 'ci.test-db': '1' }],
      ['jkl012', 'ci-testdb-ee55ff66', '2026-09-29T04:14:26.000Z', {}],
    ],
  );
});

test('newContainerName has the reaper prefix and does not repeat', () => {
  const a = newContainerName();

  assert.match(a, new RegExp(`^${CONTAINER_PREFIX}[0-9a-f]{8}$`));
  assert.notEqual(a, newContainerName());
});

test('parseDockerPort reads the host port off `docker port` output, including a second IPv6 line', () => {
  assert.equal(parseDockerPort('127.0.0.1:61778\n'), 61778);
  assert.equal(parseDockerPort('127.0.0.1:61778\n[::]:61778\n'), 61778);
  assert.throws(() => parseDockerPort(''), /could not read a published port/);
  assert.throws(() => parseDockerPort('no ports here'), /could not read a published port/);
});

test('parsePsRows reads the rows of `docker ps --format PS_FORMAT`, splitting names and keeping the label', () => {
  assert.equal(PS_FORMAT, '{{.ID}}|{{.Names}}|{{.Label "ci.test-db"}}');
  assert.deepEqual(parsePsRows(`abc|ci-testdb-1|1\ndef|/other,linked/alias|\n\nnot a row\n|x|1\nghi||1\n`), [
    { id: 'abc', names: ['ci-testdb-1'], label: '1' },
    { id: 'def', names: ['other', 'linked/alias'], label: '' },
  ]);
  assert.deepEqual(parsePsRows(''), []);
});

test('escapeRegex makes a container name a literal in a --filter name= regular expression', () => {
  assert.equal(escapeRegex('ci-testdb-ab12cd34'), 'ci-testdb-ab12cd34');
  assert.equal(escapeRegex('ci-testdb-a.b'), 'ci-testdb-a\\.b');
  assert.ok(new RegExp(`^${escapeRegex('ci-testdb-a.b')}$`).test('ci-testdb-a.b'));
  assert.ok(!new RegExp(`^${escapeRegex('ci-testdb-a.b')}$`).test('ci-testdb-aXb'));
  assert.equal(
    escapeRegex('a+b(c)[d]{e}|f^g$h*i?j\\k'),
    'a\\+b\\(c\\)\\[d\\]\\{e\\}\\|f\\^g\\$h\\*i\\?j\\\\k',
  );
});

// -- image --------------------------------------------------------------------

test("parseCiDatabaseImage reads the pin out of ci.yml's postgres service, from the real file", () => {
  const yml = fs.readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

  assert.match(parseCiDatabaseImage(yml), /^ghcr\.io\/companionintelligence\/companion\/database:\S+$/);
});

test('parseCiDatabaseImage takes the postgres service and not some other image line', () => {
  const yml = [
    'jobs:',
    '  test:',
    '    container:',
    '      image: node:22',
    '    services:',
    '      postgres:',
    '        image: ghcr.io/example/database:1.2.3',
    '        env:',
    '          PASSWORD: x',
    '      other:',
    '        image: ghcr.io/example/other:9',
  ].join('\n');

  assert.equal(parseCiDatabaseImage(yml), 'ghcr.io/example/database:1.2.3');
  assert.throws(() => parseCiDatabaseImage('jobs: {}'), /pass --image explicitly/);
});

test('chooseImage: --image wins, then the local dev image, then the CI pin', () => {
  const ciPin = () => 'ghcr.io/x/database:1';

  assert.deepEqual(chooseImage({ flag: 'my/db:1', localPresent: true, ciPin }), {
    ref: 'my/db:1',
    source: 'flag',
  });
  assert.deepEqual(chooseImage({ localPresent: true, ciPin }), { ref: LOCAL_IMAGE, source: 'local' });
  assert.deepEqual(chooseImage({ localPresent: false, ciPin }), {
    ref: 'ghcr.io/x/database:1',
    source: 'ci-pin',
  });
});

test('chooseImage does not read ci.yml unless it has to', () => {
  let read = false;

  chooseImage({ localPresent: true, ciPin: () => ((read = true), 'x') });
  assert.equal(read, false);
});

// -- arguments ----------------------------------------------------------------

test('parseTestDbArgs: defaults', () => {
  assert.deepEqual(parseTestDbArgs([]), { help: false, keep: false, workers: 4, retry: true, jestArgs: [] });
});

test('parseTestDbArgs: own flags, in either value syntax', () => {
  const a = parseTestDbArgs(['--keep', '--image', 'my/db:1', '--workers', '6']);
  const b = parseTestDbArgs(['--image=my/db:1', '--workers=6']);

  assert.deepEqual([a.keep, a.image, a.workers], [true, 'my/db:1', 6]);
  assert.deepEqual([b.keep, b.image, b.workers], [false, 'my/db:1', 6]);
  assert.equal(parseTestDbArgs(['-h']).help, true);
  assert.equal(parseTestDbArgs(['--help']).help, true);
});

test('parseTestDbArgs: --no-retry turns the flake retry off, and only that', () => {
  const a = parseTestDbArgs(['--no-retry']);

  assert.equal(a.retry, false);
  assert.deepEqual([a.keep, a.workers, a.jestArgs], [false, 4, []]);
  assert.equal(parseTestDbArgs(['--keep', '--no-retry', 'src/x']).retry, false);
  // After `--` it is jest's, not ours.
  assert.equal(parseTestDbArgs(['--', '--no-retry']).retry, true);
  assert.deepEqual(parseTestDbArgs(['--', '--no-retry']).jestArgs, ['--no-retry']);
});

test('parseTestDbArgs: bare words are jest path patterns; everything after -- is jest verbatim', () => {
  const a = parseTestDbArgs(['src/domains/import', 'src/domains/asks']);

  assert.deepEqual(a.jestArgs, ['src/domains/import', 'src/domains/asks']);

  const b = parseTestDbArgs([
    '--keep',
    'src/domains/import',
    '--',
    '--runInBand',
    '-t',
    'lifecycle',
    '--keep',
  ]);

  assert.equal(b.keep, true);
  assert.deepEqual(b.jestArgs, ['src/domains/import', '--runInBand', '-t', 'lifecycle', '--keep']);
});

test('parseTestDbArgs: an unknown flag before -- is an error that says how to reach jest', () => {
  assert.throws(
    () => parseTestDbArgs(['--kepp']),
    /Unknown flag '--kepp'.*--help, --keep, --image, --workers, --no-retry.*after '--'/s,
  );
  assert.throws(() => parseTestDbArgs(['-t', 'x']), /Unknown flag '-t'/);
});

test('parseTestDbArgs validates values', () => {
  assert.throws(() => parseTestDbArgs(['--workers']), /--workers needs a value/);
  assert.throws(() => parseTestDbArgs(['--workers', '--keep']), /--workers needs a value/);
  assert.throws(() => parseTestDbArgs(['--workers', '0']), /--workers must be an integer from 1 to 32/);
  assert.throws(() => parseTestDbArgs(['--workers', 'many']), /got 'many'/);
  assert.throws(() => parseTestDbArgs(['--workers', '2.5']), /integer/);
  assert.throws(() => parseTestDbArgs(['--workers', '99']), /1 to 32/);
  assert.throws(() => parseTestDbArgs(['--image']), /--image needs a value/);
});

test('jestChoosesWorkers / jestFiltersByName recognise the flags that change what jest does', () => {
  assert.equal(jestChoosesWorkers(['--maxWorkers=2']), true);
  assert.equal(jestChoosesWorkers(['--runInBand']), true);
  assert.equal(jestChoosesWorkers(['-i']), true);
  assert.equal(jestChoosesWorkers(['src/domains/import']), false);
  assert.equal(jestFiltersByName(['-t', 'x']), true);
  assert.equal(jestFiltersByName(['--testNamePattern=x']), true);
  assert.equal(jestFiltersByName(['--onlyChanged']), true);
  assert.equal(jestFiltersByName(['src/domains/import']), false);
});

// -- the environment ----------------------------------------------------------

const DB = { port: 61778, appPassword: 'apppw0123', adminPassword: 'adminpw4567' };
const NO_DOTENV = '/tmp/x/does-not-exist.env';

/** What an operator's shell might hold: the real appliance, ready to be hit by mistake. */
const HOSTILE_PARENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/Users/someone',
  DATABASE_URL: 'postgres://companion:REALPW@localhost:5432/companion',
  DATABASE_HOST: 'prod.example.com',
  DATABASE_PORT: '5432',
  DATABASE_PASSWORD: 'REALPW',
  DATABASE_ADMIN_PASSWORD: 'REALADMIN',
  DATABASE_QUERY_LOGGING: 'true',
  PGHOST: 'prod.example.com',
  PGPASSWORD: 'REALPW',
  POSTGRES_PASSWORD: 'REALPW',
  ASKS_TEST_DATABASE_URL: 'postgres://x:y@prod.example.com:5432/companion',
  SOME_NEW_TEST_DATABASE_URL: 'postgres://x:y@prod.example.com:5432/companion',
  PIPELINE_TEST_ADMIN_DATABASE_URL: 'postgres://postgres:REALADMIN@prod.example.com:5432/postgres',
  DOTENV_CONFIG_PATH: '../../../.env',
  CI_REQUIRE_DB: '0',
  OLLAMA_HOST: 'http://localhost:11434',
};

/**
 * Names a name-regex of the first design did NOT catch, each pointing at the
 * owner's real database (localhost:5432) the way an operator's shell might. The
 * first five are the ones the reviewer injected and that reached jest unchanged.
 */
const HOSTILE_NAMES: Record<string, string> = {
  HBPE_DATABASE_URL: 'postgres://hbpe:REALPW@localhost:5432/companion',
  PS_REPLICATION_URI: 'postgres://repl:REALPW@localhost:5432/companion',
  POWERSYNC_DATABASE_PASSWORD: 'REALPW',
  DB_HOST: 'localhost',
  COMPOSE_PROJECT_NAME: 'ci-server-nervous-jackson-7a51b2',
  // Same family, other spellings.
  HBPE_DB_HOST: 'localhost',
  HBPE_DB_PORT: '5432',
  REPORTING_DB: 'postgres://ro:REALPW@localhost:5432/companion',
  PS_REPLICATION_HOST: 'localhost',
  POWERSYNC_URL: 'http://localhost:8080',
  POWERSYNC_DATABASE_HOST: 'localhost',
  APP_POSTGRES_URI: 'postgresql://u:REALPW@localhost:5432/companion',
  PGPORT: '5432',
  PGSERVICE: 'companion',
  PGDATABASE: 'companion',
  COMPOSE_FILE: 'docker-compose.local.yml',
  COMPOSE_PROFILES: 'all',
  SEARCH_INDEX_URL: 'postgres://u:REALPW@localhost:5432/companion',
  SOMETHING_URI: 'postgres://u:REALPW@localhost:5432/companion',
  database_url: 'postgres://u:REALPW@localhost:5432/companion',
  Db_Host: 'localhost',
};

test('scrubEnv removes every database-shaped variable and keeps the rest', () => {
  const env = scrubEnv(HOSTILE_PARENT);

  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'OLLAMA_HOST', 'PATH']);
});

test('scrubEnv drops every hostile name, whatever spelling and case, including the ones a name regex missed', () => {
  const env = scrubEnv({ ...HOSTILE_NAMES, PATH: '/usr/bin' });

  assert.deepEqual(Object.keys(env), ['PATH']);

  for (const name of Object.keys(HOSTILE_NAMES)) {
    assert.equal(isDatabaseShaped(name), true, `${name} is database-shaped`);
  }
});

test('the drop rule is deliberately broad: a name that merely resembles a connection setting goes too', () => {
  // These are false positives, and cost nothing: nothing under test needs them.
  for (const name of [
    'ANTHROPIC_BASE_URL',
    'ADB_SERVER_SOCKET',
    'SENTRY_DSN_URL',
    'PGP_KEY_ID',
    'LEGACY_DB_',
  ]) {
    assert.equal(isDatabaseShaped(name), true, `${name} is dropped`);
  }

  // Not database-shaped: an ordinary variable, including one that is only PART of a word.
  for (const name of [
    'OLLAMA_HOST',
    'LLM_API_BASE',
    'NODE_ENV',
    'FORCE_COLOR',
    'JWT_SECRET',
    'ADBLOCK',
    'APP_BASE_URL_X',
  ]) {
    assert.equal(isDatabaseShaped(name), false, `${name} is kept`);
  }
});

test('the keep-list: what yarn, jest and docker need survives, even where a heuristic would have dropped it', () => {
  const parent: NodeJS.ProcessEnv = {};

  for (const name of KEEP_ENV_NAMES) {
    parent[name] = 'x';
  }

  for (const prefix of KEEP_ENV_PREFIXES) {
    parent[`${prefix}SOMETHING`] = 'x';
  }

  // Names the keep-list exists to protect from the heuristic tier.
  parent.YARN_NPM_REGISTRY_URL = 'https://registry.example.com';
  parent.YARN_CACHE_DB_FOLDER = '/cache';
  parent.LC_ALL = 'en_US.UTF-8';

  const env = scrubEnv(parent);

  assert.deepEqual(Object.keys(env).sort(), Object.keys(parent).sort(), 'every kept name survived');

  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'NODE_OPTIONS',
    'TERM',
    'CI',
    'TZ',
    'LANG',
    'SHELL',
    'USER',
    'LOGNAME',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
  ]) {
    assert.ok(KEEP_ENV_NAMES.includes(name), `${name} is on the keep-list`);
  }

  assert.ok(KEEP_ENV_PREFIXES.includes('YARN_') && KEEP_ENV_PREFIXES.includes('LC_'));
});

test('the keep-list cannot save a name that CONTAINS a database word', () => {
  const env = scrubEnv({
    YARN_DATABASE_URL: 'postgres://u:REALPW@localhost:5432/companion',
    LC_POSTGRES_HOST: 'localhost',
    YARN_POWERSYNC_TOKEN: 'x',
    YARN_ENABLE_TELEMETRY: '0',
  });

  assert.deepEqual(Object.keys(env), ['YARN_ENABLE_TELEMETRY']);
});

test('buildTestEnv: nothing from the parent database configuration survives', () => {
  const env = buildTestEnv({ ...HOSTILE_PARENT, ...HOSTILE_NAMES }, DB, NO_DOTENV);
  const dump = JSON.stringify(env);

  for (const leaked of [
    'REALPW',
    'REALADMIN',
    'prod.example.com',
    ':5432',
    'localhost:5432',
    '../../../.env',
    'SOME_NEW_TEST_DATABASE_URL',
    'PGHOST',
    'POSTGRES_PASSWORD',
    'DATABASE_QUERY_LOGGING',
    ...Object.keys(HOSTILE_NAMES),
  ]) {
    assert.ok(!dump.includes(leaked), `${leaked} leaked into the test environment`);
  }

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OLLAMA_HOST, 'http://localhost:11434');
});

test('buildTestEnv sets the connection, the admin connection, CI_REQUIRE_DB and a dotenv path that does not exist', () => {
  const env = buildTestEnv({}, DB, NO_DOTENV);

  assert.equal(env.DATABASE_URL, 'postgres://companion:apppw0123@127.0.0.1:61778/companion?sslmode=disable');
  assert.equal(env.DATABASE_HOST, '127.0.0.1');
  assert.equal(env.DATABASE_PORT, '61778');
  assert.equal(env.DATABASE_USERNAME, 'companion');
  assert.equal(env.DATABASE_PASSWORD, 'apppw0123');
  assert.equal(env.DATABASE_NAME, 'companion');
  assert.equal(env.DATABASE_ADMIN_USERNAME, 'postgres');
  assert.equal(env.DATABASE_ADMIN_PASSWORD, 'adminpw4567');
  assert.equal(
    env.PIPELINE_TEST_ADMIN_DATABASE_URL,
    'postgres://postgres:adminpw4567@127.0.0.1:61778/postgres',
  );
  assert.equal(env.CI_REQUIRE_DB, '1');
  assert.equal(env.DOTENV_CONFIG_PATH, NO_DOTENV);
  assert.equal(fs.existsSync(NO_DOTENV), false);
});

test('buildTestEnv sets every *_TEST_DATABASE_URL, and the macOS one points at the EMPTY database', () => {
  const env = buildTestEnv({}, DB, NO_DOTENV);

  for (const name of TEST_DATABASE_URL_VARS) {
    assert.ok(env[name], `${name} is set`);
    assert.match(env[name]!, /^postgres:\/\/companion:apppw0123@127\.0\.0\.1:61778\//);
  }

  assert.match(env.AUTH_TEST_DATABASE_URL!, /\/companion\?sslmode=disable$/);
  assert.equal(
    env.MACOS_TEST_DATABASE_URL,
    `postgres://companion:apppw0123@127.0.0.1:61778/${EMPTY_DATABASE}`,
  );
  assert.notEqual(EMPTY_DATABASE, APP_DATABASE);
});

test('the env this builds passes its own throwaway check; a stray real URL does not', () => {
  const env = buildTestEnv(HOSTILE_PARENT, DB, NO_DOTENV);

  assert.doesNotThrow(() => assertOnlyThrowaway(env, DB.port));

  for (const [key, value] of [
    ['DATABASE_URL', 'postgres://companion:x@localhost:5432/companion'],
    ['ASKS_TEST_DATABASE_URL', 'postgres://companion:x@127.0.0.1:5432/companion'],
    ['SOME_NEW_TEST_DATABASE_URL', 'postgres://x:y@db.internal:61778/companion'],
    ['PIPELINE_TEST_ADMIN_DATABASE_URL', 'postgres://postgres:x@prod:61778/postgres'],
    ['DATABASE_HOST', 'db.internal'],
    ['PGHOST', 'db.internal'],
    ['DATABASE_PORT', '5432'],
    ['PGPORT', '5432'],
  ] as const) {
    assert.throws(
      () => assertOnlyThrowaway({ ...env, [key]: value }, DB.port),
      new RegExp(`${key}`),
      `${key}=${value} must be refused`,
    );
  }
});

test('assertOnlyThrowaway refuses every hostile name even if the scrub had missed it — whatever it points at', () => {
  const env = buildTestEnv({}, DB, NO_DOTENV);

  for (const [key, value] of Object.entries(HOSTILE_NAMES)) {
    assert.throws(
      () => assertOnlyThrowaway({ ...env, [key]: value }, DB.port),
      new RegExp(key),
      `${key}=… must be refused`,
    );
  }

  // Also when the value is one that LOOKS fine: a database-shaped variable this command did not set has no business being here.
  for (const key of [
    'HBPE_DATABASE_URL',
    'PS_REPLICATION_URI',
    'POWERSYNC_DATABASE_PASSWORD',
    'DB_HOST',
    'COMPOSE_PROJECT_NAME',
  ]) {
    assert.throws(
      () => assertOnlyThrowaway({ ...env, [key]: `postgres://x:y@127.0.0.1:${DB.port}/companion` }, DB.port),
      new RegExp(key),
      `${key} pointing at the throwaway is still refused: nothing set it on purpose`,
    );
  }
});

test('assertOnlyThrowaway is not fooled by kept names, and does not refuse the environment the scrub leaves', () => {
  const env = buildTestEnv(
    {
      ...HOSTILE_PARENT,
      ...HOSTILE_NAMES,
      YARN_NPM_REGISTRY_URL: 'https://r.example.com',
      LC_ALL: 'C',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    },
    DB,
    NO_DOTENV,
  );

  assert.doesNotThrow(() => assertOnlyThrowaway(env, DB.port));
  assert.equal(env.YARN_NPM_REGISTRY_URL, 'https://r.example.com');
});

test('assertOnlyThrowaway names the variable, never its value', () => {
  try {
    assertOnlyThrowaway({ DATABASE_URL: 'postgres://companion:TOPSECRET@prod:5432/companion' }, 61778);
    assert.fail('expected a throw');
  } catch (error) {
    assert.ok(!(error as Error).message.includes('TOPSECRET'));
    assert.match((error as Error).message, /DATABASE_URL/);
  }
});

test('randomPassword is hex, long, and different every time', () => {
  const a = randomPassword();

  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, randomPassword());
});

test('formatDuration', () => {
  assert.equal(formatDuration(950), '950ms');
  assert.equal(formatDuration(48_400), '48s');
  assert.equal(formatDuration(372_000), '6m 12s');
  assert.equal(formatDuration(125_000), '2m 05s');
});

// -- drift guard --------------------------------------------------------------

test('TEST_DATABASE_URL_VARS is exactly the set of *_TEST_DATABASE_URL variables the source tree reads', () => {
  const res = spawnSync('git', ['grep', '-ohE', '[A-Z][A-Z_]*_TEST_(ADMIN_)?DATABASE_URL', '--', 'backend'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });

  assert.equal(res.status, 0, `git grep failed: ${res.stderr}`);

  const inTree = new Set(res.stdout.split('\n').filter(Boolean));
  const listed = new Set([...TEST_DATABASE_URL_VARS, ...TEST_ADMIN_URL_VARS]);

  assert.deepEqual(
    [...inTree].filter((v) => !listed.has(v)).sort(),
    [],
    'a suite reads a variable that scripts/xtask/lib/testDb.ts does not set — add it to TEST_DATABASE_URL_VARS',
  );
  assert.deepEqual(
    [...listed].filter((v) => !inTree.has(v)).sort(),
    [],
    'testDb.ts sets a variable no suite reads any more — remove it from TEST_DATABASE_URL_VARS',
  );
});

test('every variable ci.yml sets for the backend job is one testDb.ts also sets', () => {
  const yml = fs.readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const start = yml.indexOf('  test:\n    name: Run backend tests');
  const end = yml.indexOf('\n  test-frontend:');
  const inCi = [...yml.slice(start, end).matchAll(/^ {6}([A-Z][A-Z_]*_TEST_DATABASE_URL):/gm)].map(
    (m) => m[1],
  );

  assert.ok(inCi.length > 10, 'found the backend job env block');
  assert.deepEqual(
    inCi.filter((v) => !TEST_DATABASE_URL_VARS.includes(v)),
    [],
  );
  assert.deepEqual(
    TEST_DATABASE_URL_VARS.filter((v) => !inCi.includes(v) && v !== 'MACOS_TEST_DATABASE_URL'),
    [],
    'ci.yml should set every jest-read variable test-db sets (MACOS_ is pytest-only and needs an empty database, which ci.yml does not run)',
  );
});

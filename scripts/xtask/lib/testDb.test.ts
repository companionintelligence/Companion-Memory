import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  APP_DATABASE,
  CONTAINER_PREFIX,
  DEFAULT_KEEP_FOR_MS,
  EMPTY_DATABASE,
  KEEP_ENV_NAMES,
  KEEP_ENV_PREFIXES,
  KEEP_UNTIL_LABEL_KEY,
  LABEL_KEY,
  LABEL_VALUE,
  LOCAL_IMAGE,
  MAX_KEEP_FOR_MS,
  PS_FORMAT,
  STALE_AFTER_MS,
  TEST_ADMIN_URL_VARS,
  TEST_DATABASE_URL_VARS,
  assertOnlyThrowaway,
  buildTestEnv,
  chooseImage,
  escapeRegex,
  formatAge,
  formatDuration,
  isDatabaseShaped,
  isOurs,
  jestChoosesWorkers,
  jestFiltersByName,
  keepUntil,
  keepUntilLabelValue,
  keptNotice,
  newContainerName,
  parseCiDatabaseImage,
  parseDockerPort,
  parseInspectContainers,
  parseKeepFor,
  parsePsRows,
  parseTestDbArgs,
  planReap,
  randomPassword,
  scrubEnv,
  selectStale,
  type ClientProbe,
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

// -- the --keep window: a label stamped at creation ------------------------------------------------

/** One of ours that is `ageMs` old, carrying a keep label that ends `untilMs` from NOW. */
const keptFor = (name: string, ageMs: number, untilMs: number): ContainerInfo =>
  ours(name, ageMs, {
    [LABEL_KEY]: LABEL_VALUE,
    [KEEP_UNTIL_LABEL_KEY]: keepUntilLabelValue(NOW + untilMs),
  });

test('the keep label is its own key, so `--filter label=ci.test-db=1` still lists a kept container', () => {
  assert.equal(KEEP_UNTIL_LABEL_KEY, 'ci.test-db.keep-until');
  assert.notEqual(KEEP_UNTIL_LABEL_KEY, LABEL_KEY);
  // A kept container is ours by the same two tests as any other: the keep label adds nothing to ownership.
  assert.equal(isOurs(keptFor('ci-testdb-a', 0, HOURS)), true);
  assert.equal(
    isOurs(ours('some-other-db', 0, { [KEEP_UNTIL_LABEL_KEY]: keepUntilLabelValue(NOW + HOURS) })),
    false,
    'a keep label alone does not make a container ours',
  );
});

test('keepUntilLabelValue is UTC ISO-8601 with milliseconds, and keepUntil reads back exactly what it wrote', () => {
  assert.equal(keepUntilLabelValue(Date.parse('2026-10-02T17:37:42.123Z')), '2026-10-02T17:37:42.123Z');

  for (const at of [NOW, NOW + 1, NOW + 24 * HOURS, NOW + MAX_KEEP_FOR_MS, 0]) {
    const c = ours('ci-testdb-a', 0, { [KEEP_UNTIL_LABEL_KEY]: keepUntilLabelValue(at) });

    assert.equal(keepUntil(c), at, new Date(at).toISOString());
  }
});

test('keepUntil: no label, or anything that is not exactly an ISO-8601 UTC instant, is null — nothing protects by accident', () => {
  assert.equal(keepUntil(ours('ci-testdb-a', 0)), null, 'no keep label');

  // `Date.parse` alone reads several of these as SOME date, which could protect a container for years.
  for (const value of [
    '',
    'forever',
    'tomorrow',
    '12',
    '1',
    '2099',
    '2099-01-01',
    '2099-01-01T00:00:00',
    '2099-01-01T00:00:00+02:00',
    '2099-01-01 00:00:00Z',
    '2026-13-45T99:99:99Z',
    '2026-10-02T17:37:42.Z',
    ' 2026-10-02T17:37:42.000Z',
    '2026-10-02T17:37:42.000Z ',
    '1759426662000',
  ]) {
    assert.equal(
      keepUntil(ours('ci-testdb-a', 0, { [LABEL_KEY]: LABEL_VALUE, [KEEP_UNTIL_LABEL_KEY]: value })),
      null,
      `'${value}'`,
    );
  }

  // Without milliseconds, and with more of them, are still instants.
  const second = Date.parse('2026-10-02T17:37:42Z');

  assert.equal(keepUntil(ours('ci-testdb-a', 0, { [KEEP_UNTIL_LABEL_KEY]: '2026-10-02T17:37:42Z' })), second);
  assert.equal(
    keepUntil(ours('ci-testdb-a', 0, { [KEEP_UNTIL_LABEL_KEY]: '2026-10-02T17:37:42.123456789Z' })),
    second + 123,
  );
});

test('the keep window has a default that outlasts the 11-hour case, and a cap that keeps its label printable', () => {
  assert.equal(DEFAULT_KEEP_FOR_MS, 24 * HOURS);
  assert.ok(DEFAULT_KEEP_FOR_MS > 11 * HOURS, 'a kept database was reaped at 11 hours old');
  assert.ok(
    DEFAULT_KEEP_FOR_MS > STALE_AFTER_MS,
    'a window shorter than the age floor would protect nothing',
  );
  assert.equal(MAX_KEEP_FOR_MS, 7 * 24 * HOURS);
  assert.ok(DEFAULT_KEEP_FOR_MS <= MAX_KEEP_FOR_MS);
  // The cap's other job: `now + keepFor` must stay a date `toISOString` can print.
  assert.doesNotThrow(() => keepUntilLabelValue(Date.now() + MAX_KEEP_FOR_MS));
  assert.throws(
    () => keepUntilLabelValue(Number.NaN),
    RangeError,
    'this is what an unbounded value would do',
  );
});

// -- planReap: what the reaper does with a listing --------------------------------------------------------

/** A probe that answers from a table by name, and records every container it was asked about. */
function probing(answers: Record<string, ClientProbe>) {
  const asked: string[] = [];

  return {
    asked,
    probe: (c: ContainerInfo): ClientProbe => {
      asked.push(c.name);

      return answers[c.name] ?? { state: 'unknown', detail: `no answer scripted for ${c.name}` };
    },
  };
}

test('planReap: a stale container with clients is spared — the 12-worker jest run at 2h01m', () => {
  const { probe } = probing({ 'ci-testdb-42b8deef': { state: 'counted', clients: 12 } });
  const plan = planReap([ours('ci-testdb-42b8deef', 2 * HOURS + 60_000)], NOW, probe);

  assert.deepEqual(plan.remove, []);
  assert.deepEqual(
    plan.spared.map((s) => [s.container.name, s.why, s.why === 'in-use' ? s.clients : undefined]),
    [['ci-testdb-42b8deef', 'in-use', 12]],
  );
});

test('planReap: the decision table, one row per answer the probe can give', () => {
  const { probe } = probing({
    'ci-testdb-idle': { state: 'counted', clients: 0 },
    'ci-testdb-busy': { state: 'counted', clients: 1 },
    'ci-testdb-dead': { state: 'no-process' },
    'ci-testdb-unsure': { state: 'unknown', detail: 'docker exec timed out' },
  });
  const plan = planReap(
    ['idle', 'busy', 'dead', 'unsure'].map((n) => ours(`ci-testdb-${n}`, 5 * HOURS)),
    NOW,
    probe,
  );

  assert.deepEqual(
    plan.remove.map((c) => c.name),
    ['ci-testdb-idle', 'ci-testdb-dead'],
    'idle, and nothing-running, go',
  );
  assert.deepEqual(
    plan.spared.map((s) => [s.container.name, s.why]),
    [
      ['ci-testdb-busy', 'in-use'],
      ['ci-testdb-unsure', 'unverified'],
    ],
    'busy, and could-not-tell, stay: an unknown is never idle',
  );
  const unsure = plan.spared.find((s) => s.container.name === 'ci-testdb-unsure');

  assert.deepEqual(
    unsure?.why === 'unverified' ? unsure.detail : undefined,
    'docker exec timed out',
    'and the reason travels with it',
  );
});

test('planReap: a container inside its keep window is spared WITHOUT being probed, at any client count', () => {
  const { probe, asked } = probing({ 'ci-testdb-kept': { state: 'counted', clients: 0 } });
  const plan = planReap([keptFor('ci-testdb-kept', 11 * HOURS, 13 * HOURS)], NOW, probe);

  assert.deepEqual(plan.remove, []);
  assert.deepEqual(asked, [], 'the label settles it; there is nothing to ask');
  assert.equal(plan.spared.length, 1);
  assert.deepEqual(
    [plan.spared[0].why, plan.spared[0].why === 'kept' ? plan.spared[0].until : null],
    ['kept', NOW + 13 * HOURS],
  );
});

test('planReap: an ended keep window protects nothing — the probe decides, both ways', () => {
  const { probe, asked } = probing({
    'ci-testdb-over-idle': { state: 'counted', clients: 0 },
    'ci-testdb-over-busy': { state: 'counted', clients: 2 },
  });
  const plan = planReap(
    [keptFor('ci-testdb-over-idle', 30 * HOURS, -HOURS), keptFor('ci-testdb-over-busy', 30 * HOURS, -1)],
    NOW,
    probe,
  );

  assert.deepEqual(asked, ['ci-testdb-over-idle', 'ci-testdb-over-busy']);
  assert.deepEqual(
    plan.remove.map((c) => c.name),
    ['ci-testdb-over-idle'],
  );
  assert.deepEqual(
    plan.spared.map((s) => s.why),
    ['in-use'],
  );
});

test('planReap: a window ending exactly now is over; one more millisecond and it is not', () => {
  const idle = { state: 'counted', clients: 0 } as const;
  const at = (untilMs: number) =>
    planReap([keptFor('ci-testdb-a', 30 * HOURS, untilMs)], NOW, () => idle).remove.length;

  assert.equal(at(0), 1);
  assert.equal(at(1), 0);
});

test('planReap asks about NOBODY it could not remove anyway: not ours, not old enough, clock unreadable', () => {
  const { probe, asked } = probing({});
  const plan = planReap(
    [
      ours('ci-testdb-young', 119 * 60_000),
      ours('ci-testdb-edge', STALE_AFTER_MS),
      ours('ci-testdb-nolabel', 99 * HOURS, {}),
      ours('postgres-other', 99 * HOURS, { [LABEL_KEY]: LABEL_VALUE }),
      { ...ours('ci-testdb-mystery', 99 * HOURS), createdAt: null },
    ],
    NOW,
    probe,
  );

  assert.deepEqual(asked, [], "nothing was exec'd into");
  assert.deepEqual(plan, { remove: [], spared: [] });
});

test('planReap honours a different age limit, and keeps the order of the listing', () => {
  const idle = { state: 'counted', clients: 0 } as const;
  const plan = planReap(
    [ours('ci-testdb-b', 10 * 60_000), ours('ci-testdb-a', 20 * 60_000)],
    NOW,
    () => idle,
    5 * 60_000,
  );

  assert.deepEqual(
    plan.remove.map((c) => c.name),
    ['ci-testdb-b', 'ci-testdb-a'],
  );
});

// -- --keep-for ---------------------------------------------------------------------------------------------

test('parseKeepFor: a whole number and one unit of m, h or d', () => {
  assert.equal(parseKeepFor('1m'), 60_000);
  assert.equal(parseKeepFor('90m'), 90 * 60_000);
  assert.equal(parseKeepFor('12h'), 12 * HOURS);
  assert.equal(parseKeepFor('24h'), DEFAULT_KEEP_FOR_MS);
  assert.equal(parseKeepFor('2d'), 48 * HOURS);
  assert.equal(parseKeepFor('7d'), MAX_KEEP_FOR_MS, 'the cap itself is allowed');
  assert.equal(parseKeepFor('168h'), MAX_KEEP_FOR_MS);
  assert.equal(parseKeepFor('007h'), 7 * HOURS);
});

test('parseKeepFor refuses everything else, naming the flag and what it would take — it never guesses', () => {
  for (const bad of [
    '',
    '12',
    '0m',
    '0h',
    '0d',
    '-5h',
    '1.5h',
    '1h30m',
    '12 h',
    ' 12h',
    '12h ',
    '12H',
    '12hours',
    'h',
    'forever',
    '1w',
    '30s',
    '+5h',
    '1e3m',
    '99999999999999999999999999d',
    '9'.repeat(400) + 'd',
  ]) {
    assert.throws(
      () => parseKeepFor(bad),
      /--keep-for must be a whole, positive number with a unit of m, h or d \(for example 30m, 12h, 2d\)/,
      `'${bad}'`,
    );
  }
});

test('parseKeepFor: over the cap is its own error, which says how to protect a container for longer', () => {
  for (const tooLong of ['8d', '169h', '10081m', '365d', '99999d']) {
    assert.throws(
      () => parseKeepFor(tooLong),
      /--keep-for is at most 7d, got '.*'\. `docker rename`/,
      tooLong,
    );
  }
});

test('parseTestDbArgs: --keep-for sets the window AND implies --keep, in either value syntax', () => {
  const a = parseTestDbArgs(['--keep-for', '12h']);
  const b = parseTestDbArgs(['--keep-for=2d']);

  assert.deepEqual([a.keep, a.keepFor], [true, 12 * HOURS]);
  assert.deepEqual([b.keep, b.keepFor], [true, 48 * HOURS]);
  assert.deepEqual(parseTestDbArgs(['--keep', '--keep-for', '3h']).keepFor, 3 * HOURS);
  assert.deepEqual(parseTestDbArgs(['--keep-for', '3h', '--keep']).keepFor, 3 * HOURS);
  assert.equal(parseTestDbArgs(['--keep-for', '3h', '--workers', '2', 'src/x']).workers, 2);
  assert.deepEqual(parseTestDbArgs(['--keep-for', '3h', 'src/x']).jestArgs, ['src/x']);
});

test('parseTestDbArgs: --keep alone has no window of its own (the default applies), and no flag keeps nothing', () => {
  const keep = parseTestDbArgs(['--keep']);

  assert.equal(keep.keep, true);
  assert.equal(
    'keepFor' in keep,
    false,
    'absent, not undefined: the default is applied where the container is made',
  );
  assert.equal(parseTestDbArgs([]).keep, false);
  assert.equal('keepFor' in parseTestDbArgs([]), false);
});

test("parseTestDbArgs: --keep-for needs a value, a good one, and after -- it is jest's", () => {
  assert.throws(() => parseTestDbArgs(['--keep-for']), /--keep-for needs a value/);
  assert.throws(() => parseTestDbArgs(['--keep-for', '--keep']), /--keep-for needs a value/);
  assert.throws(
    () => parseTestDbArgs(['--keep-for', 'a-while']),
    /--keep-for must be a whole, positive number/,
  );
  assert.throws(() => parseTestDbArgs(['--keep-for=30d']), /--keep-for is at most 7d/);
  // A bad value fails the whole command: it is never silently replaced by the default.
  assert.throws(() => parseTestDbArgs(['--keep', '--keep-for', '12']), /--keep-for must be/);

  const after = parseTestDbArgs(['--', '--keep-for', '12h']);

  assert.equal(after.keep, false);
  assert.deepEqual(after.jestArgs, ['--keep-for', '12h']);
});

// -- messages -------------------------------------------------------------------------------------------------

test('formatAge: minutes, hours, days — whole hours without a dangling 00m, the default window as the 24h it is typed as', () => {
  assert.equal(formatAge(0), '0m');
  assert.equal(formatAge(-5 * 60_000), '0m');
  assert.equal(formatAge(59_999), '0m');
  assert.equal(formatAge(45 * 60_000), '45m');
  assert.equal(formatAge(60 * 60_000), '1h');
  assert.equal(formatAge(STALE_AFTER_MS), '2h');
  assert.equal(formatAge(2 * HOURS + 60_000), '2h 01m');
  assert.equal(formatAge(11 * HOURS + 5 * 60_000), '11h 05m');
  assert.equal(formatAge(DEFAULT_KEEP_FOR_MS), '24h');
  assert.equal(formatAge(47 * HOURS + 59 * 60_000), '47h 59m');
  assert.equal(formatAge(48 * HOURS), '2d');
  assert.equal(formatAge(51 * HOURS), '2d 3h');
  assert.equal(formatAge(MAX_KEEP_FOR_MS), '7d');
});

test('keptNotice rounds the time left UP to the minute: a window made a moment ago is the 3h it was asked for', () => {
  const left = (ms: number): string | undefined =>
    /\((.*) from now\)/.exec(keptNotice('ci-testdb-a', 1, 'pw', NOW + 3 * HOURS, NOW + ms).join('\n'))?.[1];

  assert.equal(left(0), '3h');
  assert.equal(left(300), '3h', '300 ms into the run');
  assert.equal(left(59_999), '3h', 'a second short of a minute');
  assert.equal(left(60_000), '2h 59m');
  assert.equal(left(25 * 60_000 + 1), '2h 35m', 'a 25-minute jest run later');
  assert.equal(left(3 * HOURS - 30_000), '1m', 'half a minute left still reads as a minute, not 0m');
});

test('keptNotice: how to reach and remove the database, how long it is protected, and how to protect it longer — and no word of the old rule', () => {
  const until = NOW + DEFAULT_KEEP_FOR_MS;
  const lines = keptNotice('ci-testdb-ab12cd34', 61778, 'apppw0123', until, NOW);
  const text = lines.join('\n');

  assert.match(lines[0], /^Kept ci-testdb-ab12cd34 on 127\.0\.0\.1:61778 \(throwaway; loopback only\)\.$/);
  assert.match(text, /docker exec -it ci-testdb-ab12cd34 psql -U postgres -d companion/);
  assert.match(text, /postgres:\/\/companion:apppw0123@127\.0\.0\.1:61778\/companion\?sslmode=disable/);
  assert.match(text, /remove it: {10}docker rm -f -v ci-testdb-ab12cd34/);
  assert.match(text, /protected until: {4}2026-09-30T12:00:00\.000Z \(24h from now\)/);
  assert.match(text, /will not remove it before then, nor while anything is connected to it/);
  assert.match(text, /--keep-for <duration> on the next run \(default 24h, at most 7d\)/);
  assert.match(text, /docker rename ci-testdb-ab12cd34 <new name>/);
  assert.doesNotMatch(text, /two hours|removes it anyway|next `make test-db` removes/i);

  // The label the reaper reads is the instant the notice prints.
  assert.match(text, new RegExp(keepUntilLabelValue(until).replace(/\./g, '\\.')));
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
    /Unknown flag '--kepp'.*--help, --keep, --keep-for, --image, --workers, --no-retry.*after '--'/s,
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

// The probe helper's own spec drives `databaseAvailability` / `dataSourceConnection` with
// variable names it invents (`PROBE_SPEC_*`, `NOTES_ABSENT_*`), one per case, so each gets a
// clean cache key. They are test inputs, not variables any suite reads. Listing them would be
// wrong, not just noisy: `buildTestEnv` sets every listed name to the throwaway URL, and the
// "no database configured" cases need theirs unset.
const INVENTED_NAMES_SPEC =
  'backend/apps/api/src/domains/__tests__/support/__tests__/databaseConnection.spec.ts';

test('TEST_DATABASE_URL_VARS is exactly the set of *_TEST_DATABASE_URL variables the source tree reads', () => {
  const res = spawnSync(
    'git',
    [
      'grep',
      '-ohE',
      '[A-Z][A-Z_]*_TEST_(ADMIN_)?DATABASE_URL',
      '--',
      'backend',
      `:(exclude)${INVENTED_NAMES_SPEC}`,
    ],
    {
      encoding: 'utf8',
      cwd: process.cwd(),
    },
  );

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

/**
 * The stale-container reaper, end to end against a model of the docker daemon: what survives in the daemon,
 * which calls were made, and what was said. The decision itself is `planReap` (testDb.test.ts); what these
 * pin is that the reaper asks the right questions, only of the right containers, and acts on the answers.
 *
 * The first test is the incident: `ci-testdb-42b8deef`, 2h01m old, a 12-worker jest run connected to it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLIENT_COUNT_SQL } from './docker';
import { FakeDaemon, failed, ok, timedOut, type FakeContainer, type FakeDaemonOptions } from './fakeDocker';
import { reapStaleContainers, type Say } from './reaper';
import { KEEP_UNTIL_LABEL_KEY, LABEL_KEY, LABEL_VALUE, STALE_AFTER_MS, keepUntilLabelValue } from './testDb';

const NOW = Date.parse('2026-10-01T18:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const noSleep = (): void => undefined;

const id = (n: number): string => n.toString(16).padStart(64, '0');

/** One of our containers: named and labelled the way `startContainer` makes them, `ageMs` old. */
function db(n: number, name: string, ageMs: number, extra: Partial<FakeContainer> = {}): FakeContainer {
  return { id: id(n), name, labels: { [LABEL_KEY]: LABEL_VALUE }, createdAt: NOW - ageMs, ...extra };
}

/** A `--keep` container whose window ends `untilMs` after NOW (negative: ended already). */
function kept(n: number, name: string, ageMs: number, untilMs: number, extra: Partial<FakeContainer> = {}) {
  const container = db(n, name, ageMs, extra);

  container.labels[KEEP_UNTIL_LABEL_KEY] = keepUntilLabelValue(NOW + untilMs);

  return container;
}

function recorder() {
  const lines: Array<{ level: 'ok' | 'note' | 'info'; text: string }> = [];
  const say: Say = {
    ok: (text) => lines.push({ level: 'ok', text }),
    note: (text) => lines.push({ level: 'note', text }),
    info: (text) => lines.push({ level: 'info', text }),
  };

  return {
    say,
    lines,
    said: (level: 'ok' | 'note' | 'info') => lines.filter((l) => l.level === level).map((l) => l.text),
  };
}

function reap(containers: FakeContainer[], daemon: FakeDaemonOptions = {}) {
  const d = new FakeDaemon({ containers, ...daemon });
  const r = recorder();
  const report = reapStaleContainers({ run: d.run, now: () => NOW, sleep: noSleep, say: r.say });

  return { d, report, ...r };
}

const names = (d: FakeDaemon): string[] => d.containers.map((c) => c.name).sort();
const execTargets = (d: FakeDaemon): string[] => d.sub('exec').map((a) => a[1]);
const rmTargets = (d: FakeDaemon): string[] => d.sub('rm').map((a) => a[a.length - 1]);

// -- the incident ------------------------------------------------------------------------------

test('INCIDENT: a 2h01m-old database with 12 clients connected is NOT removed, and the warning says why and how to protect it', () => {
  const { d, report, said } = reap([db(1, 'ci-testdb-42b8deef', 2 * HOUR + MIN, { clients: 12 })]);

  assert.deepEqual(names(d), ['ci-testdb-42b8deef'], 'the daemon still has it');
  assert.deepEqual(rmTargets(d), [], 'no removal was even attempted');
  assert.deepEqual(report.removed, []);
  assert.deepEqual(execTargets(d), [id(1)], 'it was asked, by id');

  const warnings = said('note');

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ci-testdb-42b8deef/, 'names the container');
  assert.match(warnings[0], /12 client connections/, 'and how many clients');
  assert.match(warnings[0], /docker rename ci-testdb-42b8deef <new name>/, 'and that renaming protects it');
  assert.match(warnings[0], /2h 01m old/);
  assert.deepEqual(said('ok'), [], 'and nothing says all is well');
});

test('one client is "1 client connection", not "1 client connections"', () => {
  const { said } = reap([db(1, 'ci-testdb-aaaaaaaa', 3 * HOUR, { clients: 1 })]);

  assert.match(said('note')[0], /1 client connection open/);
});

// -- what is removed ----------------------------------------------------------------------------

test('a stale database nothing is connected to is removed — the leak the reaper exists for', () => {
  const { d, report, said } = reap([db(1, 'ci-testdb-deadbeef', 5 * HOUR, { clients: 0 })]);

  assert.deepEqual(names(d), []);
  assert.deepEqual(report.removed, ['ci-testdb-deadbeef']);
  assert.deepEqual(rmTargets(d), [id(1)]);
  assert.match(
    said('note')[0],
    /Removed 1 stale test database container\(s\) older than 2h .*ci-testdb-deadbeef/,
  );
});

test('a container with nothing running in it (created, exited, dead) has no clients, so it is removed rather than left to nag for ever', () => {
  for (const status of ['created', 'exited', 'dead']) {
    const { d, report, said } = reap([db(1, 'ci-testdb-aaaaaaaa', 4 * HOUR, { status })]);

    assert.deepEqual(names(d), [], `${status}: removed`);
    assert.deepEqual(report.removed, ['ci-testdb-aaaaaaaa']);
    assert.ok(!said('note').some((n) => /NOT removing/.test(n)), `${status}: nothing was refused`);
  }
});

test('a container that vanished between the listing and the probe is not a warning', () => {
  const { said, report } = reap([db(1, 'ci-testdb-aaaaaaaa', 4 * HOUR)], {
    override: {
      exec: (_args, d) => {
        d.containers.splice(0); // gone by the time it is asked

        return undefined;
      },
    },
  });

  assert.ok(!said('note').some((n) => /NOT removing|Could not/.test(n)), said('note').join('\n'));
  assert.deepEqual(report.spared, []);
});

// -- what is left alone ---------------------------------------------------------------------------

test('a container could not be probed: it is LEFT ALONE and named — an unknown is never read as idle', () => {
  for (const [label, override] of [
    ['exec timed out', { exec: () => timedOut('exec') }],
    [
      'the database is starting up',
      {
        exec: () =>
          failed('psql: error: connection to server failed: FATAL:  the database system is starting up'),
      },
    ],
    ['psql printed something that is not a count', { exec: () => ok('ERROR\n') }],
    ['psql printed nothing', { exec: () => ok('') }],
  ] as const) {
    const { d, report, said } = reap([db(1, 'ci-testdb-aaaaaaaa', 4 * HOUR)], { override });

    assert.deepEqual(names(d), ['ci-testdb-aaaaaaaa'], `${label}: still there`);
    assert.deepEqual(rmTargets(d), [], `${label}: no removal attempted`);
    assert.equal(report.spared[0]?.why, 'unverified', label);

    const warning = said('note').join('\n');

    assert.match(warning, /NOT removing ci-testdb-aaaaaaaa/, label);
    assert.match(warning, /could not tell whether anything is connected/, label);
    assert.match(warning, /docker rm -f -v ci-testdb-aaaaaaaa/, `${label}: and how to remove it by hand`);
  }
});

test('a paused container is left alone: connections survive a pause, and docker exec cannot look', () => {
  const { d, report, said } = reap([db(1, 'ci-testdb-aaaaaaaa', 4 * HOUR, { status: 'paused' })]);

  assert.deepEqual(names(d), ['ci-testdb-aaaaaaaa']);
  assert.equal(report.spared[0]?.why, 'unverified');
  assert.match(said('note').join('\n'), /paused/);
});

test('a probe AND a state lookup that both fail is unverified, and says both', () => {
  const { d, said } = reap([db(1, 'ci-testdb-aaaaaaaa', 4 * HOUR)], {
    override: {
      exec: () => timedOut('exec'),
      inspect: (args) => (args.includes('{{.State.Status}}') ? timedOut('inspect') : undefined),
    },
  });

  assert.deepEqual(names(d), ['ci-testdb-aaaaaaaa']);
  assert.match(
    said('note').join('\n'),
    /exec timed out.*its state could not be read either \(docker inspect timed out/,
  );
});

// -- the --keep window ----------------------------------------------------------------------------

test("KEPT: a container inside its --keep window is left alone WITHOUT being exec'd into, even at zero clients — the gap between two jest runs", () => {
  const { d, report, said } = reap([kept(1, 'ci-testdb-aaaaaaaa', 11 * HOUR, 13 * HOUR, { clients: 0 })]);

  assert.deepEqual(names(d), ['ci-testdb-aaaaaaaa']);
  assert.deepEqual(execTargets(d), [], 'no reason to look inside');
  assert.deepEqual(rmTargets(d), []);
  assert.equal(report.spared[0]?.why, 'kept');
  assert.deepEqual(said('note'), [], 'not a warning: this is as intended');
  assert.match(
    said('info')[0],
    /Leaving ci-testdb-aaaaaaaa alone \(11h old\).*protected until 2026-10-02T07:00:00\.000Z/,
  );
  assert.deepEqual(said('ok'), []);
});

test('a --keep window that has ended no longer protects: probed, removed when idle', () => {
  const { d, report } = reap([kept(1, 'ci-testdb-aaaaaaaa', 30 * HOUR, -1 * HOUR, { clients: 0 })]);

  assert.deepEqual(names(d), []);
  assert.deepEqual(report.removed, ['ci-testdb-aaaaaaaa']);
});

test('…and an expired window with a client still connected is spared by the probe', () => {
  const { d, report, said } = reap([kept(1, 'ci-testdb-aaaaaaaa', 30 * HOUR, -1 * HOUR, { clients: 3 })]);

  assert.deepEqual(names(d), ['ci-testdb-aaaaaaaa']);
  assert.equal(report.spared[0]?.why, 'in-use');
  assert.match(said('note')[0], /3 client connections/);
});

test('the window ending exactly now is over: protection is strictly "until"', () => {
  const { report } = reap([kept(1, 'ci-testdb-aaaaaaaa', 30 * HOUR, 0, { clients: 0 })]);

  assert.deepEqual(report.removed, ['ci-testdb-aaaaaaaa']);
});

test('a damaged or hand-typed keep label protects nothing: it falls through to the probe', () => {
  for (const value of [
    'forever',
    '12',
    '1',
    '',
    '2026-13-45T99:99:99Z',
    '2026-10-02',
    '2099-01-01',
    'tomorrow',
  ]) {
    const container = db(1, 'ci-testdb-aaaaaaaa', 4 * HOUR, { clients: 0 });

    container.labels[KEEP_UNTIL_LABEL_KEY] = value;

    const { d, report } = reap([container]);

    assert.deepEqual(execTargets(d), [id(1)], `'${value}': asked`);
    assert.deepEqual(
      report.removed,
      ['ci-testdb-aaaaaaaa'],
      `'${value}': removed, since nothing protects it`,
    );
  }
});

// -- who is ever touched -----------------------------------------------------------------------------

test('only ci-testdb-* containers carrying the label are ever probed or removed — however old, however idle', () => {
  const owners: FakeContainer[] = [
    { id: id(10), name: 'ci-testdb-nolabel', labels: {}, createdAt: NOW - 99 * HOUR },
    { id: id(11), name: 'ci-testdb-wronglabel', labels: { [LABEL_KEY]: '0' }, createdAt: NOW - 99 * HOUR },
    { id: id(12), name: 'postgres-other', labels: { [LABEL_KEY]: LABEL_VALUE }, createdAt: NOW - 99 * HOUR },
    {
      id: id(13),
      name: 'ci-server-nervous-jackson-7a51b2-database-1',
      labels: { 'com.docker.compose.project': 'x' },
      createdAt: NOW - 99 * HOUR,
    },
    // A container that is not ours but has a keep label of its own: that label gives it nothing, and costs it nothing.
    {
      id: id(14),
      name: 'mine-renamed',
      labels: { [LABEL_KEY]: LABEL_VALUE, [KEEP_UNTIL_LABEL_KEY]: keepUntilLabelValue(NOW - HOUR) },
      createdAt: NOW - 99 * HOUR,
    },
  ];
  const { d, report } = reap(owners);

  assert.deepEqual(execTargets(d), [], "not one of them was exec'd into");
  assert.deepEqual(rmTargets(d), [], 'and not one was removed');
  assert.equal(d.containers.length, owners.length);
  assert.deepEqual(report, { removed: [], failed: [], spared: [] });
});

test('a young container is neither probed nor removed — the 2h age floor is unchanged, and strict', () => {
  const { d } = reap([
    db(1, 'ci-testdb-young', 119 * MIN, { clients: 0 }),
    db(2, 'ci-testdb-edge', STALE_AFTER_MS, { clients: 0 }),
    db(3, 'ci-testdb-fresh', 1 * MIN, { clients: 0 }),
  ]);

  assert.deepEqual(execTargets(d), []);
  assert.deepEqual(rmTargets(d), []);
  assert.equal(d.containers.length, 3);
});

test('a container whose creation time cannot be read is left alone', () => {
  const unreadable = db(1, 'ci-testdb-aaaaaaaa', 99 * HOUR, { clients: 0 });
  const d = new FakeDaemon({
    containers: [unreadable],
    override: {
      inspect: () => ok(`${unreadable.id}|/${unreadable.name}|not-a-date|{"ci.test-db":"1"}\n`),
    },
  });

  reapStaleContainers({ run: d.run, now: () => NOW, sleep: noSleep, say: recorder().say });

  assert.deepEqual(rmTargets(d), []);
  assert.deepEqual(execTargets(d), []);
});

// -- the mixture a real machine has ---------------------------------------------------------------------

test('MIXED: only the idle stale one goes; the busy one, the kept one, the young one and the stranger all stay', () => {
  const { d, report, said } = reap([
    db(1, 'ci-testdb-idle', 6 * HOUR, { clients: 0 }),
    db(2, 'ci-testdb-busy', 3 * HOUR, { clients: 12 }),
    kept(3, 'ci-testdb-kept', 10 * HOUR, 14 * HOUR, { clients: 0 }),
    db(4, 'ci-testdb-young', 30 * MIN, { clients: 0 }),
    { id: id(5), name: 'someone-elses-db', labels: {}, createdAt: NOW - 50 * HOUR },
  ]);

  assert.deepEqual(names(d), ['ci-testdb-busy', 'ci-testdb-kept', 'ci-testdb-young', 'someone-elses-db']);
  assert.deepEqual(report.removed, ['ci-testdb-idle']);
  assert.deepEqual(rmTargets(d), [id(1)], 'exactly one removal, and it is the idle one');
  assert.deepEqual(
    execTargets(d).sort(),
    [id(1), id(2)].sort(),
    'only the two that needed asking were asked',
  );
  assert.deepEqual(report.spared.map((s) => [s.container.name, s.why]).sort(), [
    ['ci-testdb-busy', 'in-use'],
    ['ci-testdb-kept', 'kept'],
  ]);
  assert.equal(said('note').filter((n) => /NOT removing ci-testdb-busy/.test(n)).length, 1);
});

// -- the listing, the tick and the failures -------------------------------------------------------------

test('nothing stale: the tick, and not one question put to any container', () => {
  const { d, said } = reap([db(1, 'ci-testdb-fresh', 10 * MIN, { clients: 0 })]);

  assert.deepEqual(said('ok'), ['No stale test databases to reap']);
  assert.deepEqual(execTargets(d), []);
});

test('nothing at all: the tick', () => {
  assert.deepEqual(reap([]).said('ok'), ['No stale test databases to reap']);
});

test('everything stale was spared: no tick (it would be false) and no "Removed 0"', () => {
  const { lines } = reap([db(1, 'ci-testdb-busy', 3 * HOUR, { clients: 4 })]);

  assert.ok(!lines.some((l) => l.level === 'ok'));
  assert.ok(!lines.some((l) => /Removed/.test(l.text)));
});

test('a listing that failed is reported, never read as "none", and removes nothing', () => {
  const { said, d } = reap([db(1, 'ci-testdb-aaaaaaaa', 9 * HOUR)], {
    override: { ps: () => failed('Cannot connect to the Docker daemon') },
  });

  assert.match(
    said('note')[0],
    /Could not check for stale test databases \(docker ps failed: Cannot connect/,
  );
  assert.deepEqual(said('ok'), [], 'no tick for a check that did not happen');
  assert.deepEqual(rmTargets(d), []);
});

test('a removal that is not confirmed is reported with the command to run', () => {
  const { report, said } = reap([db(1, 'ci-testdb-aaaaaaaa', 9 * HOUR, { clients: 0 })], {
    override: {
      rm: () => failed('Error response from daemon: boom'),
      // The verification (ps --format) fails too; the listing (ps -q) still works.
      ps: (args) => (args.includes('--format') ? failed('daemon down') : undefined),
    },
  });

  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.failed, ['ci-testdb-aaaaaaaa']);
  assert.match(
    said('note').join('\n'),
    /Could not remove: ci-testdb-aaaaaaaa \(docker would not confirm ci-testdb-aaaaaaaa\).*docker rm -f -v <name>/,
  );
});

test('every docker call the reaper makes carries a timeout: a daemon that never answers cannot hold a run for ever', () => {
  const scenarios: Array<[string, FakeContainer[], FakeDaemonOptions]> = [
    ['idle stale', [db(1, 'ci-testdb-a', 5 * HOUR)], {}],
    ['busy stale', [db(1, 'ci-testdb-a', 5 * HOUR, { clients: 2 })], {}],
    ['not running', [db(1, 'ci-testdb-a', 5 * HOUR, { status: 'exited' })], {}],
    ['kept', [kept(1, 'ci-testdb-a', 5 * HOUR, 5 * HOUR)], {}],
    [
      'probe fails',
      [db(1, 'ci-testdb-a', 5 * HOUR)],
      {
        override: {
          exec: () => timedOut('exec'),
          inspect: (a: string[]) => (a.includes('{{.State.Status}}') ? timedOut('inspect') : undefined),
        },
      },
    ],
    ['rm fails', [db(1, 'ci-testdb-a', 5 * HOUR)], { override: { rm: () => failed('x') } }],
  ];

  for (const [label, containers, options] of scenarios) {
    const { d } = reap(containers, options);

    assert.ok(d.calls.length > 0, `${label}: made calls`);

    for (const call of d.calls) {
      const t = call.opts?.timeoutMs;

      assert.ok(
        typeof t === 'number' && Number.isFinite(t) && t > 0,
        `${label}: 'docker ${call.args.slice(0, 2).join(' ')}' has no timeoutMs`,
      );
    }
  }
});

test('the probe is `psql` as the superuser on the maintenance database, run by id, with nothing on the command line but the count query', () => {
  const { d } = reap([db(1, 'ci-testdb-a', 5 * HOUR)]);

  assert.deepEqual(d.sub('exec'), [
    ['exec', id(1), 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At', '-c', CLIENT_COUNT_SQL],
  ]);
});

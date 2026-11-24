import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CLIENT_COUNT_SQL,
  DOCKER_LIST_TIMEOUT_MS,
  DOCKER_PROBE_TIMEOUT_MS,
  DOCKER_QUERY_TIMEOUT_MS,
  DOCKER_RM_TIMEOUT_MS,
  DOCKER_RUN_TIMEOUT_MS,
  DOCKER_SQL_TIMEOUT_MS,
  IMAGE_PROBE_ATTEMPTS,
  PORT_LOOKUP_BUDGET_MS,
  REMOVE_ATTEMPTS,
  containerStatus,
  docker,
  imageState,
  listOurContainers,
  ourContainerNamed,
  probeClients,
  removeContainers,
  removeOursByName,
  startContainer,
  type CreatedContainer,
  type DockerFn,
} from './docker';
import { FakeDaemon, failed, ok, ours, timedOut, type FakeDaemonOptions } from './fakeDocker';
import { KEEP_UNTIL_LABEL_KEY, LABEL_KEY, LABEL_VALUE, type ContainerInfo } from './testDb';

const NAME = 'ci-testdb-deadbeef';
const ID = 'f'.repeat(64);
const ROW = `${ID}|${NAME}|1\n`;
const noSleep = (): void => undefined;

function hooks() {
  const events: string[] = [];

  return {
    events,
    opts: {
      onCreated: (c: CreatedContainer) => events.push(`created ${c.id}`),
      onRemoved: (c: CreatedContainer) => events.push(`removed ${c.id}`),
      onUncertain: (n: string) => events.push(`uncertain ${n}`),
      sleep: noSleep,
    },
  };
}

/** A daemon on which `docker run` creates the container, as the real one does. */
const creating = (extra: FakeDaemonOptions = {}) => {
  const override = extra.override ?? {};

  return new FakeDaemon({
    ...extra,
    override: {
      run: (_args, d) => {
        d.containers.push(ours(ID, NAME));

        return ok(`${ID}\n`);
      },
      port: () => ok('127.0.0.1:61778\n'),
      ...override,
    },
  });
};

// -- the happy path -------------------------------------------------------------------------

test('success: returns the id and port, and removes nothing', () => {
  const d = creating();
  const h = hooks();
  const started = startContainer('img', NAME, 'pw', { ...h.opts, run: d.run });

  assert.deepEqual(started, { id: ID, name: NAME, port: 61778 });
  assert.deepEqual(h.events, [`created ${ID}`]);
  assert.equal(d.sub('rm').length, 0);
  assert.equal(d.containers.length, 1, 'the container is still running');
});

test('the published port shows up late: retried, and nothing removed', () => {
  let attempts = 0;
  const d = creating({
    override: { port: () => (++attempts < 4 ? failed('no public port') : ok('127.0.0.1:50000\n')) },
  });
  const slept: number[] = [];
  const h = hooks();
  const started = startContainer('img', NAME, 'pw', { ...h.opts, run: d.run, sleep: (ms) => slept.push(ms) });

  assert.equal(started.port, 50000);
  assert.equal(slept.length, 3);
  assert.equal(d.sub('rm').length, 0);
});

test('`docker run` is labelled as ours, published on loopback only, and reaped by docker on exit', () => {
  // Two mutations of the command survived the whole suite: dropping the label (which is what every removal
  // and the stale-container reaper trust) and publishing on every interface (`-p 5432`, an unauthenticated
  // superuser database on the LAN). Both are one-token changes nothing else would notice.
  const d = creating();

  startContainer('img', NAME, 'pw', { ...hooks().opts, run: d.run });

  const argv = d.sub('run')[0];
  const at = (flag: string): string => argv[argv.indexOf(flag) + 1];

  assert.equal(at('--label'), `${LABEL_KEY}=${LABEL_VALUE}`);
  assert.equal(at('-p'), '127.0.0.1::5432');
  assert.equal(at('--name'), NAME);
  assert.ok(argv.includes('--rm'), 'without --rm a stopped container is left behind');
  assert.ok(argv.includes('--init'), 'without --init an orphaned process reads as a crashed backend');
  assert.ok(!argv.some((a) => a === 'pw'), 'the admin password must not be on the command line');
});

// -- the port lookup fails AFTER a successful run --------------------------------------------

test('`docker port` failing AFTER a successful run removes the container it created', () => {
  const d = creating({ override: { port: () => failed('fake: error response from daemon') } });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    (err: Error) =>
      /could not read the published port of ci-testdb-deadbeef: fake: error response from daemon/.test(
        err.message,
      ) && /ci-testdb-deadbeef was removed/.test(err.message),
  );
  // 1 attempt + 20 retries, then give up.
  assert.equal(d.sub('port').length, 21);
  assert.deepEqual(
    d.sub('rm').map((c) => c.slice(0, 4)),
    [['rm', '-f', '-v', ID]],
  );
  assert.equal(d.containers.length, 0, 'and the daemon agrees it is gone');
  // Registered for the exit backstop first, released only once it is really gone.
  assert.deepEqual(h.events, [`created ${ID}`, `removed ${ID}`]);
});

test('an unparseable port answer also removes the container', () => {
  const d = creating({ override: { port: () => ok('no port here\n') } });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    /could not read a published port/,
  );
  assert.deepEqual(
    d.sub('rm').map((c) => c.slice(0, 4)),
    [['rm', '-f', '-v', ID]],
  );
  assert.deepEqual(h.events, [`created ${ID}`, `removed ${ID}`]);
});

test('hung `docker port` calls do not multiply: the whole lookup has a time budget', () => {
  let clock = 0;
  const d = creating({
    override: {
      port: () => {
        clock += DOCKER_QUERY_TIMEOUT_MS; // each call burns its whole timeout

        return timedOut('port');
      },
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run, now: () => clock }),
    /could not read the published port/,
  );
  // Each call burns its whole timeout, so the budget is spent after ceil(budget / timeout) calls — not after the 21st.
  assert.equal(d.sub('port').length, Math.ceil(PORT_LOOKUP_BUDGET_MS / DOCKER_QUERY_TIMEOUT_MS));
  assert.ok(d.sub('port').length < 21);
  assert.equal(d.containers.length, 0);
});

// -- THE BLOCKER: a failed verification is UNKNOWN, never "gone" -----------------------------

test('BLOCKER: `docker rm` and the verifying `docker ps` both failing is UNKNOWN — the container stays registered and the message says so', () => {
  const d = creating({
    override: {
      port: () => failed('daemon unwell'),
      rm: () => failed('Error response from daemon: timeout'),
      ps: () => failed('Cannot connect to the Docker daemon'),
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    (err: Error) =>
      /daemon unwell/.test(err.message) &&
      !/was removed/.test(err.message) &&
      /could NOT be removed/.test(err.message) &&
      /would not confirm whether it is gone/.test(err.message) &&
      /STILL BE RUNNING/.test(err.message) &&
      /docker rm -f -v ci-testdb-deadbeef/.test(err.message),
  );
  // onRemoved must NOT have fired: a caller's backstop still holds the container.
  assert.deepEqual(h.events, [`created ${ID}`]);
  // Bounded retry: exactly REMOVE_ATTEMPTS rounds of rm + verification.
  assert.equal(d.sub('rm').length, REMOVE_ATTEMPTS);
  assert.equal(d.sub('ps').length, REMOVE_ATTEMPTS);
  assert.equal(d.containers.length, 1, 'and in fact it is still running');
});

test('BLOCKER: a verification that fails once is retried; a later one that succeeds and shows it absent counts as removed', () => {
  let psCalls = 0;
  const d = creating({
    override: {
      port: () => failed('unwell'),
      rm: (_args, daemon) => {
        // The first rm is lost in transit but does remove the container; later ones fail too.
        daemon.containers.length = 0;

        return failed('Error response from daemon: timeout');
      },
      ps: (_args, daemon) =>
        ++psCalls === 1 ? failed('daemon hiccup') : ok(daemon.containers.length ? ROW : ''),
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    /ci-testdb-deadbeef was removed/,
  );
  assert.deepEqual(h.events, [`created ${ID}`, `removed ${ID}`]);
  assert.equal(d.sub('rm').length, 2, 'stopped as soon as a verification succeeded');
});

test('a removal that fails while the verification succeeds and shows it present is reported as such, with the command', () => {
  const d = creating({
    override: {
      port: () => failed('daemon unwell'),
      rm: () => failed('Error response from daemon: timeout'),
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    (err: Error) =>
      /could not be removed just now — if 'docker ps -a' still lists it, run: docker rm -f -v ci-testdb-deadbeef/.test(
        err.message,
      ) && !/would not confirm/.test(err.message),
  );
  assert.deepEqual(h.events, [`created ${ID}`], 'onRemoved never fired');
});

test('BLOCKER (result shape): `unknown` is a subset of `failed`, so a caller that only checks `failed` is safe', () => {
  const d = new FakeDaemon({
    containers: [ours(ID, NAME)],
    override: { rm: () => failed('timeout'), ps: () => failed('no daemon') },
  });
  const result = removeContainers(
    [{ id: ID, name: NAME, createdAt: 0, labels: { 'ci.test-db': '1' } }],
    d.run,
    { sleep: noSleep },
  );

  assert.deepEqual(result, { removed: [], failed: [NAME], unknown: [NAME] });
});

test('a `docker rm` that times out (status null) and then verifies absent is removed', () => {
  const d = new FakeDaemon({ override: { rm: () => timedOut('rm') } }); // model has no such container
  const result = removeContainers(
    [{ id: ID, name: NAME, createdAt: 0, labels: { 'ci.test-db': '1' } }],
    d.run,
    { sleep: noSleep },
  );

  assert.deepEqual(result, { removed: [NAME], failed: [], unknown: [] });
  assert.equal(d.sub('rm').length, 1);
});

test('"removal already in progress" is retried, and only counted once the daemon says it is gone', () => {
  let rms = 0;
  const d = new FakeDaemon({
    containers: [ours(ID, NAME)],
    override: {
      rm: (_args, daemon) => {
        if (++rms < 3) {
          return failed(`Error response from daemon: removal of container ${NAME} is already in progress`);
        }

        daemon.containers.length = 0;

        return ok();
      },
    },
  });
  const result = removeContainers(
    [{ id: ID, name: NAME, createdAt: 0, labels: { 'ci.test-db': '1' } }],
    d.run,
    { sleep: noSleep },
  );

  assert.deepEqual(result.removed, [NAME]);
  assert.equal(rms, 3);
});

test('the verification asks by exact anchored NAME plus label — an id filter matches nothing when the id is the name', () => {
  // `docker run -d` printed nothing, so the id fell back to the name. `--filter id=<name>` would
  // find no container even though it is running; the name filter does.
  const d = creating({
    override: {
      run: (_a, daemon) => {
        daemon.containers.push(ours(ID, NAME));

        return ok(''); // no id printed
      },
      port: () => failed('nope'),
      rm: () => failed('daemon unwell'),
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    /could not be removed just now/, // present -> failed, NOT falsely "was removed"
  );

  const ps = d.sub('ps')[0];

  assert.ok(ps.includes(`name=^${NAME}$`), `ps filters by anchored name: ${ps.join(' ')}`);
  assert.ok(ps.includes('label=ci.test-db=1'));
  assert.ok(!ps.some((a) => a.startsWith('id=')));
  assert.deepEqual(h.events, [`created ${NAME}`]);
});

test('removeContainers refuses a container that is not ours — all of them, before any docker call', () => {
  const d = new FakeDaemon();

  assert.throws(
    () =>
      removeContainers(
        [
          { id: 'a', name: NAME, createdAt: 0, labels: { 'ci.test-db': '1' } },
          { id: ID, name: 'ci-server-someone-elses-db', createdAt: 0, labels: {} },
        ],
        d.run,
      ),
    /refusing to remove/,
  );
  assert.equal(d.calls.length, 0, 'the ours-container listed FIRST was not removed either');
});

// -- residual leak: `docker run` itself fails after the daemon created the container --------------

test('LEAK: `docker run` killed at its time limit AFTER the daemon created the container: swept by name and removed', () => {
  const d = new FakeDaemon({
    override: {
      run: (_args, daemon) => {
        daemon.containers.push(ours(ID, NAME)); // the daemon got as far as creating it...

        return timedOut('run'); // ...and the CLI was killed before it printed the id
      },
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    (err: Error) =>
      /docker run failed: docker run timed out/.test(err.message) &&
      /docker had created ci-testdb-deadbeef before failing; it was removed/.test(err.message),
  );
  assert.equal(d.containers.length, 0, 'nothing left running');
  assert.deepEqual(
    d.sub('rm').map((c) => c.slice(0, 4)),
    [['rm', '-f', '-v', ID]],
    'removed by the id the daemon reported, after confirming name + label',
  );
  assert.deepEqual(h.events, [], 'no backstop registration needed: it is gone');
});

test('LEAK: `docker run` fails, nothing was created: swept, found nothing, removes nothing', () => {
  const d = new FakeDaemon({
    override: { run: () => failed('docker: Error response from daemon: no such image') },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    /no such image.*no ci\.test-db container named ci-testdb-deadbeef was left behind/,
  );
  assert.deepEqual(d.subcommands, ['run', 'ps'], 'one lookup, no rm');
});

test('LEAK: a name conflict with a container that LACKS the label is left completely alone', () => {
  const stranger = { id: 'a'.repeat(64), name: NAME, labels: { app: 'someone-elses' } };
  const d = new FakeDaemon({
    containers: [stranger],
    override: {
      run: () =>
        failed(`Conflict. The container name "/${NAME}" is already in use by container "${stranger.id}"`),
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    /docker run failed: Conflict.*no ci\.test-db container named ci-testdb-deadbeef was left behind/,
  );
  assert.equal(d.sub('rm').length, 0, 'never removed');
  assert.deepEqual(d.containers, [stranger], 'and still there');
  assert.deepEqual(h.events, []);
});

test('LEAK: even a daemon whose `ps` ignores its filters cannot get a label-less container removed — the rows are re-checked on our side', () => {
  const stranger = { id: 'a'.repeat(64), name: NAME, labels: { app: 'someone-elses' } };
  const d = new FakeDaemon({
    containers: [stranger],
    psIgnoresFilters: true,
    override: { run: () => failed('Conflict') },
  });

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...hooks().opts, run: d.run }),
    // Settled cleanly as "nothing of ours by that name" — not a crash caught further down.
    /Conflict.*no ci\.test-db container named ci-testdb-deadbeef was left behind/,
  );
  assert.equal(d.sub('rm').length, 0);
  assert.deepEqual(d.containers, [stranger]);
});

test('LEAK: a filter-ignoring daemon cannot get a DIFFERENT container of ours removed either, just because its name starts the same', () => {
  const near = ours('b'.repeat(64), `${NAME}2`);
  const d = new FakeDaemon({
    containers: [near],
    psIgnoresFilters: true,
    override: { run: () => failed('Conflict') },
  });

  assert.throws(() => startContainer('img', NAME, 'pw', { ...hooks().opts, run: d.run }), /was left behind/);
  assert.equal(d.sub('rm').length, 0, 'rm was never called on the neighbour');
  assert.deepEqual(d.containers, [near]);
});

test('LEAK: the sweep cannot itself tell (ps fails): reported honestly, and the caller is told to sweep again at exit', () => {
  const d = new FakeDaemon({
    override: { run: () => timedOut('run'), ps: () => failed('Cannot connect to the Docker daemon') },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    (err: Error) =>
      /could not check whether ci-testdb-deadbeef was left behind \(Cannot connect to the Docker daemon\)/.test(
        err.message,
      ) && /docker rm -f -v ci-testdb-deadbeef/.test(err.message),
  );
  assert.deepEqual(h.events, [`uncertain ${NAME}`]);
  assert.equal(d.sub('rm').length, 0, 'it did not guess');
});

test('LEAK: created (labelled) but every removal fails: still reported with the command, and registered for the exit sweep', () => {
  const d = new FakeDaemon({
    containers: [ours(ID, NAME)],
    override: { run: () => timedOut('run'), rm: () => failed('timeout') },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    /docker created ci-testdb-deadbeef before failing and it could not be removed just now — if 'docker ps -a' still lists it, run: docker rm -f -v ci-testdb-deadbeef/,
  );
  assert.deepEqual(h.events, [`uncertain ${NAME}`]);
});

test('removeOursByName: a name without our prefix is refused before any docker call', () => {
  const d = new FakeDaemon();

  assert.throws(() => removeOursByName('postgres', d.run), /refusing to sweep/);
  assert.throws(() => removeOursByName('ci-server-x-database-1', d.run), /refusing to sweep/);
  assert.equal(d.calls.length, 0);
});

test('ourContainerNamed: absent, present, and unknown are three different answers', () => {
  assert.deepEqual(ourContainerNamed(NAME, new FakeDaemon().run), { state: 'absent' });
  assert.deepEqual(ourContainerNamed(NAME, new FakeDaemon({ containers: [ours(ID, NAME)] }).run), {
    state: 'present',
    id: ID,
    label: '1',
  });
  assert.equal(
    ourContainerNamed(NAME, new FakeDaemon({ override: { ps: () => failed('down') } }).run).state,
    'unknown',
  );
  assert.equal(
    ourContainerNamed(NAME, new FakeDaemon({ override: { ps: () => timedOut('ps') } }).run).state,
    'unknown',
  );
  // Output that succeeded but cannot be read is not "absent" either.
  assert.equal(
    ourContainerNamed(NAME, new FakeDaemon({ override: { ps: () => ok('garbage without pipes\n') } }).run)
      .state,
    'unknown',
  );
});

// -- timeouts: every call on the start-up / clean-up path carries one -------------------------

test('every docker call startContainer, removeContainers and the sweep make carries a timeout', () => {
  const scenarios: Array<[string, FakeDaemon, () => unknown]> = [];
  const add = (label: string, d: FakeDaemon, fn: (d: FakeDaemon) => unknown): void => {
    scenarios.push([label, d, () => fn(d)]);
  };

  const swallow = (fn: () => unknown): void => {
    try {
      fn();
    } catch {
      // the errors are other tests' business
    }
  };

  add('success', creating(), (d) => startContainer('img', NAME, 'pw', { run: d.run, sleep: noSleep }));
  add('port fails, removal succeeds', creating({ override: { port: () => failed('x') } }), (d) =>
    swallow(() => startContainer('img', NAME, 'pw', { run: d.run, sleep: noSleep })),
  );
  add(
    'port fails, removal and verification fail',
    creating({ override: { port: () => failed('x'), rm: () => failed('x'), ps: () => failed('x') } }),
    (d) => swallow(() => startContainer('img', NAME, 'pw', { run: d.run, sleep: noSleep })),
  );
  add(
    'run fails after creating',
    new FakeDaemon({ containers: [ours(ID, NAME)], override: { run: () => timedOut('run') } }),
    (d) => swallow(() => startContainer('img', NAME, 'pw', { run: d.run, sleep: noSleep })),
  );
  add(
    'run fails, ps fails',
    new FakeDaemon({ override: { run: () => failed('x'), ps: () => failed('x') } }),
    (d) => swallow(() => startContainer('img', NAME, 'pw', { run: d.run, sleep: noSleep })),
  );

  for (const [label, d, go] of scenarios) {
    go();
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

test('the timeout constants are sane: lookups are fast, removals are bounded, and a full removal fits in minutes', () => {
  assert.ok(DOCKER_QUERY_TIMEOUT_MS >= 15_000, 'a busy machine takes seconds to answer a docker ps');
  assert.ok(DOCKER_QUERY_TIMEOUT_MS <= 30_000);
  assert.ok(DOCKER_RM_TIMEOUT_MS <= 60_000);
  assert.ok(DOCKER_RUN_TIMEOUT_MS <= 5 * 60_000);
  // Every constant is a real, finite limit — a zero or a NaN would mean "no limit" to spawnSync.
  for (const limit of [
    DOCKER_QUERY_TIMEOUT_MS,
    DOCKER_LIST_TIMEOUT_MS,
    DOCKER_PROBE_TIMEOUT_MS,
    DOCKER_SQL_TIMEOUT_MS,
    DOCKER_RM_TIMEOUT_MS,
    DOCKER_RUN_TIMEOUT_MS,
  ]) {
    assert.ok(Number.isFinite(limit) && limit > 0 && limit <= 10 * 60_000, `${limit} is not a sane limit`);
  }

  // The worst case for one removal: every attempt hangs on both rm and its verification.
  assert.ok(REMOVE_ATTEMPTS * (DOCKER_RM_TIMEOUT_MS + DOCKER_QUERY_TIMEOUT_MS) <= 3 * 60_000);
});

/** A `docker` on PATH that answers `run` at once and hangs on everything else. */
function withHungDocker<T>(body: () => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'hung-docker-'));
  const shim = path.join(dir, 'docker');

  writeFileSync(
    shim,
    ['#!/bin/sh', 'case "$1" in', `  run) echo ${ID}; exit 0 ;;`, 'esac', 'exec sleep 60', ''].join('\n'),
  );
  chmodSync(shim, 0o755);

  const before = process.env.PATH;

  process.env.PATH = `${dir}${path.delimiter}${before}`;

  try {
    return body();
  } finally {
    process.env.PATH = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a docker that accepts a call and never answers fails fast: the real spawn is killed at its timeout', () => {
  withHungDocker(() => {
    const started = Date.now();
    const res = docker(['ps'], { timeoutMs: 150 });

    assert.equal(res.status, null);
    assert.match(res.stderr, /docker ps timed out after 150 ms/);
    assert.ok(Date.now() - started < 5_000, `returned in ${Date.now() - started} ms`);
  });
});

test('a hung docker does not hang startContainer: port, rm and ps all time out, and the outcome is UNKNOWN, not "removed"', () => {
  withHungDocker(() => {
    // The real `docker()` on a real PATH shim; only the time limits are shortened, and every call is
    // checked to carry one (a call without would sleep the shim's 60 seconds, and fail this test).
    const clamped: DockerFn = (args, opts) => {
      assert.ok(opts?.timeoutMs !== undefined, `docker ${args[0]} was called without a timeout`);

      // `run` is left a real budget: it is the one call the shim answers, and a spawn can be slow on a busy machine.
      return docker(args, { ...opts, timeoutMs: args[0] === 'run' ? 10_000 : 40 });
    };

    const h = hooks();
    const started = Date.now();

    assert.throws(
      () => startContainer('img', NAME, 'pw', { ...h.opts, run: clamped }),
      (err: Error) =>
        /could not read the published port/.test(err.message) &&
        /STILL BE RUNNING/.test(err.message) &&
        !/was removed/.test(err.message),
    );
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
    assert.deepEqual(h.events, [`created ${ID}`], 'still registered for the backstop');
  });
});

// -- a failed lookup is UNKNOWN, never "absent" / "none": the image and the stale-container listing -----------

test('imageState: present, absent, and unknown are three different answers', () => {
  assert.deepEqual(imageState('img', new FakeDaemon().run, { sleep: noSleep }), { state: 'present' });
  assert.deepEqual(
    imageState(
      'img',
      new FakeDaemon({ override: { image: () => failed('Error response from daemon: No such image: img') } })
        .run,
      {
        sleep: noSleep,
      },
    ),
    { state: 'absent' },
  );
  assert.deepEqual(
    imageState(
      'img',
      new FakeDaemon({ override: { image: () => failed('Cannot connect to the Docker daemon') } }).run,
      {
        sleep: noSleep,
      },
    ),
    { state: 'unknown', detail: 'Cannot connect to the Docker daemon' },
  );
});

test('imageState: a TIMED-OUT lookup is unknown after a bounded number of asks — not "absent" (the defect seen on a loaded machine)', () => {
  const d = new FakeDaemon({ override: { image: () => timedOut('image') } });
  const slept: number[] = [];
  const seen = imageState('img', d.run, { sleep: (ms) => slept.push(ms) });

  assert.equal(seen.state, 'unknown');
  assert.equal(d.sub('image').length, IMAGE_PROBE_ATTEMPTS);
  assert.equal(slept.length, IMAGE_PROBE_ATTEMPTS - 1);
  assert.ok(
    d.calls.every((c) => typeof c.opts?.timeoutMs === 'number' && c.opts.timeoutMs > 0),
    'every ask has a timeout',
  );
});

test('imageState: one failed ask followed by a success is "present" — a hiccup is not an absence', () => {
  let asks = 0;
  const d = new FakeDaemon({
    override: { image: () => (++asks === 1 ? timedOut('image') : ok('sha256:abc\n')) },
  });

  assert.deepEqual(imageState('img', d.run, { sleep: noSleep }), { state: 'present' });
  assert.equal(asks, 2, 'stopped at the first answer');
});

test('imageState: only the daemon\'s own "No such image" (with a real exit status) says absent; a timeout that mentions it does not', () => {
  const d = new FakeDaemon({
    override: {
      image: () => ({ status: null, stdout: '', stderr: 'docker image timed out; last said: No such image' }),
    },
  });

  assert.equal(imageState('img', d.run, { sleep: noSleep }).state, 'unknown');
});

test('listOurContainers: a failed `docker ps` is a PROBLEM, not "none of ours exist"', () => {
  const d = new FakeDaemon({ override: { ps: () => failed('Cannot connect to the Docker daemon') } });
  const listing = listOurContainers(d.run);

  assert.deepEqual(listing.containers, []);
  assert.match(listing.problem ?? '', /docker ps failed: Cannot connect to the Docker daemon/);
  assert.ok(
    d.calls.every((c) => typeof c.opts?.timeoutMs === 'number'),
    'and it asked with a timeout',
  );
});

test('listOurContainers: a timed-out `docker ps` is a problem too', () => {
  const listing = listOurContainers(new FakeDaemon({ override: { ps: () => timedOut('ps') } }).run);

  assert.match(listing.problem ?? '', /docker ps failed: docker ps timed out/);
});

test('listOurContainers: nothing listed, and no failure, is honestly "none" — no problem', () => {
  assert.deepEqual(listOurContainers(new FakeDaemon({ override: { ps: () => ok('') } }).run), {
    containers: [],
  });
});

const INSPECT_LINE = `${ID}|/${NAME}|2026-09-01T00:00:00Z|{"ci.test-db":"1"}\n`;

test('listOurContainers: reads what `docker inspect` printed, and only ours', () => {
  const d = new FakeDaemon({
    override: {
      ps: () => ok(`${ID}\n${'b'.repeat(64)}\n`),
      inspect: () => ok(`${INSPECT_LINE}${'b'.repeat(64)}|/postgres|2026-09-01T00:00:00Z|{}\n`),
    },
  });
  const listing = listOurContainers(d.run);

  assert.equal(listing.problem, undefined);
  assert.deepEqual(
    listing.containers.map((c) => c.name),
    [NAME],
  );
});

test('listOurContainers: a container that vanished between the listing and the inspect is normal, not a problem', () => {
  const d = new FakeDaemon({
    override: {
      ps: () => ok(`${ID}\n${'b'.repeat(64)}\n`),
      inspect: () => ({
        status: 1,
        stdout: INSPECT_LINE,
        stderr: `Error: No such object: ${'b'.repeat(64)}`,
      }),
    },
  });
  const listing = listOurContainers(d.run);

  assert.equal(listing.problem, undefined);
  assert.equal(listing.containers.length, 1);
});

test('listOurContainers: an inspect that fails for any OTHER reason is a problem, and keeps what it could read', () => {
  const d = new FakeDaemon({
    override: {
      ps: () => ok(`${ID}\n`),
      inspect: () => ({ status: null, stdout: '', stderr: 'docker inspect timed out after 30000 ms' }),
    },
  });
  const listing = listOurContainers(d.run);

  assert.match(listing.problem ?? '', /docker inspect failed: docker inspect timed out/);
  assert.deepEqual(listing.containers, []);
});

// -- the keep window is a label, written when the container is created ---------------------------------------

const NOW_FOR_LABELS = Date.parse('2026-10-01T18:00:00Z');

/** Every `--label` value on a recorded `docker run`. */
const labelsOf = (argv: string[]): string[] => argv.filter((_, i) => argv[i - 1] === '--label');

test('--keep stamps the protection window on the container at creation; a run that is removed at its end carries no keep label', () => {
  const until = Date.parse('2026-10-02T17:37:42.123Z');
  const kept = creating();
  const plain = creating();

  startContainer('img', NAME, 'pw', { ...hooks().opts, run: kept.run, keepUntil: until });
  startContainer('img', NAME, 'pw', { ...hooks().opts, run: plain.run });

  assert.deepEqual(labelsOf(kept.sub('run')[0]), [
    `${LABEL_KEY}=${LABEL_VALUE}`,
    `${KEEP_UNTIL_LABEL_KEY}=2026-10-02T17:37:42.123Z`,
  ]);
  assert.deepEqual(labelsOf(plain.sub('run')[0]), [`${LABEL_KEY}=${LABEL_VALUE}`]);
  assert.ok(!plain.sub('run')[0].some((a) => a.includes('keep-until')));
});

test('the keep label changes nothing else about `docker run`: same flags, same order, one extra label', () => {
  const kept = creating();
  const plain = creating();

  startContainer('img', NAME, 'pw', { ...hooks().opts, run: kept.run, keepUntil: NOW_FOR_LABELS });
  startContainer('img', NAME, 'pw', { ...hooks().opts, run: plain.run });

  const withoutKeep = kept
    .sub('run')[0]
    .filter(
      (a, i, all) =>
        !a.startsWith(KEEP_UNTIL_LABEL_KEY) &&
        !(a === '--label' && all[i + 1]?.startsWith(KEEP_UNTIL_LABEL_KEY)),
    );

  assert.deepEqual(withoutKeep, plain.sub('run')[0]);
});

test('a kept container is still found by the ownership lookups: the label listing and the by-name check both see it', () => {
  const keptContainer = {
    ...ours(ID, NAME),
    createdAt: NOW_FOR_LABELS - 3 * 3_600_000,
    labels: {
      [LABEL_KEY]: LABEL_VALUE,
      [KEEP_UNTIL_LABEL_KEY]: '2026-10-02T17:37:42.123Z',
    },
  };
  const d = new FakeDaemon({ containers: [keptContainer] });
  const listing = listOurContainers(d.run);

  assert.equal(listing.problem, undefined);
  assert.deepEqual(
    listing.containers.map((c) => [c.name, c.labels[KEEP_UNTIL_LABEL_KEY]]),
    [[NAME, '2026-10-02T17:37:42.123Z']],
    'listed under label=ci.test-db=1, with the keep label readable',
  );
  assert.equal(ourContainerNamed(NAME, d.run).state, 'present');
});

// -- probeClients: counting who is connected, from inside ----------------------------------------------------

const candidate = (extra: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: ID,
  name: NAME,
  createdAt: 0,
  labels: { [LABEL_KEY]: LABEL_VALUE },
  ...extra,
});

const withClients = (clients: number, status = 'running') =>
  new FakeDaemon({ containers: [{ ...ours(ID, NAME), clients, status }] });

test('probeClients: the count is what psql prints — run by id, as the superuser, on the maintenance database, with a timeout', () => {
  const d = withClients(12);

  assert.deepEqual(probeClients(candidate(), d.run), { state: 'counted', clients: 12 });
  assert.deepEqual(d.calls[0].args, [
    'exec',
    ID,
    'psql',
    '-X',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-At',
    '-c',
    CLIENT_COUNT_SQL,
  ]);
  assert.equal(d.calls[0].opts?.timeoutMs, DOCKER_LIST_TIMEOUT_MS);
  assert.equal(d.calls.length, 1, 'one call when it works: no state lookup');
});

test('probeClients: zero is a count — idle — and not an absence of one', () => {
  assert.deepEqual(probeClients(candidate(), withClients(0).run), { state: 'counted', clients: 0 });
});

test('the count query counts client backends only, never itself, on a database that exists before bootstrap', () => {
  // Checked against the real image: a fresh container lists `client backend` (the probe's own session) next to
  // `TimescaleDB Background Worker Launcher`, the autovacuum launcher, the checkpointer and three io workers.
  // Without the type filter every container would look busy for ever; without the self-exclusion, never idle.
  assert.match(CLIENT_COUNT_SQL, /^select count\(\*\) from pg_stat_activity where /);
  assert.match(CLIENT_COUNT_SQL, /backend_type = 'client backend'/);
  assert.match(CLIENT_COUNT_SQL, /pid <> pg_backend_pid\(\)/);
  assert.doesNotMatch(CLIENT_COUNT_SQL, /datname|companion/, 'cluster-wide, not one database');
  assert.doesNotMatch(CLIENT_COUNT_SQL, /state\s*(=|<>|!=|in)/i, 'an idle-in-transaction client is a client');
});

test('probeClients: anything psql prints that is not a bare count is UNKNOWN, with what it printed', () => {
  for (const printed of ['', 'ERROR', '1 row', '-1', '3.5', '12 clients', 'count\n-----\n    3']) {
    const d = new FakeDaemon({ containers: [ours(ID, NAME)], override: { exec: () => ok(printed) } });
    const probe = probeClients(candidate(), d.run);

    assert.equal(probe.state, 'unknown', JSON.stringify(printed));
    assert.match((probe as { detail: string }).detail, /not a count/, JSON.stringify(printed));
  }

  assert.deepEqual(
    probeClients(candidate(), new FakeDaemon({ override: { exec: () => ok('  7\n') } }).run),
    { state: 'counted', clients: 7 },
    'surrounding whitespace is not a reason',
  );
});

test('probeClients: when exec fails, a container with nothing running in it has no clients; every other reason is UNKNOWN', () => {
  // The real daemon's wording for the first row was read off a created-but-never-started container.
  for (const status of ['created', 'exited', 'dead', 'removing']) {
    assert.deepEqual(probeClients(candidate(), withClients(0, status).run), { state: 'no-process' }, status);
  }

  for (const status of ['paused', 'restarting', 'running']) {
    const probe = probeClients(
      candidate(),
      status === 'running'
        ? new FakeDaemon({
            containers: [{ ...ours(ID, NAME), status }],
            override: { exec: () => failed('psql: error: the database system is starting up') },
          }).run
        : withClients(0, status).run,
    );

    assert.equal(probe.state, 'unknown', status);
    assert.match((probe as { detail: string }).detail, new RegExp(`the container is ${status}`), status);
  }
});

test('probeClients: a container that has gone by the time it is asked has no clients', () => {
  assert.deepEqual(probeClients(candidate(), new FakeDaemon().run), { state: 'no-process' });
});

test('probeClients: exec and the state lookup BOTH failing is unknown, and says both — a timeout is not an answer', () => {
  const d = new FakeDaemon({
    containers: [ours(ID, NAME)],
    override: { exec: () => timedOut('exec'), inspect: () => timedOut('inspect') },
  });
  const probe = probeClients(candidate(), d.run);

  assert.equal(probe.state, 'unknown');
  assert.match(
    (probe as { detail: string }).detail,
    /docker exec timed out.*its state could not be read either \(docker inspect timed out/,
  );
  assert.ok(
    d.calls.every((c) => typeof c.opts?.timeoutMs === 'number'),
    'both calls carry a timeout',
  );
});

test('probeClients refuses a container that is not ours, before any docker call', () => {
  for (const stranger of [
    candidate({ name: 'postgres-other' }),
    candidate({ labels: {} }),
    candidate({ name: 'ci-server-x-database-1', labels: { 'com.docker.compose.project': 'x' } }),
    // A keep label does not make a stranger ours.
    candidate({
      name: 'someone-elses',
      labels: { [LABEL_KEY]: LABEL_VALUE, [KEEP_UNTIL_LABEL_KEY]: '2099-01-01T00:00:00.000Z' },
    }),
  ]) {
    const d = withClients(3);

    assert.throws(
      () => probeClients(stranger, d.run),
      /refusing to look inside .* not a ci-testdb container/,
    );
    assert.equal(d.calls.length, 0, `${stranger.name}: nothing was asked`);
  }
});

// -- containerStatus --------------------------------------------------------------------------------------------

test('containerStatus: the daemon\'s own word; "gone" only from its own "no such object"; a timeout is unknown', () => {
  assert.deepEqual(containerStatus(candidate(), withClients(0, 'paused').run), {
    state: 'known',
    status: 'paused',
  });
  assert.deepEqual(containerStatus(candidate(), new FakeDaemon().run), { state: 'gone' });

  // Asked by id, read-only, with a timeout.
  const d = withClients(0);

  containerStatus(candidate(), d.run);
  assert.deepEqual(d.calls[0].args, ['inspect', '--format', '{{.State.Status}}', ID]);
  assert.equal(d.calls[0].opts?.timeoutMs, DOCKER_QUERY_TIMEOUT_MS);

  const timedOutMentioningIt = {
    status: null,
    stdout: '',
    stderr: 'docker inspect timed out after 20000 ms while waiting for: no such object',
  };

  assert.equal(
    containerStatus(candidate(), new FakeDaemon({ override: { inspect: () => timedOutMentioningIt } }).run)
      .state,
    'unknown',
    'a call that never finished said nothing about the container',
  );
  assert.equal(
    containerStatus(
      candidate(),
      new FakeDaemon({ override: { inspect: () => failed('Cannot connect to the Docker daemon') } }).run,
    ).state,
    'unknown',
  );
  assert.deepEqual(
    containerStatus(candidate(), new FakeDaemon({ override: { inspect: () => ok('\n') } }).run),
    {
      state: 'unknown',
      detail: 'docker inspect printed nothing',
    },
  );
});

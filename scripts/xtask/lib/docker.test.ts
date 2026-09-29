import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DOCKER_QUERY_TIMEOUT_MS,
  DOCKER_RM_TIMEOUT_MS,
  DOCKER_RUN_TIMEOUT_MS,
  PORT_LOOKUP_BUDGET_MS,
  REMOVE_ATTEMPTS,
  docker,
  ourContainerNamed,
  removeContainers,
  removeOursByName,
  startContainer,
  type CreatedContainer,
  type DockerFn,
} from './docker';
import { FakeDaemon, failed, ok, ours, timedOut, type FakeDaemonOptions } from './fakeDocker';

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
        clock += 10_000; // each call burns its whole timeout

        return timedOut('port');
      },
    },
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run, now: () => clock }),
    /could not read the published port/,
  );
  // 10 s per call against a 30 s budget: the third call exhausts it, not the 21st.
  assert.equal(PORT_LOOKUP_BUDGET_MS, 30_000);
  assert.equal(d.sub('port').length, 3);
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
  assert.ok(DOCKER_QUERY_TIMEOUT_MS <= 15_000);
  assert.ok(DOCKER_RM_TIMEOUT_MS <= 60_000);
  assert.ok(DOCKER_RUN_TIMEOUT_MS <= 5 * 60_000);
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

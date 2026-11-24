/**
 * `xtask test-db`, the real command, end to end against stand-ins for `docker`
 * and `yarn` on PATH — enough of each to walk the whole flow up to the moment
 * jest is running, then a signal arrives. A second stand-in, a docker that
 * accepts every call and never answers, proves the command does not hang on it.
 *
 * What is being proved is what a person relies on when they close a terminal or
 * `kill` a run: the signal is forwarded to jest, the container is removed, this
 * run's temp directory goes with it, the summary is still printed, and the exit
 * is nonzero. SIGHUP has to do exactly what SIGTERM does — before it was handled,
 * the process simply died on it with the container still running.
 *
 * The stand-in docker keeps one "container" as a file; nothing here touches a
 * real Docker daemon.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { DEFAULT_KEEP_FOR_MS } from '../lib/testDb';

const REPO = process.cwd();

/*
 * Budgets. These are LOAD-SHAPED limits, not expectations: on a healthy machine the command is at
 * jest in seconds. On a shared one, starting `tsx` and a dozen shell stand-ins has been measured at
 * many minutes, and a limit that tight reads as a bug in the command. A child that DIES early is
 * still reported at once (see `waitFor`'s `abortIf`) — the budget is only ever spent on a child that
 * is alive and slow.
 */
const START_BUDGET_MS = 15 * 60_000;
const EXIT_BUDGET_MS = 5 * 60_000;

const DOCKER_SHIM = `#!/bin/sh
echo "docker $*" >> "$SHIM_LOG"
case "$1" in
  version) echo 27.0.0 ;;
  image) exit 0 ;;
  run)
    name=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--name" ]; then name="$a"; fi
      prev="$a"
    done
    id="aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111"
    echo "$id|$name|1" > "$SHIM_STATE/container"
    echo "$id" ;;
  ps)
    case "$*" in
      *--format*) [ -f "$SHIM_STATE/container" ] && cat "$SHIM_STATE/container" ;;
    esac
    exit 0 ;;
  port) echo "127.0.0.1:55555" ;;
  inspect) echo true ;;
  exec)
    case "$*" in
      *pg_isready*) exit 0 ;;
      *"SELECT version()"*) echo "PostgreSQL 18.0 on the-stand-in" ;;
      *timescaledb*) echo "2.99.0" ;;
      *schema_migrations*) echo "1" ;;
      *) cat > /dev/null ;;
    esac ;;
  rm) rm -f "$SHIM_STATE/container" ;;
esac
exit 0
`;

const YARN_SHIM = `#!/bin/sh
echo "yarn $*" >> "$SHIM_LOG"
case "$*" in
  *jest*)
    # A worker the "wrapper" never signals itself, as yarn never signals jest's.
    sleep 300 >/dev/null 2>&1 &
    echo $! > "$SHIM_STATE/worker.pid"
    touch "$SHIM_STATE/jest-started"
    trap 'echo jest-got-signal >> "$SHIM_LOG"; exit 130' HUP TERM INT
    i=0
    while [ $i -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
    exit 1 ;;
esac
exit 0
`;

/** Poll until `condition` holds. `abortIf` returns a reason to give up early (the child died); the budget is for a child that is alive and slow. */
async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs: number,
  abortIf?: () => string | undefined,
): Promise<void> {
  const started = Date.now();

  while (!condition()) {
    const reason = abortIf?.();

    if (reason !== undefined) {
      throw new Error(`gave up waiting for ${what}: ${reason}`);
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A scratch world for one run of the command: stand-ins on PATH, a log they append to, a private TMPDIR. */
function scratchWorld(shims: Record<string, string>, args: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-db-signal-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  const tmp = path.join(dir, 'tmp');
  const log = path.join(dir, 'calls.log');

  for (const d of [bin, state, tmp]) {
    fs.mkdirSync(d);
  }

  for (const [name, body] of Object.entries(shims)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }

  fs.writeFileSync(log, '');

  const child = spawn(process.execPath, [...process.execArgv, 'scripts/xtask/index.ts', 'test-db', ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHIM_LOG: log,
      SHIM_STATE: state,
      TMPDIR: tmp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '' };
  const gone: { code: number | null | undefined } = { code: undefined };

  child.stdout.on('data', (c: Buffer) => (out.text += c.toString()));
  child.stderr.on('data', (c: Buffer) => (out.text += c.toString()));

  const exited = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      gone.code = code;
      resolve(code);
    }),
  );

  return {
    dir,
    state,
    tmp,
    log,
    child,
    out,
    exited,
    /** A reason to stop waiting, once the command has ended. */
    endedEarly: (): string | undefined =>
      gone.code === undefined ? undefined : `the command exited (${gone.code}) first:\n${out.text}`,
    cleanup: (): void => {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function interruptedRun(signal: NodeJS.Signals): Promise<{
  code: number | null;
  output: string;
  log: string;
  containerLeft: boolean;
  tempLeft: string[];
  workerAlive: boolean;
}> {
  const world = scratchWorld({ docker: DOCKER_SHIM, yarn: YARN_SHIM });

  try {
    await waitFor(
      () => fs.existsSync(path.join(world.state, 'jest-started')),
      'jest to start',
      START_BUDGET_MS,
      world.endedEarly,
    );
    world.child.kill(signal);

    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`did not exit within ${EXIT_BUDGET_MS} ms of ${signal}\n${world.out.text}`)),
        EXIT_BUDGET_MS,
      );
    });
    const code = await Promise.race([world.exited, tooSlow]).finally(() => clearTimeout(timer));

    // The worker must not outlive the run: a signal that reached only the wrapper would leave it running.
    const workerPid = Number(fs.readFileSync(path.join(world.state, 'worker.pid'), 'utf8').trim());

    assert.ok(workerPid > 0, 'the stand-in wrote its worker pid before signalling that jest had started');
    const alive = (): boolean => {
      try {
        process.kill(workerPid, 0);

        return true;
      } catch {
        return false;
      }
    };

    await waitFor(() => !alive(), 'the jest worker to die', 30_000).catch(() => undefined);

    const workerAlive = alive();

    if (workerAlive) {
      process.kill(workerPid, 'SIGKILL');
    }

    return {
      workerAlive,
      code,
      output: world.out.text,
      log: fs.readFileSync(world.log, 'utf8'),
      containerLeft: fs.existsSync(path.join(world.state, 'container')),
      tempLeft: fs.readdirSync(world.tmp).filter((n) => n.startsWith('ci-test-db-')),
    };
  } finally {
    world.cleanup();
  }
}

describe('an interrupted run cleans up, whichever signal it was', { concurrency: true }, () => {
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
    test(`${signal}: forwarded to jest, container removed, temp directory removed, summary printed, exit nonzero`, async () => {
      const r = await interruptedRun(signal);

      assert.notEqual(r.code, 0, `exit code ${r.code}\n${r.output}`);
      assert.match(r.log, /jest-got-signal/, 'the signal reached jest');
      assert.match(
        r.log,
        /docker rm -f -v a{8}b{8}c{8}d{8}e{8}f{8}0{8}1{8}/,
        'the container was removed by id',
      );
      assert.equal(r.containerLeft, false, 'and the (stand-in) daemon agrees');

      // A background job of a non-interactive sh ignores SIGINT (POSIX), so only the wrapper is judged for that one.
      if (signal !== 'SIGINT') {
        assert.equal(r.workerAlive, false, "jest's worker was signalled too, not orphaned");
      }

      assert.deepEqual(r.tempLeft, [], "this run's ci-test-db-* directory is gone");
      assert.match(r.output, /test-db summary/);
      assert.match(r.output, /container\s+│ ci-testdb-[0-9a-f]{8}: removed/);
      assert.match(r.output, /test-db was interrupted/);
    });
  }
});

// A daemon that accepts a call and never answers it (`docker version` included) is what a wedged Docker Desktop
// looks like. Without a time limit on that first call the command would sit there for ever; with it, it reports
// what it knows and ends, having created nothing.
const HUNG_DOCKER_SHIM = `#!/bin/sh
echo "docker $*" >> "$SHIM_LOG"
touch "$SHIM_STATE/docker-called"
exec sleep 900
`;

describe('a docker that never answers', { concurrency: true }, () => {
  test('cannot hang the command: it gives up on the first call at its time limit, says so, creates nothing, and exits nonzero', async () => {
    const world = scratchWorld({ docker: HUNG_DOCKER_SHIM });

    try {
      // The clock starts at the first docker call, not at the command's (slow, on a loaded machine) start-up.
      await waitFor(
        () => fs.existsSync(path.join(world.state, 'docker-called')),
        'the command to reach its first docker call',
        START_BUDGET_MS,
        world.endedEarly,
      );

      const calledAt = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const stillHung = new Promise<never>((_, reject) => {
        // The shim sleeps 15 minutes: an answer inside this window can only be the command's own time limit.
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the command was still waiting on docker after ${EXIT_BUDGET_MS} ms\n${world.out.text}`,
              ),
            ),
          EXIT_BUDGET_MS,
        );
      });
      const code = await Promise.race([world.exited, stillHung]).finally(() => clearTimeout(timer));

      assert.notEqual(code, 0, world.out.text);
      assert.ok(Date.now() - calledAt < EXIT_BUDGET_MS);
      assert.match(world.out.text, /Docker is not reachable \(docker version timed out after \d+ ms\)/);

      const calls = fs.readFileSync(world.log, 'utf8').trim().split('\n');

      assert.deepEqual(
        calls,
        ['docker version --format {{.Server.Version}}'],
        'it asked once, and nothing after',
      );
      assert.deepEqual(
        fs.readdirSync(world.tmp).filter((n) => n.startsWith('ci-test-db-')),
        [],
        "this run's temp directory is gone",
      );
    } finally {
      world.cleanup();
    }
  });
});

// `docker image inspect` failing for a reason that is not "no such image" (the daemon unreachable, a time-out on
// a loaded machine) used to read as "the image is absent": the command then chose another image, or ran a
// `docker pull` for an image that only exists locally and reported "pull access denied" — a message about the wrong
// problem. Not knowing is now an error that says so, and nothing is pulled or started on a guess.
const IMAGE_LOOKUP_FAILS_SHIM = `#!/bin/sh
echo "docker $*" >> "$SHIM_LOG"
case "$1" in
  version) echo 27.0.0 ;;
  image) echo "Cannot connect to the Docker daemon at unix:///nowhere.sock" >&2; exit 1 ;;
  pull) echo "pull access denied for ci/database" >&2; exit 1 ;;
esac
exit 0
`;

describe('a docker that cannot answer whether an image exists', { concurrency: true }, () => {
  test('is an error that says so — never read as "absent": nothing is pulled and nothing is started', async () => {
    const world = scratchWorld({ docker: IMAGE_LOOKUP_FAILS_SHIM });

    try {
      let timer: NodeJS.Timeout | undefined;
      const tooSlow = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`did not exit within ${START_BUDGET_MS} ms\n${world.out.text}`)),
          START_BUDGET_MS,
        );
      });
      const code = await Promise.race([world.exited, tooSlow]).finally(() => clearTimeout(timer));
      const calls = fs.readFileSync(world.log, 'utf8');

      assert.notEqual(code, 0, world.out.text);
      assert.match(
        world.out.text,
        /could not tell whether the image ci\/database:latest is present locally \(Cannot connect to the Docker daemon/,
      );
      assert.doesNotMatch(world.out.text, /Pulling/);
      assert.doesNotMatch(calls, /^docker (pull|run)\b/m, 'no pull, no run');
      assert.deepEqual(
        fs.readdirSync(world.tmp).filter((n) => n.startsWith('ci-test-db-')),
        [],
        "this run's temp directory is gone",
      );
    } finally {
      world.cleanup();
    }
  });
});

// A run that goes all the way: the window the stale-container reaper honours is a LABEL, stamped on the
// container when the command creates it, so the only way to know `--keep-for` reaches the container is to run
// the command and read what it asked docker for. (The pieces are unit-tested; this is the wiring between them.)
const YARN_COMPLETING_SHIM = `#!/bin/sh
echo "yarn $*" >> "$SHIM_LOG"
case "$*" in
  *jest*)
    for a in "$@"; do
      case "$a" in --outputFile=*) out="\${a#--outputFile=}" ;; esac
    done
    echo '{"success":true,"numTotalTestSuites":1,"numFailedTestSuites":0,"numPendingTestSuites":0,"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"numPendingTests":0,"numTodoTests":0,"testResults":[{"name":"/x/backend/apps/api/src/a.spec.ts","status":"passed","assertionResults":[{"status":"passed","title":"t","fullName":"t"}]}]}' > "$out" ;;
esac
exit 0
`;

async function completedRun(args: string[], dockerShim: string = DOCKER_SHIM) {
  const startedAt = Date.now();
  const world = scratchWorld({ docker: dockerShim, yarn: YARN_COMPLETING_SHIM }, args);

  try {
    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`did not finish within ${START_BUDGET_MS} ms\n${world.out.text}`)),
        START_BUDGET_MS,
      );
    });
    const code = await Promise.race([world.exited, tooSlow]).finally(() => clearTimeout(timer));
    const log = fs.readFileSync(world.log, 'utf8');

    return {
      code,
      startedAt,
      endedAt: Date.now(),
      output: world.out.text,
      log,
      runLine: log.split('\n').find((l) => l.startsWith('docker run ')) ?? '',
      containerLeft: fs.existsSync(path.join(world.state, 'container')),
    };
  } finally {
    world.cleanup();
  }
}

/** The instant the `docker run` stamped as `ci.test-db.keep-until`, or undefined when it did not. */
const keepLabel = (runLine: string): number | undefined => {
  const value = /--label ci\.test-db\.keep-until=(\S+)/.exec(runLine)?.[1];

  return value === undefined ? undefined : Date.parse(value);
};

describe('the keep window reaches the container the command creates', { concurrency: true }, () => {
  test('--keep-for 3h: the container is labelled to be left alone for 3h from its creation, kept, and the notice says the same instant', async () => {
    const r = await completedRun(['--keep-for', '3h']);
    const until = keepLabel(r.runLine);

    assert.equal(r.code, 0, r.output);
    assert.ok(until !== undefined, `no keep-until label on: ${r.runLine}`);
    assert.ok(
      until >= r.startedAt + 3 * 3_600_000 && until <= r.endedAt + 3 * 3_600_000,
      `the window is 3h from when the container was made: ${new Date(until).toISOString()}`,
    );
    assert.match(r.runLine, /--label ci\.test-db=1 /, 'still labelled as ours, first');
    assert.doesNotMatch(r.log, /^docker rm /m, 'kept: nothing removed it');
    assert.equal(r.containerLeft, true, 'and the (stand-in) daemon still has it');
    // "3h from now" if the run took under a minute; a slow machine may have eaten into it, so only the instant is exact.
    assert.match(
      r.output,
      new RegExp(
        `protected until: {4}${new Date(until).toISOString().replace(/\./g, '\\.')} \\((3h|2h \\d\\dm) from now\\)`,
      ),
    );
    assert.match(r.output, /docker rename ci-testdb-[0-9a-f]{8} <new name>/);
    assert.doesNotMatch(r.output, /two hours|removes it anyway/i);
    assert.match(r.output, /container\s+│ ci-testdb-[0-9a-f]{8}: kept/);
  });

  test('--keep alone: the default window', async () => {
    const r = await completedRun(['--keep']);
    const until = keepLabel(r.runLine);

    assert.equal(r.code, 0, r.output);
    assert.ok(until !== undefined, `no keep-until label on: ${r.runLine}`);
    assert.ok(
      until >= r.startedAt + DEFAULT_KEEP_FOR_MS && until <= r.endedAt + DEFAULT_KEEP_FOR_MS,
      new Date(until).toISOString(),
    );
    assert.match(r.output, /\((24h|23h \d\dm) from now\)/);
    assert.equal(r.containerLeft, true);
  });

  test('no --keep: no keep label at all, and the container is removed when the run ends', async () => {
    const r = await completedRun([]);

    assert.equal(r.code, 0, r.output);
    assert.ok(r.runLine.startsWith('docker run '), 'it did start a container');
    assert.equal(keepLabel(r.runLine), undefined);
    assert.doesNotMatch(r.runLine, /keep-until/);
    assert.match(r.log, /^docker rm -f -v a{8}b{8}c{8}d{8}e{8}f{8}0{8}1{8}$/m);
    assert.equal(r.containerLeft, false);
    assert.doesNotMatch(r.output, /protected until/);
    assert.match(r.output, /container\s+│ ci-testdb-[0-9a-f]{8}: removed/);
  });

  test('the reaper runs first, before this run has a container of its own to be mistaken for stale', async () => {
    const r = await completedRun([]);
    const calls = r.log.split('\n');
    const listed = calls.findIndex((l) =>
      l.startsWith('docker ps -a -q --no-trunc --filter label=ci.test-db=1'),
    );
    const created = calls.findIndex((l) => l.startsWith('docker run '));

    assert.ok(listed !== -1, `the listing of our containers was never asked for:\n${r.log}`);
    assert.ok(created !== -1 && listed < created, 'and it was asked for before docker run');
    assert.match(r.output, /No stale test databases to reap/);
  });
});

// The incident, through the real command: a database another session is running jest against, just past the
// two-hour mark, with 12 clients connected. The stand-in daemon lists it, says it was created two hours and a
// minute ago, and answers the client count; everything else is the usual stand-in.
const STALE_ID = '5'.repeat(64);

function staleDockerShim(opts: { name: string; createdIso: string; clients: number }): string {
  return `#!/bin/sh
echo "docker $*" >> "$SHIM_LOG"
case "$1" in
  ps)
    case "$*" in
      *" -q "*) echo "${STALE_ID}"; exit 0 ;;   # the listing is ps -a -q; the by-name check has no -q
    esac ;;
  inspect)
    case "$*" in
      *"{{.Id}}|{{.Name}}"*) echo '${STALE_ID}|/${opts.name}|${opts.createdIso}|{"ci.test-db":"1"}'; exit 0 ;;
    esac ;;
  exec)
    case "$*" in
      *"from pg_stat_activity"*) echo ${opts.clients}; exit 0 ;;
    esac ;;
esac
${DOCKER_SHIM.split('\n').slice(2).join('\n')}`;
}

describe('the reaper, in the real command', { concurrency: true }, () => {
  const createdIso = (ageMs: number): string => new Date(Date.now() - ageMs).toISOString();

  test('INCIDENT: a 2h01m-old database with 12 clients is left alone and named, and this run still goes ahead', async () => {
    const r = await completedRun(
      [],
      staleDockerShim({
        name: 'ci-testdb-42b8deef',
        createdIso: createdIso((2 * 60 + 1) * 60_000),
        clients: 12,
      }),
    );

    assert.equal(r.code, 0, r.output);
    assert.match(
      r.output,
      /NOT removing ci-testdb-42b8deef \(2h 01m old\): 12 client connections open on it, so it is in use\. Rename it .*docker rename ci-testdb-42b8deef <new name>/,
    );
    assert.match(
      r.log,
      new RegExp(`^docker exec ${STALE_ID} psql .*from pg_stat_activity`, 'm'),
      'it was asked, by id',
    );
    assert.doesNotMatch(r.log, new RegExp(`^docker rm .*${STALE_ID}`, 'm'), 'and never removed');
    assert.match(
      r.log,
      /^docker rm -f -v a{8}b{8}c{8}d{8}e{8}f{8}0{8}1{8}$/m,
      "this run's own container was removed as usual",
    );
    assert.doesNotMatch(
      r.output,
      /No stale test databases to reap/,
      'no tick for a check that found something',
    );
  });

  test('the same container with nothing connected is removed — by id, once', async () => {
    const r = await completedRun(
      [],
      staleDockerShim({
        name: 'ci-testdb-42b8deef',
        createdIso: createdIso((2 * 60 + 1) * 60_000),
        clients: 0,
      }),
    );

    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Removed 1 stale test database container\(s\) older than 2h .*ci-testdb-42b8deef/);
    assert.doesNotMatch(r.output, /NOT removing/);
    assert.equal(r.log.split('\n').filter((l) => l === `docker rm -f -v ${STALE_ID}`).length, 1);
  });

  test('a database younger than two hours is neither asked about nor removed, whatever is connected to it', async () => {
    const r = await completedRun(
      [],
      staleDockerShim({ name: 'ci-testdb-42b8deef', createdIso: createdIso(90 * 60_000), clients: 0 }),
    );

    assert.equal(r.code, 0, r.output);
    assert.doesNotMatch(r.log, new RegExp(`^docker (exec|rm) .*${STALE_ID}`, 'm'));
    assert.match(r.output, /No stale test databases to reap/);
  });
});

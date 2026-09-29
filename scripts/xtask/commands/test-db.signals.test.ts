/**
 * `xtask test-db`, the real command, end to end against stand-ins for `docker`
 * and `yarn` on PATH — enough of each to walk the whole flow up to the moment
 * jest is running, then a signal arrives.
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

const REPO = process.cwd();

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

async function waitFor(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function interruptedRun(signal: NodeJS.Signals): Promise<{
  code: number | null;
  output: string;
  log: string;
  containerLeft: boolean;
  tempLeft: string[];
  workerAlive: boolean;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-db-signal-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  const tmp = path.join(dir, 'tmp');
  const log = path.join(dir, 'calls.log');

  for (const d of [bin, state, tmp]) {
    fs.mkdirSync(d);
  }

  for (const [name, body] of [
    ['docker', DOCKER_SHIM],
    ['yarn', YARN_SHIM],
  ]) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }

  fs.writeFileSync(log, '');

  const child = spawn(process.execPath, [...process.execArgv, 'scripts/xtask/index.ts', 'test-db'], {
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
  let output = '';

  child.stdout.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr.on('data', (c: Buffer) => (output += c.toString()));

  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));

  try {
    await waitFor(() => fs.existsSync(path.join(state, 'jest-started')), 'jest to start', 90_000);
    child.kill(signal);

    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not exit after ${signal}\n${output}`)), 60_000);
    });
    const code = await Promise.race([exited, tooSlow]).finally(() => clearTimeout(timer));

    // The worker must not outlive the run: a signal that reached only the wrapper would leave it running.
    const workerPid = Number(fs.readFileSync(path.join(state, 'worker.pid'), 'utf8').trim());

    assert.ok(workerPid > 0, 'the stand-in wrote its worker pid before signalling that jest had started');
    const alive = (): boolean => {
      try {
        process.kill(workerPid, 0);

        return true;
      } catch {
        return false;
      }
    };

    await waitFor(() => !alive(), 'the jest worker to die', 5_000).catch(() => undefined);

    const workerAlive = alive();

    if (workerAlive) {
      process.kill(workerPid, 'SIGKILL');
    }

    return {
      workerAlive,
      code,
      output,
      log: fs.readFileSync(log, 'utf8'),
      containerLeft: fs.existsSync(path.join(state, 'container')),
      tempLeft: fs.readdirSync(tmp).filter((n) => n.startsWith('ci-test-db-')),
    };
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
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

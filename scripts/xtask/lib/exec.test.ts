import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  TERMINATION_SIGNALS,
  ignoreDeadTerminal,
  reapGroup,
  runAsync,
  runAsyncOrThrow,
  underTsxRelay,
} from './exec';

test('the termination signals are Ctrl-C, kill, and the terminal going away', () => {
  assert.deepEqual([...TERMINATION_SIGNALS].sort(), ['SIGHUP', 'SIGINT', 'SIGTERM']);
});

async function until(condition: () => boolean, what: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();

  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A pid another process wrote to `file`. The file can exist before its contents do, so wait for a number, never read `Number('')` (0 — our own process group). */
async function readPid(file: string, what: string): Promise<number> {
  await until(() => fs.existsSync(file) && /^\d+$/.test(fs.readFileSync(file, 'utf8').trim()), what);

  return Number(fs.readFileSync(file, 'utf8').trim());
}

// runAsync attaches its listener to THIS process before the child starts, so signalling ourselves while it
// runs is how a real signal would arrive. A listener of our own keeps the test runner alive even if runAsync
// forgot to handle the signal — a regression must FAIL this test, not kill or hang the runner.
for (const [signal, exitCode] of [
  ['SIGHUP', 41],
  ['SIGTERM', 42],
  ['SIGINT', 43],
] as const) {
  test(`runAsync forwards ${signal} to its child, and reports the run as interrupted`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runasync-signal-'));
    const ready = path.join(dir, 'ready');
    const child = [
      `process.on(${JSON.stringify(signal)}, () => process.exit(${exitCode}));`,
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1');`,
      // Ends by itself if the signal never comes, so a failure leaves nothing behind.
      'setTimeout(() => process.exit(99), 120000);',
    ].join('\n');
    const survive = (): void => undefined;

    process.on(signal, survive);

    try {
      const running = runAsync(process.execPath, ['-e', child], { killAfterMs: 30_000 });

      await until(() => fs.existsSync(ready), 'the child to install its handler');
      process.kill(process.pid, signal);

      const res = await running;

      assert.equal(
        res.status,
        exitCode,
        `the child should have received ${signal} (exit ${exitCode}), not run out its clock (exit 99)`,
      );
      assert.equal(res.interrupted, true);
    } finally {
      process.off(signal, survive);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('runAsync removes its listeners when the child ends, so a later signal is not swallowed by a finished run', async () => {
  const before = TERMINATION_SIGNALS.map((s) => process.listenerCount(s));
  const res = await runAsync(process.execPath, ['-e', '0']);

  assert.equal(res.status, 0);
  assert.equal(res.interrupted, false);
  assert.deepEqual(
    TERMINATION_SIGNALS.map((s) => process.listenerCount(s)),
    before,
  );
});

// `yarn workspace … jest` is a wrapper: it does not pass SIGHUP on (it dies of it and orphans jest and its workers),
// and it ignores SIGINT outright, expecting a terminal to have delivered Ctrl-C to the whole process group. Forwarding
// a signal to the wrapper alone therefore leaves the real work running. `group: true` signals the whole tree.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
  test(`runAsync with group: true takes a wrapper's whole process tree down on ${signal}, not just the wrapper`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runasync-group-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    // The wrapper: starts the real work and does nothing about signals itself — which is what yarn does for
    // SIGHUP (default action: die) and SIGINT (ignore).
    const wrapper = [
      "const { spawn } = require('node:child_process');",
      "const work = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(work.pid));`,
      signal === 'SIGINT' ? "process.on('SIGINT', () => {});" : '',
      'setTimeout(() => process.exit(0), 120000);',
    ].join('\n');
    const survive = (): void => undefined;
    let grandchild = 0;

    process.on(signal, survive);

    try {
      const running = runAsync(process.execPath, ['-e', wrapper], { group: true, killAfterMs: 1500 });

      grandchild = await readPid(pidFile, 'the wrapper to start its work');
      assert.ok(pidAlive(grandchild), 'the real work is running');
      process.kill(process.pid, signal);

      const res = await running;

      assert.equal(res.interrupted, true);

      // The wrapper's tree — including the work it never forwarded anything to — must be gone.
      await until(
        () => !pidAlive(grandchild),
        `the wrapped process ${grandchild} to die after ${signal}`,
        30_000,
      );
    } finally {
      process.off(signal, survive);

      if (grandchild > 0 && pidAlive(grandchild)) {
        process.kill(grandchild, 'SIGKILL');
      }

      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('without group: true the same wrapper leaves its work behind — which is the defect group: true exists to fix', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runasync-nogroup-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const wrapper = [
    "const { spawn } = require('node:child_process');",
    "const work = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(work.pid));`,
    'setTimeout(() => process.exit(0), 120000);',
  ].join('\n');
  const survive = (): void => undefined;
  let grandchild = 0;

  process.on('SIGHUP', survive);

  try {
    const running = runAsync(process.execPath, ['-e', wrapper], { killAfterMs: 1500 });

    grandchild = await readPid(pidFile, 'the wrapper to start its work');
    process.kill(process.pid, 'SIGHUP');
    await running;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(pidAlive(grandchild), 'orphaned, still running');
  } finally {
    process.off('SIGHUP', survive);

    if (grandchild > 0 && pidAlive(grandchild)) {
      process.kill(grandchild, 'SIGKILL');
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// jest-worker restarts a worker that dies with a non-zero status. So when a group signal kills a worker a moment
// before it kills jest itself, jest forks a REPLACEMENT into the same group — after the signal was sent — and then
// dies. Nobody signals the replacement, and it is reparented to init. Reproduced here: the wrapper answers the
// signal by forking a straggler and exiting.
test('runAsync with group: true also reaps a straggler forked into the group after the signal went out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runasync-straggler-'));
  const ready = path.join(dir, 'ready');
  const stragglerFile = path.join(dir, 'straggler.pid');
  const wrapper = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "process.on('SIGHUP', () => {",
    "  const straggler = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });",
    `  fs.writeFileSync(${JSON.stringify(stragglerFile)}, String(straggler.pid));`,
    '  process.exit(0);',
    '});',
    `fs.writeFileSync(${JSON.stringify(ready)}, '1');`,
    'setTimeout(() => process.exit(99), 120000);',
  ].join('\n');
  const survive = (): void => undefined;
  let straggler = 0;

  process.on('SIGHUP', survive);

  try {
    const running = runAsync(process.execPath, ['-e', wrapper], { group: true, killAfterMs: 30_000 });

    await until(() => fs.existsSync(ready), 'the wrapper to install its handler');
    process.kill(process.pid, 'SIGHUP');

    const res = await running;

    assert.equal(res.interrupted, true);
    assert.equal(res.status, 0, 'the wrapper answered the signal itself');
    straggler = await readPid(stragglerFile, 'the straggler to have been forked');
    await until(() => !pidAlive(straggler), `the straggler ${straggler} to be reaped`, 30_000);
  } finally {
    process.off('SIGHUP', survive);

    if (straggler > 0 && pidAlive(straggler)) {
      process.kill(straggler, 'SIGKILL');
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reapGroup keeps killing until the group is empty, and stops when kill says ESRCH', async () => {
  const calls: Array<[number, string]> = [];
  const rounds = await reapGroup(4242, {
    delayMs: 1,
    kill: (pid, signal) => {
      calls.push([pid, signal]);

      if (calls.length === 3) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
    },
  });

  assert.equal(rounds, 3);
  assert.deepEqual(calls, [
    [-4242, 'SIGKILL'],
    [-4242, 'SIGKILL'],
    [-4242, 'SIGKILL'],
  ]);
});

test('reapGroup is bounded: a group that never empties (a zombie nobody reaps) does not loop for ever', async () => {
  let kills = 0;
  const rounds = await reapGroup(4242, { attempts: 5, delayMs: 1, kill: () => void (kills += 1) });

  assert.equal(rounds, 5);
  assert.equal(kills, 5);
});

test('reapGroup on a group that is already gone returns after one look', async () => {
  let kills = 0;
  const rounds = await reapGroup(4242, {
    delayMs: 1,
    kill: () => {
      kills += 1;
      throw new Error('ESRCH');
    },
  });

  assert.equal(rounds, 1);
  assert.equal(kills, 1);
});

const eio = (): NodeJS.ErrnoException => Object.assign(new Error('write EIO'), { code: 'EIO' });

// Fresh emitters, not process.stdout: the test runner reports its results over the real one.
test('ignoreDeadTerminal: an EIO on stdout or stderr (the terminal is gone) is dropped, not thrown', () => {
  const out = new EventEmitter();
  const err = new EventEmitter();

  // Without a listener, emitting 'error' throws — which is exactly the uncaught exception that killed the process.
  assert.throws(() => out.emit('error', eio()), /write EIO/);

  const undo = ignoreDeadTerminal([out, err]);

  try {
    assert.doesNotThrow(() => out.emit('error', eio()));
    assert.doesNotThrow(() => err.emit('error', eio()));
  } finally {
    undo();
  }

  assert.throws(() => err.emit('error', eio()), /write EIO/, 'and undone');
});

test('ignoreDeadTerminal leaves every other stream error alone', () => {
  const out = new EventEmitter();
  const undo = ignoreDeadTerminal([out]);

  try {
    assert.throws(
      () => out.emit('error', Object.assign(new Error('disk full'), { code: 'ENOSPC' })),
      /disk full/,
    );
  } finally {
    undo();
  }
});

test('ignoreDeadTerminal by default guards the real stdout and stderr, and undoes itself', () => {
  const before = [process.stdout.listenerCount('error'), process.stderr.listenerCount('error')];
  const undo = ignoreDeadTerminal();

  assert.deepEqual(
    [process.stdout.listenerCount('error'), process.stderr.listenerCount('error')],
    [before[0] + 1, before[1] + 1],
  );
  undo();
  assert.deepEqual([process.stdout.listenerCount('error'), process.stderr.listenerCount('error')], before);
});

// -- timeoutMs: a child that never finishes is stopped, and that is not an "interruption" -------------------------
//
// The children are `sh`, not node: the limit's clock starts when the child is spawned, and a node child on a
// loaded machine can take longer than a short limit just to start — which would make these tests race their own
// handlers. `sh` is up in milliseconds.

test('runAsync with timeoutMs stops a child that never finishes, and reports timedOut — not interrupted', async () => {
  const started = Date.now();
  const res = await runAsync('sh', ['-c', 'exec sleep 120'], { timeoutMs: 300, killAfterMs: 30_000 });

  assert.equal(res.timedOut, true);
  assert.equal(res.interrupted, false, 'nobody signalled us: this is a time limit, not a Ctrl-C');
  assert.notEqual(res.status, 0);
  assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started} ms`);
});

test('runAsync with timeoutMs SIGKILLs a child that ignores the polite signal', async () => {
  // The limit is not tiny: the trap has to be installed before the SIGTERM arrives, or the child simply dies of it.
  // The loop ends by itself after two minutes, so a regression (a limit that is never enforced) FAILS this test
  // instead of hanging the runner for ever.
  const res = await runAsync(
    'sh',
    ['-c', 'trap "" TERM; i=0; while [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done'],
    {
      timeoutMs: 5_000,
      killAfterMs: 300,
    },
  );

  assert.equal(res.timedOut, true);
  assert.equal(res.signal, 'SIGKILL', 'SIGTERM was ignored, so it took the SIGKILL that follows');
});

test('runAsync with timeoutMs and group takes the whole tree down, wrapper and worker alike', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runasync-timeout-'));
  const workerPidFile = path.join(dir, 'worker.pid');

  try {
    // A "wrapper" that starts a long-lived worker and waits for it: the shape of `yarn … jest`.
    const running = runAsync('sh', ['-c', `sleep 300 & echo $! > ${JSON.stringify(workerPidFile)}; wait`], {
      group: true,
      timeoutMs: 8_000,
      killAfterMs: 5_000,
    });
    const workerPid = await readPid(workerPidFile, "the wrapper's worker pid");

    assert.equal(pidAlive(workerPid), true);

    const res = await running;

    assert.equal(res.timedOut, true);
    await until(() => !pidAlive(workerPid), "the worker to die with the wrapper's group");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runAsync without timeoutMs never reports timedOut, and a finished child leaves no timer behind', async () => {
  const res = await runAsync('sh', ['-c', 'exit 0'], { timeoutMs: 600_000 });

  assert.equal(res.status, 0);
  assert.equal(res.timedOut, false);
  // Were the limit's timer not cleared, this process could not exit for ten minutes and the runner would say so.
});

test('runAsyncOrThrow turns a timeout into an error that says how long it waited', async () => {
  await assert.rejects(
    runAsyncOrThrow('sh', ['-c', 'exec sleep 120'], { timeoutMs: 300 }),
    /did not finish within 300 ms and was stopped/,
  );
});

test('underTsxRelay: read from the flags the tsx CLI wrapper starts its child with', () => {
  assert.equal(
    underTsxRelay(['--require', '/x/tsx/dist/preflight.cjs', '--import', 'file:///x/tsx/dist/loader.mjs']),
    true,
  );
  assert.equal(underTsxRelay(['--require', 'C:\\x\\tsx\\dist\\preflight.cjs']), true);
  assert.equal(
    underTsxRelay(['--import', 'tsx']),
    false,
    '`node --import tsx` has no wrapper in front of it',
  );
  assert.equal(underTsxRelay([]), false);
});

test('underTsxRelay: tells the two real ways of starting a script apart', () => {
  // The unit above trusts flags I read off a real process; this one keeps them honest across a tsx upgrade.
  const fixture = path.join(process.cwd(), 'scripts/xtask/lib/exec.tsxrelay.fixture.ts');
  const viaWrapper = spawnSync('yarn', ['tsx', fixture], { encoding: 'utf8', cwd: process.cwd() });
  const viaImport = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });

  assert.equal(viaWrapper.stdout.trim(), 'true', viaWrapper.stderr);
  assert.equal(viaImport.stdout.trim(), 'false', viaImport.stderr);
});

/**
 * `xtask test`'s runner, with a REAL signal. The unit tests in test.test.ts hand it a `shouldStop` that flips
 * by itself, which is why they passed while Ctrl-C did not work: every step is a synchronous `spawnSync`, node
 * runs its own signal handler only on a later turn of the event loop, and the runner never took one — so the
 * flag it read was still false and every step after the interrupted one started anyway.
 *
 * Here a child process runs the real `runSteps` with a first step that is a real long-running child, and its
 * whole process group is signalled, as a terminal does. Afterwards the steps behind the first must not have run.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

/** A load-shaped ceiling: starting tsx has taken minutes on a saturated machine. A child that dies is reported at once. */
const BUDGET_MS = 10 * 60_000;

async function runFixture(
  signal: NodeJS.Signals,
): Promise<{ outcomes: Record<string, string>; ran: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-signals-'));

  try {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(process.cwd(), 'scripts/xtask/commands/test.signals.fixture.ts')],
      {
        cwd: process.cwd(),
        env: { ...process.env, FIXTURE_DIR: dir },
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let stdout = '';
    let exited = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    const closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        exited = true;
        resolve();
      });
    });

    const started = Date.now();

    while (!fs.existsSync(path.join(dir, 'first-running'))) {
      assert.ok(!exited, `the fixture died before its first step started:\n${stdout}`);
      assert.ok(Date.now() - started < BUDGET_MS, 'timed out waiting for the first step to start');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // The whole group, like Ctrl-C or a closed terminal: the fixture AND the child its step is waiting for.
    process.kill(-(child.pid as number), signal);

    let giveUp: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        closed,
        new Promise<void>((_, reject) => {
          giveUp = setTimeout(() => reject(new Error('the fixture did not exit')), BUDGET_MS);
        }),
      ]);
    } finally {
      // A pending timer would keep this test process alive for the rest of the budget after the test is over.
      clearTimeout(giveUp);
    }

    return {
      outcomes: JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, string>,
      ran: fs.readdirSync(dir).filter((f) => f.endsWith('-ran')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('xtask test: a real signal stops the run instead of starting the next step', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(signal, async () => {
      const { outcomes, ran } = await runFixture(signal);

      assert.deepEqual(outcomes, { first: 'fail', second: 'not-run', third: 'not-run' });
      assert.deepEqual(ran, [], 'a step behind the interrupted one ran');
    });
  }
});

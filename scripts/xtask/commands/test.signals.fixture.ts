/**
 * The smallest program that behaves like `xtask test` where it matters: the same signal handlers, the same
 * `runSteps`, and a first step that is a real `spawnSync` of a real child. Run only by test.signals.test.ts,
 * which signals its whole process group — what a terminal does on Ctrl-C or a hangup.
 *
 * Prints one JSON line, `{ name: outcome }` per step, then exits 0.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { TERMINATION_SIGNALS } from '../lib/exec';
import { runSteps } from './test';

const dir = process.env.FIXTURE_DIR ?? '';
let interrupted = false;

for (const signal of TERMINATION_SIGNALS) {
  // The no-op index.ts installs first, and the flag `runTest` installs after it.
  process.on(signal, () => {});
  process.on(signal, () => {
    interrupted = true;
  });
}

const mark = (file: string): void => fs.writeFileSync(path.join(dir, file), '');

async function main(): Promise<void> {
  const results = await runSteps(
    [
      {
        name: 'first',
        run: () => {
          // `sh` creates the marker itself, so the test knows the child exists before it signals anything.
          const res = spawnSync('sh', ['-c', `touch "${path.join(dir, 'first-running')}"; sleep 120`], {
            stdio: 'ignore',
          });

          if (res.status !== 0) {
            throw new Error(`exited ${res.status ?? res.signal}`);
          }
        },
      },
      { name: 'second', run: () => mark('second-ran') },
      { name: 'third', run: () => mark('third-ran') },
    ],
    { shouldStop: () => interrupted },
  );

  fs.writeSync(1, `${JSON.stringify(Object.fromEntries(results.map((r) => [r.name, r.outcome])))}\n`);
}

void main();

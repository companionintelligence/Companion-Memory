import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSteps, runSteps, summaryRows, unsuccessful, untestedWorkspaces, type Step } from './test';

const ok = (name: string, log: string[]): Step => ({ name, run: () => void log.push(name) });
const boom = (name: string, log: string[], message = 'exited 1'): Step => ({
  name,
  run: () => {
    log.push(name);
    throw new Error(message);
  },
});

test('runSteps: a failing step does not stop the ones after it — the whole point of the aggregate', async () => {
  const log: string[] = [];
  const results = await runSteps([ok('a', log), boom('b', log), ok('c', log), boom('d', log), ok('e', log)]);

  assert.deepEqual(log, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(
    results.map((r) => [r.name, r.outcome]),
    [
      ['a', 'pass'],
      ['b', 'fail'],
      ['c', 'pass'],
      ['d', 'fail'],
      ['e', 'pass'],
    ],
  );
});

test('runSteps: records why a step failed, whether it threw an Error or something else', async () => {
  const results = await runSteps([
    boom('err', [], 'yarn workspace @ci/x run test exited 2'),
    {
      name: 'str',
      run: () => {
        throw 'plain string';
      },
    },
  ]);

  assert.equal(results[0].detail, 'yarn workspace @ci/x run test exited 2');
  assert.equal(results[1].detail, 'plain string');
});

test('runSteps: measures each step with the injected clock', async () => {
  let t = 1000;
  const results = await runSteps(
    [
      { name: 'slow', run: () => void (t += 250) },
      { name: 'fast', run: () => void (t += 5) },
    ],
    { now: () => t },
  );

  assert.deepEqual(
    results.map((r) => r.durationMs),
    [250, 5],
  );
});

test('runSteps: shouldStop cuts the run short, and the cut-off steps are reported, not dropped', async () => {
  const log: string[] = [];
  let stop = false;
  const results = await runSteps(
    [ok('a', log), { name: 'b', run: () => void (stop = true) }, ok('c', log), ok('d', log)],
    { shouldStop: () => stop },
  );

  assert.deepEqual(log, ['a']);
  assert.deepEqual(
    results.map((r) => [r.name, r.outcome]),
    [
      ['a', 'pass'],
      ['b', 'pass'],
      ['c', 'not-run'],
      ['d', 'not-run'],
    ],
  );
  assert.equal(results[2].detail, 'interrupted');
});

test('runSteps: hooks fire once per step, in order, with the running index', async () => {
  const started: string[] = [];
  const done: string[] = [];

  await runSteps([ok('a', []), boom('b', [])], {
    onStart: (s, i, n) => started.push(`${i + 1}/${n} ${s.name}`),
    onDone: (r) => done.push(`${r.name}:${r.outcome}`),
  });

  assert.deepEqual(started, ['1/2 a', '2/2 b']);
  assert.deepEqual(done, ['a:pass', 'b:fail']);
});

test('unsuccessful: anything but a pass makes the run red, including a step an interrupt cut off', async () => {
  const results = await runSteps([ok('a', []), boom('b', [])]);

  assert.deepEqual(
    unsuccessful(results).map((r) => r.name),
    ['b'],
  );
  assert.deepEqual(unsuccessful(await runSteps([ok('a', []), ok('b', [])])), []);
  assert.deepEqual(
    unsuccessful(await runSteps([ok('a', [])], { shouldStop: () => true })).map((r) => r.outcome),
    ['not-run'],
  );
});

test('summaryRows: one row per step with a human verdict and time; not-run shows a dash', () => {
  const rows = summaryRows([
    { name: 'a', outcome: 'pass', durationMs: 42 },
    { name: 'b', outcome: 'fail', durationMs: 12_345 },
    { name: 'c', outcome: 'not-run', durationMs: 0, detail: 'interrupted' },
  ]);

  assert.deepEqual(rows, [
    ['a', 'pass', '42 ms'],
    ['b', 'FAIL', '12.3 s'],
    ['c', 'not run', '—'],
  ]);
});

test('untestedWorkspaces: exactly the workspaces with no test script', () => {
  assert.deepEqual(
    untestedWorkspaces([
      { location: '.', name: '@ci/root', hasTestScript: true },
      { location: 'frontend/packages/editor', name: '@ci/editor', hasTestScript: false },
    ]),
    ['frontend/packages/editor'],
  );
});

test('buildSteps: one step per testable workspace, then desktop, pytest and the two sh suites', () => {
  const steps = buildSteps('/nonexistent-root', [
    { location: '.', name: '@ci/root', hasTestScript: true },
    { location: 'frontend/packages/editor', name: '@ci/editor', hasTestScript: false },
    { location: 'backend/apps/api', name: '@ci/be-api', hasTestScript: true },
  ]);

  assert.deepEqual(
    steps.map((s) => s.name),
    [
      'workspace @ci/root',
      'workspace @ci/be-api',
      'desktop (node --test)',
      'python (pytest)',
      'gateway (sh)',
      'setup-secrets (sh)',
    ],
  );
});

test('the desktop step fails loudly when it finds no suites, rather than checking nothing', () => {
  const desktop = buildSteps('/nonexistent-root', []).find((s) => s.name === 'desktop (node --test)');

  assert.ok(desktop);
  assert.throws(() => desktop.run(), /would have checked nothing/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_KEEP_FOR_MS,
  MAX_KEEP_FOR_MS,
  STALE_AFTER_MS,
  formatAge,
  parseTestDbArgs,
} from '../lib/testDb';
import { HELP, withThrowaway, type Lifecycle } from './test-db';

/** A lifecycle that records what happened to it, in order. */
function fake(opts: { inspectThrows?: boolean; removeThrows?: boolean; startThrows?: boolean } = {}) {
  const events: string[] = [];
  const lifecycle: Lifecycle<string> = {
    start: () => {
      events.push('start');

      if (opts.startThrows) {
        throw new Error('start failed');
      }

      return 'handle-1';
    },
    inspect: (h) => {
      events.push(`inspect ${h}`);

      if (opts.inspectThrows) {
        throw new Error('inspect failed');
      }
    },
    remove: (h) => {
      events.push(`remove ${h}`);

      if (opts.removeThrows) {
        throw new Error('remove failed');
      }
    },
  };

  return { lifecycle, events };
}

test('a body that succeeds: inspected, then removed, and its value returned', async () => {
  const { lifecycle, events } = fake();
  const value = await withThrowaway(lifecycle, { keep: false }, async (h) => `${h}!`);

  assert.equal(value, 'handle-1!');
  assert.deepEqual(events, ['start', 'inspect handle-1', 'remove handle-1']);
});

test('a body that THROWS still gets the container inspected and removed, and the error propagates', async () => {
  const { lifecycle, events } = fake();

  await assert.rejects(
    withThrowaway(lifecycle, { keep: false }, async () => {
      throw new Error('jest blew up');
    }),
    /jest blew up/,
  );
  assert.deepEqual(events, ['start', 'inspect handle-1', 'remove handle-1']);
});

test('a body that rejects asynchronously, after awaiting, is cleaned up too', async () => {
  const { lifecycle, events } = fake();

  await assert.rejects(
    withThrowaway(lifecycle, { keep: false }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('late failure');
    }),
    /late failure/,
  );
  assert.deepEqual(events, ['start', 'inspect handle-1', 'remove handle-1']);
});

test('keep: the container is inspected but NOT removed', async () => {
  const { lifecycle, events } = fake();

  await withThrowaway(lifecycle, { keep: true }, async () => undefined);
  assert.deepEqual(events, ['start', 'inspect handle-1']);
});

test('keep with a failing body: still not removed', async () => {
  const { lifecycle, events } = fake();

  await assert.rejects(
    withThrowaway(lifecycle, { keep: true }, async () => {
      throw new Error('x');
    }),
    /x/,
  );
  assert.deepEqual(events, ['start', 'inspect handle-1']);
});

test('inspect (the crash sentinel) failing does not stop the removal', async () => {
  const { lifecycle, events } = fake({ inspectThrows: true });

  await withThrowaway(lifecycle, { keep: false }, async () => undefined);
  assert.deepEqual(events, ['start', 'inspect handle-1', 'remove handle-1']);
});

test("a failing removal never replaces the run's own error", async () => {
  const { lifecycle } = fake({ removeThrows: true });

  await assert.rejects(
    withThrowaway(lifecycle, { keep: false }, async () => {
      throw new Error('the real problem');
    }),
    /the real problem/,
  );
});

test('a start that fails has nothing to clean up: no inspect, no remove', async () => {
  const { lifecycle, events } = fake({ startThrows: true });

  await assert.rejects(
    withThrowaway(lifecycle, { keep: false }, async () => undefined),
    /start failed/,
  );
  assert.deepEqual(events, ['start']);
});

// -- --help -----------------------------------------------------------------------------------------------------

test('--help names every flag the parser accepts: a flag added to the parser without a line here fails', () => {
  let message = '';

  try {
    parseTestDbArgs(['--no-such-flag']);
  } catch (error) {
    message = (error as Error).message;
  }

  const flags = /Flags for this command: ([^.]*)\./.exec(message)?.[1]?.split(', ') ?? [];

  assert.ok(flags.length >= 6 && flags.includes('--keep-for'), `read the flag list out of: ${message}`);

  for (const flag of flags) {
    assert.ok(HELP.includes(flag), `${flag} is accepted but not in --help`);
  }
});

test('--help says what --keep really does now: the window, its default and cap taken from the constants, the live-client rule and rename', () => {
  assert.doesNotMatch(HELP, /removes it once it is more than two hours old/, 'the old, now untrue, sentence');
  assert.match(HELP, /--keep-for <t>\s+Like --keep/);
  assert.ok(
    HELP.includes(`for ${formatAge(DEFAULT_KEEP_FOR_MS)} (change it with --keep-for)`),
    'the default window',
  );
  assert.ok(HELP.includes(`most ${formatAge(MAX_KEEP_FOR_MS)}.`), 'the cap');
  assert.match(HELP, /make test-db KEEP_FOR=12h/);
  assert.match(HELP, /as\s+long as anything is connected to it/);

  // The paragraph on what the reaper removes, in the order it checks.
  const reaper = HELP.slice(HELP.indexOf('Every run first removes'));

  assert.match(reaper, /named ci-testdb-\*, carries the ci\.test-db=1 label/);
  assert.ok(reaper.includes(`${formatAge(STALE_AFTER_MS)} old`), 'the age floor');
  assert.match(reaper, /outside its --keep window and has nothing connected to it/);
  assert.match(reaper, /left alone and named in the output/);
  assert.match(reaper, /docker\s+rename <name> <new name>\) protects it from every later run/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  removeContainers,
  startContainer,
  type CreatedContainer,
  type DockerFn,
  type DockerResult,
} from './docker';

const NAME = 'ci-testdb-deadbeef';
const ID = 'f'.repeat(64);

const ok = (stdout = ''): DockerResult => ({ status: 0, stdout, stderr: '' });
const failed = (stderr: string): DockerResult => ({ status: 1, stdout: '', stderr });

/**
 * A fake docker CLI: `handlers` answers by subcommand (`run`, `port`, `rm`, `ps`),
 * every call is recorded, and a subcommand with no handler answers success with
 * no output — which is what a real `docker ps` says about a container that is gone.
 */
function fakeDocker(handlers: Partial<Record<string, (args: string[]) => DockerResult>>) {
  const calls: string[][] = [];
  const run: DockerFn = (args) => {
    calls.push(args);

    return handlers[args[0]]?.(args) ?? ok();
  };

  return { run, calls, sub: (cmd: string) => calls.filter((c) => c[0] === cmd) };
}

function hooks() {
  const events: string[] = [];

  return {
    events,
    opts: {
      onCreated: (c: CreatedContainer) => events.push(`created ${c.id}`),
      onRemoved: (c: CreatedContainer) => events.push(`removed ${c.id}`),
      sleep: () => events.push('sleep'),
    },
  };
}

test('success: returns the id and port, and removes nothing', () => {
  const d = fakeDocker({ run: () => ok(`${ID}\n`), port: () => ok('127.0.0.1:61778\n') });
  const h = hooks();
  const started = startContainer('img', NAME, 'pw', { ...h.opts, run: d.run });

  assert.deepEqual(started, { id: ID, name: NAME, port: 61778 });
  assert.deepEqual(h.events, [`created ${ID}`]);
  assert.equal(d.sub('rm').length, 0);
});

test('the published port shows up late: retried, and nothing removed', () => {
  let attempts = 0;
  const d = fakeDocker({
    run: () => ok(`${ID}\n`),
    port: () => (++attempts < 4 ? failed('no public port') : ok('127.0.0.1:50000\n')),
  });
  const h = hooks();
  const started = startContainer('img', NAME, 'pw', { ...h.opts, run: d.run });

  assert.equal(started.port, 50000);
  assert.equal(h.events.filter((e) => e === 'sleep').length, 3);
  assert.equal(d.sub('rm').length, 0);
});

test('`docker port` failing AFTER a successful run removes the container it created', () => {
  const d = fakeDocker({
    run: () => ok(`${ID}\n`),
    port: () => failed('fake: error response from daemon'),
  });
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
  // Registered for the exit backstop first, released only once it is really gone.
  assert.deepEqual(
    h.events.filter((e) => e !== 'sleep'),
    [`created ${ID}`, `removed ${ID}`],
  );
});

test('an unparseable port answer also removes the container', () => {
  const d = fakeDocker({ run: () => ok(`${ID}\n`), port: () => ok('no port here\n') });
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

test('a removal that fails is reported with the command to run, and stays registered for the backstop', () => {
  const d = fakeDocker({
    run: () => ok(`${ID}\n`),
    port: () => failed('daemon unwell'),
    rm: () => failed('Error response from daemon: timeout'),
    ps: () => ok(`${ID}\n`), // still there
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    (err: Error) =>
      /daemon unwell/.test(err.message) &&
      /could not be removed just now — if 'docker ps -a' still lists it, run: docker rm -f -v ci-testdb-deadbeef/.test(
        err.message,
      ),
  );
  // onRemoved never fired, so a caller's backstop still holds it.
  assert.deepEqual(
    h.events.filter((e) => e !== 'sleep'),
    [`created ${ID}`],
  );
});

test('`docker run` failing — a name conflict looks exactly like this — removes nothing at all', () => {
  const d = fakeDocker({
    run: () => failed(`Conflict. The container name "/${NAME}" is already in use by container "abc"`),
  });
  const h = hooks();

  assert.throws(
    () => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }),
    /docker run failed: Conflict/,
  );
  assert.deepEqual(h.events, []);
  assert.deepEqual(
    d.calls.map((c) => c[0]),
    ['run'],
    'no port, rm, ps or any other call after a failed run',
  );
});

test('an empty id from `docker run` falls back to the name it just claimed', () => {
  const d = fakeDocker({ run: () => ok(''), port: () => failed('nope') });
  const h = hooks();

  assert.throws(() => startContainer('img', NAME, 'pw', { ...h.opts, run: d.run }), /could not read/);
  assert.deepEqual(
    d.sub('rm').map((c) => c.slice(0, 4)),
    [['rm', '-f', '-v', NAME]],
  );
});

test('removeContainers still refuses a container that is not ours, before any docker call', () => {
  const d = fakeDocker({});

  assert.throws(
    () => removeContainers([{ id: ID, name: 'ci-server-someone-elses-db', createdAt: 0, labels: {} }], d.run),
    /refusing to remove/,
  );
  assert.equal(d.calls.length, 0);
});

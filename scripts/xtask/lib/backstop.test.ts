import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { ExitBackstop } from './backstop';
import { startContainer, type CreatedContainer } from './docker';
import { FakeDaemon, failed, ok, ours } from './fakeDocker';

const NAME = 'ci-testdb-deadbeef';
const ID = 'f'.repeat(64);
const C: CreatedContainer = { id: ID, name: NAME };
const noSleep = (): void => undefined;

// Every directory a test makes is removed when the file is done, whatever the test did with it: the sweep
// removes it in most, but a test that stubs the removal, or never sweeps, would otherwise leave it in the OS
// temp folder — where it looks exactly like the leftover of a hard-killed run, the thing this code exists to avoid.
const made: string[] = [];

after(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup(opts: { keep?: boolean; daemon?: FakeDaemon } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-db-backstop-'));

  made.push(workDir);
  const warnings: string[] = [];
  const daemon = opts.daemon ?? new FakeDaemon({ containers: [ours(ID, NAME)] });
  const backstop = new ExitBackstop({
    keep: opts.keep ?? false,
    workDir,
    run: daemon.run,
    sleep: noSleep,
    warn: (m) => warnings.push(m),
  });

  return { backstop, daemon, warnings, workDir };
}

test("removes the live container and this run's work directory", () => {
  const { backstop, daemon, workDir, warnings } = setup();

  fs.writeFileSync(path.join(workDir, 'jest-report.json'), '{}');
  backstop.claimed(C);

  assert.deepEqual(backstop.sweep(), { removed: [NAME], held: [] });
  assert.equal(daemon.containers.length, 0);
  assert.equal(fs.existsSync(workDir), false, 'the work directory is gone');
  assert.deepEqual(backstop.held(), []);
  assert.deepEqual(warnings, []);
});

test("removes ONLY its own work directory — a leftover from a killed run, or anyone else's, is not touched", () => {
  const { backstop, workDir } = setup();
  const someoneElses = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-db-'));

  try {
    backstop.sweep();
    assert.equal(fs.existsSync(workDir), false);
    assert.equal(fs.existsSync(someoneElses), true, "another run's directory survives");
  } finally {
    fs.rmSync(someoneElses, { recursive: true, force: true });
  }
});

test('--keep: the live container is left running, but the directory still goes', () => {
  const { backstop, daemon, workDir } = setup({ keep: true });

  backstop.claimed(C);

  assert.deepEqual(backstop.sweep(), { removed: [], held: [] });
  assert.equal(daemon.containers.length, 1, 'still running, as asked');
  assert.deepEqual(daemon.sub('rm'), []);
  assert.equal(fs.existsSync(workDir), false);
  assert.deepEqual(backstop.held(), [], 'a deliberately kept container is not "held"');
});

test('--keep does NOT protect a container that never became a usable database', () => {
  const { backstop, daemon } = setup({ keep: true });

  backstop.created(C); // docker run returned an id; startContainer never handed it back

  assert.deepEqual(backstop.sweep().removed, [NAME]);
  assert.equal(daemon.containers.length, 0);
});

test('a container the daemon will not confirm is KEPT registered, the operator is told the exact command, and a later sweep can still remove it', () => {
  let healthy = false;
  const daemon = new FakeDaemon({
    containers: [ours(ID, NAME)],
    override: {
      rm: () => (healthy ? undefined : failed('timeout')),
      ps: () => (healthy ? undefined : failed('Cannot connect to the Docker daemon')),
    },
  });
  const { backstop, warnings } = setup({ daemon });

  backstop.claimed(C);

  const first = backstop.sweep();

  assert.deepEqual(first, { removed: [], held: [NAME] });
  assert.deepEqual(backstop.held(), [NAME], 'still registered');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not confirm that ci-testdb-deadbeef was removed/);
  assert.match(warnings[0], /STILL BE RUNNING; run: docker rm -f -v ci-testdb-deadbeef/);

  healthy = true;

  assert.deepEqual(
    backstop.sweep(),
    { removed: [NAME], held: [] },
    'the daemon recovered: the next sweep finishes the job',
  );
  assert.deepEqual(backstop.held(), []);
});

test('a container that is confirmed present but will not go is held too, with the plain "could not be removed" message', () => {
  const daemon = new FakeDaemon({
    containers: [ours(ID, NAME)],
    override: { rm: () => failed('device busy') },
  });
  const { backstop, warnings } = setup({ daemon });

  backstop.claimed(C);
  assert.deepEqual(backstop.sweep().held, [NAME]);
  assert.match(
    warnings[0],
    /ci-testdb-deadbeef could not be removed — if 'docker ps -a' still lists it, run: docker rm -f -v ci-testdb-deadbeef/,
  );
});

test('an uncertain name (docker run died, the daemon would not say) is swept BY NAME at exit, label-checked', () => {
  const stranger = { id: 'a'.repeat(64), name: 'ci-testdb-cafef00d', labels: { app: 'x' } };
  const daemon = new FakeDaemon({ containers: [ours(ID, NAME), stranger] });
  const { backstop } = setup({ daemon });

  backstop.uncertainName(NAME);
  assert.deepEqual(backstop.held(), [NAME]);
  assert.deepEqual(backstop.sweep(), { removed: [NAME], held: [] });
  assert.deepEqual(daemon.containers, [stranger]);

  // And a name that belongs to a stranger (no label) is never removed.
  backstop.uncertainName('ci-testdb-cafef00d');
  assert.deepEqual(backstop.sweep(), { removed: [], held: [] }, 'nothing of ours under that name: settled');
  assert.deepEqual(daemon.containers, [stranger], 'the stranger is untouched');
  assert.deepEqual(daemon.sub('rm').length, 1, 'only the one removal, of ours');
});

test('an uncertain name the daemon still will not answer about stays uncertain, and says so', () => {
  const daemon = new FakeDaemon({ override: { ps: () => failed('no daemon') } });
  const { backstop, warnings } = setup({ daemon });

  backstop.uncertainName(NAME);
  assert.deepEqual(backstop.sweep(), { removed: [], held: [NAME] });
  assert.match(
    warnings[0],
    /could not confirm that ci-testdb-deadbeef is gone — it may exist; if 'docker ps -a' still lists it, run: docker rm -f -v ci-testdb-deadbeef/,
  );
  assert.deepEqual(backstop.held(), [NAME]);
});

test('sweeping twice is harmless: the second sweep makes no docker call', () => {
  const { backstop, daemon } = setup();

  backstop.claimed(C);
  backstop.sweep();

  const calls = daemon.calls.length;

  assert.deepEqual(backstop.sweep(), { removed: [], held: [] });
  assert.equal(daemon.calls.length, calls);
});

test('released() lets go of a container only once its removal was confirmed; nothing is left to sweep', () => {
  const { backstop, daemon } = setup();

  backstop.created(C);
  backstop.released(C);
  assert.deepEqual(backstop.held(), []);
  assert.deepEqual(backstop.sweep(), { removed: [], held: [] });
  assert.equal(daemon.calls.length, 0);
});

test('a sweep never throws, however docker misbehaves', () => {
  const { backstop, warnings } = setup({
    daemon: new FakeDaemon({
      override: {
        rm: () => {
          throw new Error('spawn docker ENOENT');
        },
      },
    }),
  });

  backstop.claimed(C);
  assert.doesNotThrow(() => backstop.sweep());
  assert.match(
    warnings[0],
    /removing ci-testdb-deadbeef failed \(spawn docker ENOENT\).*docker rm -f -v ci-testdb-deadbeef/,
  );
});

test('a work directory that cannot be removed does not fail the exit', () => {
  const { backstop } = setup();

  const stubborn = new ExitBackstop({
    keep: false,
    workDir: '/x',
    removeDir: () => {
      throw new Error('EBUSY');
    },
    run: new FakeDaemon().run,
  });

  assert.doesNotThrow(() => stubborn.sweep());
  backstop.sweep();
});

// -- the blocker, end to end: startContainer wired to the backstop exactly as test-db wires it ------------

function wired(daemon: FakeDaemon) {
  const s = setup({ daemon });
  const outcome = (() => {
    try {
      startContainer('img', NAME, 'pw', {
        run: daemon.run,
        sleep: noSleep,
        onCreated: (c) => s.backstop.created(c),
        onRemoved: (c) => s.backstop.released(c),
        onUncertain: (n) => s.backstop.uncertainName(n),
      });

      return 'started';
    } catch (err) {
      return (err as Error).message;
    }
  })();

  return { ...s, outcome };
}

test('BLOCKER end to end: rm and ps both fail after a failed port lookup — the backstop is STILL holding the running container', () => {
  let healthy = false;
  const daemon = new FakeDaemon({
    override: {
      run: (_a, d) => {
        d.containers.push(ours(ID, NAME));

        return ok(`${ID}\n`);
      },
      port: () => failed('daemon unwell'),
      rm: () => (healthy ? undefined : failed('timeout')),
      ps: () => (healthy ? undefined : failed('daemon unwell')),
    },
  });
  const w = wired(daemon);

  assert.match(w.outcome, /STILL BE RUNNING/);
  assert.doesNotMatch(w.outcome, /was removed/);
  assert.equal(daemon.containers.length, 1, 'the container is running');
  assert.deepEqual(
    w.backstop.held(),
    [NAME],
    'and something is still tracking it (before the fix: nothing was)',
  );

  healthy = true;
  assert.deepEqual(w.backstop.sweep().removed, [NAME]);
  assert.equal(daemon.containers.length, 0);
});

test('LEAK end to end: docker run killed after the daemon created the container, and the sweep cannot answer — the exit sweep finds it by name', () => {
  let healthy = false;
  const daemon = new FakeDaemon({
    containers: [ours(ID, NAME)],
    override: {
      run: () => ({ status: null, stdout: '', stderr: 'docker run timed out after 120000 ms' }),
      ps: () => (healthy ? undefined : failed('daemon unwell')),
    },
  });
  const w = wired(daemon);

  assert.match(w.outcome, /could not check whether ci-testdb-deadbeef was left behind/);
  assert.deepEqual(w.backstop.held(), [NAME]);

  healthy = true;
  assert.deepEqual(w.backstop.sweep().removed, [NAME]);
  assert.equal(daemon.containers.length, 0);
});

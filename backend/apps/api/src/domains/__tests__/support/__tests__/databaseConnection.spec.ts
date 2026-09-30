import type { SpawnSyncReturns } from 'node:child_process';
import { createServer, type Server } from 'node:net';

import {
  dataSourceConnection,
  databaseAvailability,
  databaseRequired,
  decideAvailability,
  failIfRequired,
  isExplicitlySet,
  probePort,
  probeTimeoutMs,
  resolveConfiguration,
  resolveConnection,
  type AvailabilityWording,
  type DatabaseAvailability,
  type PortProbe,
  type PortProbeOutcome,
  type ProbeSpawn,
  type TestDatabaseConfiguration,
} from '../databaseConnection';
import { resolveAdminConfiguration } from '../scratchDatabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "CAN THIS SUITE RUN?" — the answer a busy machine used to get wrong.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every database-backed spec asks `databaseAvailability()` at collection time
 * and skips when it says no. For a long time "no" also covered "the probe
 * process never got to answer": a child killed by its time limit on a loaded
 * machine exited with no status, and that read exactly like "nothing
 * listening", so a suite pointed explicitly at a healthy Postgres skipped all
 * its tests and the run stayed green. These tests pin the rule that replaced
 * it — a skip needs proof of absence AND an unasked-for database — including
 * against real child processes, because the regression lives in how a real
 * `spawnSync` result is read.
 *
 * No database is needed: the "database" is a TCP server on an ephemeral port.
 */

// Real child processes on a machine that may itself be busy running the rest
// of the suite. Each probe takes well under a second when idle.
jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function listening(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  if (address == null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }

  return { server, port: address.port };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error == null ? resolve() : reject(error))),
  );
}

/** A port that was listening a moment ago and is not now. */
async function closedPort(): Promise<number> {
  const { server, port } = await listening();

  await close(server);

  return port;
}

/** A `spawnSync` result, as the real one shapes it. */
function result(fields: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return { pid: 4242, output: [], stdout: '', stderr: '', status: 0, signal: null, ...fields };
}

/** The probe process got as far as reporting `line`. */
const reported = (line: string) => result({ stdout: `ci-db-probe ${line}\n` });

/** What `spawnSync` returns when its `timeout` kills the child — observed verbatim under load. */
const killedByTimeLimit = () =>
  result({
    status: null,
    signal: 'SIGTERM',
    error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  });

/** A spawn that plays back `results` in order and records what it was asked to run. */
function scriptedSpawn(...results: SpawnSyncReturns<string>[]) {
  const calls: Array<Parameters<ProbeSpawn>> = [];
  const spawn: ProbeSpawn = (...args) => {
    calls.push(args);

    const next = results[calls.length - 1];

    if (next == null) {
      throw new Error(`the probe spawned ${calls.length} processes; the test scripted ${results.length}`);
    }

    return next;
  };

  return { spawn, calls };
}

function probe(outcome: PortProbeOutcome, detail = 'observed'): PortProbe {
  return { outcome, detail, attempts: 1 };
}

function configured(explicit: boolean): TestDatabaseConfiguration {
  return {
    kind: 'configured',
    variable: explicit ? 'MEMORY_TEST_DATABASE_URL' : 'DATABASE_PASSWORD',
    explicit,
    connection: { host: 'db.test', port: 5433, username: 'u', password: 'p', database: 'companion' },
  };
}

const WORDING: AvailabilityWording = {
  noneReason: 'no database configured — set MEMORY_TEST_DATABASE_URL or DATABASE_URL',
  urlEnvVar: 'MEMORY_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'MEMORY_TEST_PROBE_TIMEOUT_MS',
};

/**
 * Run `body` with `vars` set (a value) or removed (`undefined`) in
 * process.env, restoring every one afterwards. Jest gives each test file its
 * own copy of process.env, so this cannot leak into another suite.
 */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));

  const apply = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  apply(vars);

  try {
    return body();
  } finally {
    apply(saved);
  }
}

// The variables every configuration test has to control, whatever the
// developer running this happens to have exported or in .env.
const NO_DATABASE_ENV = {
  CI_REQUIRE_DB: undefined,
  DATABASE_URL: undefined,
  DATABASE_PASSWORD: undefined,
  DATABASE_HOST: undefined,
  DATABASE_PORT: undefined,
  DATABASE_USERNAME: undefined,
  DATABASE_NAME: undefined,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('resolveConfiguration', () => {
  const none = new Set<string>();

  it("prefers the suite's own URL, then DATABASE_URL, then the discrete variables", () => {
    const env = {
      MEMORY_TEST_DATABASE_URL: 'postgres://suite:pw@suite.test:5501/suite_db',
      DATABASE_URL: 'postgres://app:pw@app.test:5502/app_db',
      DATABASE_PASSWORD: 'discrete',
    };

    expect(resolveConfiguration({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' }, env, none)).toMatchObject({
      kind: 'configured',
      variable: 'MEMORY_TEST_DATABASE_URL',
      connection: { host: 'suite.test', port: 5501, username: 'suite', password: 'pw', database: 'suite_db' },
    });
    expect(resolveConfiguration({}, env, none)).toMatchObject({ variable: 'DATABASE_URL' });
    expect(resolveConfiguration({}, { DATABASE_PASSWORD: 'discrete' }, none)).toMatchObject({
      kind: 'configured',
      variable: 'DATABASE_PASSWORD',
      connection: { host: 'localhost', port: 5432, username: 'companion', database: 'companion' },
    });
  });

  it('treats a blank variable as unset and falls through to the next one', () => {
    // A blank suite variable used to skip PAST DATABASE_URL to the discrete
    // variables, because `'' ?? DATABASE_URL` is ''.
    const env = { MEMORY_TEST_DATABASE_URL: '  ', DATABASE_URL: 'postgres://app:pw@app.test:5502/app_db' };

    expect(resolveConfiguration({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' }, env, none)).toMatchObject({
      variable: 'DATABASE_URL',
    });
  });

  it('counts a URL set for the run as explicit, and one that .env filled in as not', () => {
    const env = { DATABASE_URL: 'postgres://app:pw@app.test:5502/app_db' };

    expect(resolveConfiguration({}, env, none)).toMatchObject({ explicit: true });
    expect(resolveConfiguration({}, env, new Set(['DATABASE_URL']))).toMatchObject({ explicit: false });
  });

  it('never counts the discrete DATABASE_* variables as explicit — .env.default ships them', () => {
    expect(resolveConfiguration({}, { DATABASE_PASSWORD: 'set-in-the-shell' }, none)).toMatchObject({
      explicit: false,
    });
  });

  it('reports a URL that does not parse as malformed, not as "nothing configured"', () => {
    expect(
      resolveConfiguration(
        { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' },
        { MEMORY_TEST_DATABASE_URL: 'not a url' },
        none,
      ),
    ).toEqual({ kind: 'malformed', variable: 'MEMORY_TEST_DATABASE_URL' });
  });

  it('strips the brackets from an IPv6 host, which a socket cannot resolve', () => {
    expect(resolveConfiguration({}, { DATABASE_URL: 'postgres://u:p@[::1]:5432/db' }, none)).toMatchObject({
      connection: { host: '::1' },
    });
  });

  it('says none when nothing is configured', () => {
    expect(resolveConfiguration({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' }, {}, none)).toEqual({
      kind: 'none',
    });
    expect(resolveConfiguration({}, { DATABASE_PASSWORD: '' }, none)).toEqual({ kind: 'none' });
  });
});

describe("resolveAdminConfiguration — the scratch database's connection, by the same rules", () => {
  const ADMIN_ENV = {
    ...NO_DATABASE_ENV,
    PIPELINE_TEST_ADMIN_DATABASE_URL: undefined,
    DATABASE_ADMIN_PASSWORD: undefined,
    DATABASE_ADMIN_USERNAME: undefined,
  };

  it('counts an admin URL set for the run as explicit', () => {
    const configuration = withEnv(
      { ...ADMIN_ENV, PIPELINE_TEST_ADMIN_DATABASE_URL: 'postgres://postgres:pw@db.test:5434/postgres' },
      resolveAdminConfiguration,
    );

    expect(configuration).toMatchObject({
      kind: 'configured',
      variable: 'PIPELINE_TEST_ADMIN_DATABASE_URL',
      explicit: true,
      connection: { host: 'db.test', port: 5434, username: 'postgres', database: 'postgres' },
    });
  });

  it('never counts DATABASE_ADMIN_PASSWORD as explicit — .env.default ships it', () => {
    const configuration = withEnv(
      { ...ADMIN_ENV, DATABASE_ADMIN_PASSWORD: 'admin', DATABASE_PASSWORD: 'app', DATABASE_PORT: '5435' },
      resolveAdminConfiguration,
    );

    expect(configuration).toMatchObject({
      kind: 'configured',
      variable: 'DATABASE_ADMIN_PASSWORD',
      explicit: false,
      // The SERVER comes from the application connection; the database is the maintenance one.
      connection: {
        host: 'localhost',
        port: 5435,
        username: 'postgres',
        password: 'admin',
        database: 'postgres',
      },
    });
  });

  it('reports a malformed admin URL as malformed, and nothing configured as none', () => {
    expect(
      withEnv({ ...ADMIN_ENV, PIPELINE_TEST_ADMIN_DATABASE_URL: 'nope' }, resolveAdminConfiguration),
    ).toEqual({
      kind: 'malformed',
      variable: 'PIPELINE_TEST_ADMIN_DATABASE_URL',
    });
    expect(withEnv(ADMIN_ENV, resolveAdminConfiguration)).toEqual({ kind: 'none' });
  });
});

describe('isExplicitlySet', () => {
  it('is true only for a non-blank value that .env did not fill in', () => {
    expect(isExplicitlySet('X', { X: 'value' }, new Set())).toBe(true);
    expect(isExplicitlySet('X', { X: 'value' }, new Set(['X']))).toBe(false);
    expect(isExplicitlySet('X', { X: ' ' }, new Set())).toBe(false);
    expect(isExplicitlySet('X', {}, new Set())).toBe(false);
  });
});

describe('probeTimeoutMs', () => {
  it('uses the variable when it holds a positive number, and 2000 ms otherwise', () => {
    expect(probeTimeoutMs('T', { T: '9000' })).toBe(9000);
    expect(probeTimeoutMs('T', { T: '' })).toBe(2000);
    expect(probeTimeoutMs('T', { T: '0' })).toBe(2000);
    expect(probeTimeoutMs('T', { T: '5s' })).toBe(2000);
    expect(probeTimeoutMs(undefined, {})).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// The probe, with the process scripted
// ---------------------------------------------------------------------------

describe('probePort — reading what the probe process did', () => {
  const run = (spawn: ProbeSpawn, attempts = 3) =>
    probePort('db.test', 5433, { timeoutMs: 2000, startupAllowanceMs: 10_000, attempts, spawn });

  it('reads a reported connection as open', () => {
    const { spawn } = scriptedSpawn(reported('open'));

    expect(run(spawn)).toMatchObject({ outcome: 'open', attempts: 1 });
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'reads %s as refused — evidence of absence — and does not retry it',
    (code) => {
      const { spawn, calls } = scriptedSpawn(reported(`error ${code}`));

      expect(run(spawn)).toEqual({ outcome: 'refused', detail: code, attempts: 1 });
      expect(calls).toHaveLength(1);
    },
  );

  it('reads a probe KILLED BY ITS TIME LIMIT as inconclusive, never as refused', () => {
    // The regression. This is the exact result spawnSync returned for a probe
    // that could not start in time on a loaded machine, and the old code read
    // `status !== 0` as "nothing accepting connections" and skipped the suite.
    const { spawn } = scriptedSpawn(killedByTimeLimit(), killedByTimeLimit(), killedByTimeLimit());
    const answer = run(spawn);

    expect(answer.outcome).toBe('inconclusive');
    expect(answer.attempts).toBe(3);
    expect(answer.detail).toMatch(/attempt 1: the probe process was killed after \d+ ms without reporting/);
    expect(answer.detail).toContain('SIGTERM');
  });

  it('reads a process that exited 1 without reporting as inconclusive — node crashing on start-up is not a closed port', () => {
    // Exit 1 was also what the old probe used for "closed", so a crash while
    // loading NODE_OPTIONS' preload read as "no database".
    const { spawn } = scriptedSpawn(
      result({ status: 1, stderr: 'Error: Cannot find module /missing.cjs\n    at …' }),
    );

    expect(run(spawn, 1)).toEqual({
      outcome: 'inconclusive',
      detail: 'the probe process exited 1 without reporting (Error: Cannot find module /missing.cjs)',
      attempts: 1,
    });
  });

  it('reads a process that could not be started as inconclusive', () => {
    const { spawn } = scriptedSpawn(
      result({ status: null, error: Object.assign(new Error('spawnSync node EAGAIN'), { code: 'EAGAIN' }) }),
    );

    expect(run(spawn, 1)).toMatchObject({
      outcome: 'inconclusive',
      detail: 'the probe process could not be run (EAGAIN)',
    });
  });

  it('reads an error that is the probe’s own trouble (EMFILE) as inconclusive', () => {
    const { spawn } = scriptedSpawn(reported('error EMFILE'));

    expect(run(spawn, 1)).toMatchObject({
      outcome: 'inconclusive',
      detail: 'the connection attempt failed with EMFILE',
    });
  });

  it('reads a report it does not recognise as inconclusive', () => {
    const { spawn } = scriptedSpawn(result({ stdout: 'something else entirely\n' }));

    expect(run(spawn, 1)).toMatchObject({ outcome: 'inconclusive' });
  });

  it('retries a stall and stops at the first definite answer', () => {
    const { spawn, calls } = scriptedSpawn(killedByTimeLimit(), reported('unanswered'), reported('open'));
    const answer = run(spawn);

    expect(answer.outcome).toBe('open');
    expect(answer.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(answer.detail).toMatch(
      /^attempt 1: the probe process was killed .*; attempt 2: no answer within 2000 ms; attempt 3: connected/,
    );
  });

  it('gives up after the configured number of attempts', () => {
    const { spawn, calls } = scriptedSpawn(reported('unanswered'), reported('unanswered'));

    expect(run(spawn, 2)).toMatchObject({ outcome: 'unanswered', attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it('starts the probe without NODE_OPTIONS, bounded by the socket timeout plus the start-up allowance', () => {
    const { spawn, calls } = scriptedSpawn(reported('open'));

    withEnv({ NODE_OPTIONS: '--require /definitely/not/here.cjs' }, () => run(spawn));

    const [command, args, options] = calls[0];

    expect(command).toBe(process.execPath);
    expect(args.slice(2)).toEqual(['db.test', '5433', '2000']);
    expect(options.timeout).toBe(12_000);
    expect(options.env).toBeDefined();
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
  });
});

// ---------------------------------------------------------------------------
// The probe, for real
// ---------------------------------------------------------------------------

describe('probePort — real probe processes', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await listening());
  });

  afterAll(async () => {
    await close(server);
  });

  it('finds a listening port open', () => {
    expect(probePort('127.0.0.1', port, { timeoutMs: 2000 })).toMatchObject({ outcome: 'open', attempts: 1 });
  });

  it('finds a port nobody listens on refused', async () => {
    const closed = await closedPort();

    expect(probePort('127.0.0.1', closed, { timeoutMs: 2000 })).toEqual({
      outcome: 'refused',
      detail: 'ECONNREFUSED',
      attempts: 1,
    });
  });

  it('says inconclusive — not refused — when the probe process cannot start in time, although the port IS open', () => {
    // A two-millisecond limit is shorter than node's own start-up on any
    // machine, so this is the busy-machine failure made deterministic: a real
    // child, really killed by spawnSync, with a real server listening.
    const answer = probePort('127.0.0.1', port, { timeoutMs: 1, startupAllowanceMs: 1, attempts: 2 });

    expect(answer.outcome).toBe('inconclusive');
    expect(answer.attempts).toBe(2);
    expect(answer.detail).toMatch(/killed after \d+ ms without reporting \(limit 2 ms, SIGTERM\)/);
  });

  it('is not broken by the NODE_OPTIONS it runs under', () => {
    // Inherited, a preload that fails to load crashed the probe with exit 1 —
    // the old "closed". The probe needs no preload, so it no longer gets one.
    const answer = withEnv({ NODE_OPTIONS: '--require /definitely/not/here.cjs' }, () =>
      probePort('127.0.0.1', port, { timeoutMs: 2000 }),
    );

    expect(answer.outcome).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe('decideAvailability', () => {
  it('skips when nothing is configured', () => {
    expect(decideAvailability({ kind: 'none' }, null, WORDING)).toEqual({
      verdict: 'skip',
      reason: WORDING.noneReason,
      target: '(unset)',
    });
  });

  it('fails on a malformed URL, naming the variable but never printing its value', () => {
    const decision = decideAvailability(
      { kind: 'malformed', variable: 'MEMORY_TEST_DATABASE_URL' },
      null,
      WORDING,
    );

    expect(decision.verdict).toBe('fail');
    expect(decision.reason).toContain('MEMORY_TEST_DATABASE_URL is set but is not a valid connection URL');
  });

  it.each([true, false])('runs whenever something is listening (explicit: %s)', (explicit) => {
    expect(decideAvailability(configured(explicit), probe('open'), WORDING)).toEqual({
      verdict: 'run',
      reason: 'Postgres reachable at db.test:5433/companion',
      target: 'db.test:5433/companion',
    });
  });

  it('FAILS when an explicitly configured database refuses connections', () => {
    const decision = decideAvailability(configured(true), probe('refused', 'ECONNREFUSED'), WORDING);

    expect(decision.verdict).toBe('fail');
    expect(decision.reason).toContain(
      'MEMORY_TEST_DATABASE_URL points at db.test:5433/companion, but nothing is accepting connections there (ECONNREFUSED)',
    );
    expect(decision.reason).toContain('make dburl');
  });

  it('skips when the database .env describes is down — the stack is not running', () => {
    const decision = decideAvailability(configured(false), probe('refused', 'ECONNREFUSED'), WORDING);

    expect(decision.verdict).toBe('skip');
    expect(decision.reason).toMatch(
      /^nothing accepting connections at db\.test:5433\/companion \(ECONNREFUSED\)/,
    );
    expect(decision.reason).toContain('set MEMORY_TEST_DATABASE_URL');
  });

  it.each([true, false])('fails when nothing answers at all (explicit: %s)', (explicit) => {
    const decision = decideAvailability(
      configured(explicit),
      probe('unanswered', 'no answer within 2000 ms'),
      WORDING,
    );

    expect(decision.verdict).toBe('fail');
    expect(decision.reason).toContain('No answer from db.test:5433/companion');
    expect(decision.reason).toContain('raise MEMORY_TEST_PROBE_TIMEOUT_MS');
  });

  it.each([true, false])(
    'fails — never skips — when the probe could not answer, however the database was configured (explicit: %s)',
    (explicit) => {
      const decision = decideAvailability(
        configured(explicit),
        probe('inconclusive', 'the probe process was killed after 12000 ms without reporting'),
        WORDING,
      );

      expect(decision.verdict).toBe('fail');
      expect(decision.reason).toContain(
        'Could not find out whether anything is listening at db.test:5433/companion',
      );
      expect(decision.reason).toContain('killed after 12000 ms');
      expect(decision.reason).toContain('--maxWorkers');
    },
  );

  it('leaves out the timeout advice when the suite has no timeout variable', () => {
    const wording = { ...WORDING, probeTimeoutEnvVar: undefined };
    const decision = decideAvailability(configured(true), probe('inconclusive'), wording);

    expect(decision.reason).not.toContain('raise');
    expect(decision.reason).toMatch(/\(--maxWorkers\)\.$/);
  });
});

// ---------------------------------------------------------------------------
// End to end: what a spec sees
// ---------------------------------------------------------------------------

describe('databaseAvailability', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await listening());
  });

  afterAll(async () => {
    await close(server);
  });

  // Each test names its own suite variable: the answer is cached per option set.

  it('lets a suite run when its explicit URL points at something listening — and caches that', () => {
    const options = { urlEnvVar: 'PROBE_SPEC_OPEN_TEST_DATABASE_URL' };
    const url = `postgres://u:p@127.0.0.1:${port}/companion`;

    const first = withEnv({ ...NO_DATABASE_ENV, [options.urlEnvVar]: url }, () =>
      databaseAvailability(options),
    );

    expect(first).toEqual({
      available: true,
      reason: `Postgres reachable at 127.0.0.1:${port}/companion`,
      target: `127.0.0.1:${port}/companion`,
    });

    // Cached: the same answer without asking again, even with the variable gone.
    expect(withEnv(NO_DATABASE_ENV, () => databaseAvailability(options))).toEqual(first);
  });

  it('THROWS, instead of skipping, when an explicit URL points at nothing', async () => {
    const options = { urlEnvVar: 'PROBE_SPEC_REFUSED_TEST_DATABASE_URL' };
    const closed = await closedPort();
    const ask = () =>
      withEnv(
        { ...NO_DATABASE_ENV, [options.urlEnvVar]: `postgres://u:p@127.0.0.1:${closed}/companion` },
        () => databaseAvailability(options),
      );

    expect(ask).toThrow(
      `Database-backed suite cannot run: PROBE_SPEC_REFUSED_TEST_DATABASE_URL points at 127.0.0.1:${closed}/companion, ` +
        'but nothing is accepting connections there (ECONNREFUSED).',
    );
    // A failure is cached too, and thrown every time it is asked for.
    expect(ask).toThrow(/cannot run/);
  });

  it('still skips, with the reason, when nothing is configured', () => {
    const options = { urlEnvVar: 'PROBE_SPEC_NONE_TEST_DATABASE_URL' };

    expect(withEnv(NO_DATABASE_ENV, () => databaseAvailability(options))).toEqual({
      available: false,
      reason: expect.stringMatching(
        /^no database configured — set PROBE_SPEC_NONE_TEST_DATABASE_URL or DATABASE_URL/,
      ),
      target: '(unset)',
    });
  });

  it("still skips when only the dev stack's own variables are set and the stack is down", async () => {
    const closed = await closedPort();
    const answer = withEnv(
      {
        ...NO_DATABASE_ENV,
        DATABASE_PASSWORD: 'dev',
        DATABASE_HOST: '127.0.0.1',
        DATABASE_PORT: String(closed),
      },
      () => databaseAvailability({ urlEnvVar: 'PROBE_SPEC_AMBIENT_TEST_DATABASE_URL' }),
    );

    expect(answer).toEqual({
      available: false,
      reason: expect.stringMatching(
        new RegExp(
          `^nothing accepting connections at 127\\.0\\.0\\.1:${closed}/companion \\(ECONNREFUSED\\)`,
        ),
      ),
      target: `127.0.0.1:${closed}/companion`,
    });
  });

  it('fails that same skip when the run set CI_REQUIRE_DB', async () => {
    const closed = await closedPort();

    expect(() =>
      withEnv(
        {
          ...NO_DATABASE_ENV,
          CI_REQUIRE_DB: '1',
          DATABASE_PASSWORD: 'dev',
          DATABASE_HOST: '127.0.0.1',
          DATABASE_PORT: String(closed),
        },
        () => databaseAvailability({ urlEnvVar: 'PROBE_SPEC_REQUIRED_TEST_DATABASE_URL' }),
      ),
    ).toThrow(
      /CI_REQUIRE_DB=1 forbids skipping the database-backed suite that reads PROBE_SPEC_REQUIRED_TEST_DATABASE_URL or DATABASE_URL/,
    );
  });
});

describe('a suite that names more than one database variable', () => {
  const none = new Set<string>();
  const options = { urlEnvVar: ['SCHEDULE_TEST_DATABASE_URL', 'PLANNING_TEST_DATABASE_URL'] as const };

  it('uses the first one that is set, then DATABASE_URL', () => {
    expect(
      resolveConfiguration(
        options,
        {
          SCHEDULE_TEST_DATABASE_URL: 'postgres://u:p@schedule:1/db',
          PLANNING_TEST_DATABASE_URL: 'postgres://u:p@planning:1/db',
        },
        none,
      ),
    ).toMatchObject({ variable: 'SCHEDULE_TEST_DATABASE_URL', connection: { host: 'schedule' } });
    expect(
      resolveConnection(options, { PLANNING_TEST_DATABASE_URL: 'postgres://u:p@planning:1/db' })?.host,
    ).toBe('planning');
    expect(resolveConnection(options, { DATABASE_URL: 'postgres://u:p@app:1/db' })?.host).toBe('app');
    expect(resolveConfiguration(options, {}, none)).toEqual({ kind: 'none' });
  });
});

describe('dataSourceConnection', () => {
  it('keeps the URL, query string included, when one was supplied', () => {
    expect(
      withEnv(
        { ...NO_DATABASE_ENV, NOTES_TEST_DATABASE_URL: 'postgres://u:p@db:5432/companion?sslmode=disable' },
        () => dataSourceConnection({ urlEnvVar: 'NOTES_TEST_DATABASE_URL' }),
      ),
    ).toEqual({ url: 'postgres://u:p@db:5432/companion?sslmode=disable' });
  });

  it('throws when the suite skipped the availability check and there is no connection', () => {
    expect(() =>
      withEnv(NO_DATABASE_ENV, () => dataSourceConnection({ urlEnvVar: 'NOTES_ABSENT_TEST_DATABASE_URL' })),
    ).toThrow(/resolveConnection\(\) found none \(NOTES_ABSENT_TEST_DATABASE_URL or DATABASE_URL\)/);
  });
});

describe('CI_REQUIRE_DB', () => {
  const missing: DatabaseAvailability = {
    available: false,
    reason: 'nothing accepting connections',
    target: '127.0.0.1:5999/companion',
  };
  const present: DatabaseAvailability = {
    available: true,
    reason: 'Postgres reachable',
    target: '127.0.0.1:5432/companion',
  };

  it('counts only 1 and true', () => {
    expect(databaseRequired({ CI_REQUIRE_DB: '1' })).toBe(true);
    expect(databaseRequired({ CI_REQUIRE_DB: 'true' })).toBe(true);
    expect(databaseRequired({ CI_REQUIRE_DB: '0' })).toBe(false);
    expect(databaseRequired({})).toBe(false);
  });

  it('throws for a skip under the switch and passes every other answer through', () => {
    expect(failIfRequired(present, 'a suite', { CI_REQUIRE_DB: '1' })).toBe(present);
    expect(failIfRequired(missing, 'a suite', {})).toBe(missing);
    expect(() =>
      failIfRequired(missing, 'the suite that reads SUITE_OVERRIDE_URL', { CI_REQUIRE_DB: '1' }),
    ).toThrow(/CI_REQUIRE_DB=1 forbids skipping the suite that reads SUITE_OVERRIDE_URL.*make test-db/s);
  });
});

import {
  PROBE_ATTEMPTS,
  PROBE_BACKOFF_MS,
  databaseAvailability,
  databaseRequired,
  dataSourceConnection,
  failIfRequired,
  isPortOpenWithRetry,
  resolveConnection,
  type DatabaseAvailability,
} from '../databaseConnection';
import { resolveAdminConnection, scratchDatabaseAvailability } from '../scratchDatabase';

/**
 * The fail-at-source contract: with `CI_REQUIRE_DB=1` a missing database THROWS
 * instead of turning into a `describe.skip`, and a database that is merely slow
 * to answer one probe is not mistaken for a missing one.
 *
 * Everything here injects its own environment, probe and sleep, so the answers
 * cannot depend on what the machine running the suite has listening — which is
 * also why this spec is safe to run under `CI_REQUIRE_DB=1` itself.
 */

const APP_URL = 'postgres://companion:s3cret@127.0.0.1:5999/companion?sslmode=disable';

/** A probe that answers from a script and records how it was called. */
function scriptedProbe(answers: boolean[]) {
  const calls: { host: string; port: number; timeoutMs: number }[] = [];
  const probe = (host: string, port: number, timeoutMs: number): boolean => {
    calls.push({ host, port, timeoutMs });

    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };

  return { probe, calls };
}

function recordingSleep() {
  const waits: number[] = [];

  return { sleep: (ms: number) => void waits.push(ms), waits };
}

describe('databaseRequired', () => {
  it.each(['1', 'true', 'TRUE', ' 1 ', 'True'])('treats %j as required', (value) => {
    expect(databaseRequired({ CI_REQUIRE_DB: value })).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'no', 'yes', '2'])('treats %j as NOT required', (value) => {
    expect(databaseRequired({ CI_REQUIRE_DB: value })).toBe(false);
  });
});

describe('failIfRequired', () => {
  const missing: DatabaseAvailability = {
    available: false,
    reason: 'nothing accepting connections at 127.0.0.1:5999/companion',
    target: '127.0.0.1:5999/companion',
  };
  const present: DatabaseAvailability = { available: true, reason: 'Postgres reachable', target: 'x' };

  it('passes an available answer through, required or not', () => {
    expect(failIfRequired(present, 'a suite', { CI_REQUIRE_DB: '1' })).toBe(present);
    expect(failIfRequired(present, 'a suite', {})).toBe(present);
  });

  it('passes an unavailable answer through when the database is not required (the skip stays a skip)', () => {
    expect(failIfRequired(missing, 'a suite', {})).toBe(missing);
    expect(failIfRequired(missing, 'a suite', { CI_REQUIRE_DB: '0' })).toBe(missing);
  });

  it('throws when the database is required, naming the switch, the suite, the reason, the target and the fix', () => {
    expect(() =>
      failIfRequired(missing, 'the suite that reads SUITE_OVERRIDE_URL', { CI_REQUIRE_DB: '1' }),
    ).toThrow(
      /CI_REQUIRE_DB=1 forbids skipping the suite that reads SUITE_OVERRIDE_URL.*nothing accepting connections.*target 127\.0\.0\.1:5999\/companion.*make test-db/s,
    );
  });
});

describe('isPortOpenWithRetry', () => {
  it('returns true on the first success without sleeping', () => {
    const { probe, calls } = scriptedProbe([true]);
    const { sleep, waits } = recordingSleep();

    expect(isPortOpenWithRetry('h', 1, 50, { probe, sleep })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('believes a later success: one blip is not "no database"', () => {
    const { probe, calls } = scriptedProbe([false, false, true]);
    const { sleep, waits } = recordingSleep();

    expect(isPortOpenWithRetry('h', 1, 50, { probe, sleep })).toBe(true);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([...PROBE_BACKOFF_MS]);
  });

  it(`gives up after ${PROBE_ATTEMPTS} failures, backing off between tries and never after the last`, () => {
    const { probe, calls } = scriptedProbe([false]);
    const { sleep, waits } = recordingSleep();

    expect(isPortOpenWithRetry('db.internal', 5432, 123, { probe, sleep })).toBe(false);
    expect(calls).toEqual(Array(PROBE_ATTEMPTS).fill({ host: 'db.internal', port: 5432, timeoutMs: 123 }));
    expect(waits).toHaveLength(PROBE_ATTEMPTS - 1);
    expect(waits).toEqual(PROBE_BACKOFF_MS.slice(0, PROBE_ATTEMPTS - 1));
  });

  it('keeps the total backoff short — the no-database case runs once per DB-backed spec file', () => {
    expect(PROBE_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_000);
  });
});

describe('resolveConnection with an injected environment', () => {
  it("parses a URL without ever exposing it through the discrete fields' defaults", () => {
    expect(resolveConnection({}, { DATABASE_URL: APP_URL })).toEqual({
      url: APP_URL,
      host: '127.0.0.1',
      port: 5999,
      username: 'companion',
      password: 's3cret',
      database: 'companion',
    });
  });

  it("prefers the suite's own variable over DATABASE_URL", () => {
    const env = { DATABASE_URL: APP_URL, SUITE_OVERRIDE_URL: 'postgres://u:p@other:1/db2' };

    expect(resolveConnection({ urlEnvVar: 'SUITE_OVERRIDE_URL' }, env)?.host).toBe('other');
  });

  it('takes the first SET variable of a list, then DATABASE_URL', () => {
    const options = { urlEnvVar: ['MEMORY_TEST_DATABASE_URL', 'PLANNING_TEST_DATABASE_URL'] };

    expect(
      resolveConnection(options, {
        MEMORY_TEST_DATABASE_URL: 'postgres://u:p@memory:1/db',
        PLANNING_TEST_DATABASE_URL: 'postgres://u:p@planning:1/db',
      })?.host,
    ).toBe('memory');
    expect(
      resolveConnection(options, { PLANNING_TEST_DATABASE_URL: 'postgres://u:p@planning:1/db' })?.host,
    ).toBe('planning');
    expect(resolveConnection(options, { DATABASE_URL: APP_URL })?.host).toBe('127.0.0.1');
    expect(resolveConnection(options, {})).toBeNull();
  });

  it('falls back to the discrete fields only when a password is set', () => {
    expect(resolveConnection({}, { DATABASE_HOST: 'h' })).toBeNull();
    expect(
      resolveConnection({}, { DATABASE_HOST: 'h', DATABASE_PASSWORD: 'pw', DATABASE_PORT: '6000' }),
    ).toEqual({
      host: 'h',
      port: 6000,
      username: 'companion',
      database: 'companion',
      password: 'pw',
    });
  });
});

describe('dataSourceConnection', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, saved);
  });

  it('returns the URL when one was supplied, so query parameters survive', () => {
    process.env.DS_OVERRIDE_URL = APP_URL;

    expect(dataSourceConnection({ urlEnvVar: 'DS_OVERRIDE_URL' })).toEqual({ url: APP_URL });
  });

  it('returns discrete fields when only DATABASE_PASSWORD is configured', () => {
    delete process.env.DATABASE_URL;
    delete process.env.DS_OVERRIDE_URL;
    process.env.DATABASE_PASSWORD = 'pw';
    process.env.DATABASE_HOST = 'somewhere';

    expect(dataSourceConnection({ urlEnvVar: 'DS_OVERRIDE_URL' })).toMatchObject({
      host: 'somewhere',
      password: 'pw',
    });
  });

  it('throws, naming the variables, when no connection resolves — a suite that skipped its own guard', () => {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PASSWORD;
    delete process.env.DS_OVERRIDE_URL;

    expect(() => dataSourceConnection({ urlEnvVar: 'DS_OVERRIDE_URL' })).toThrow(
      /DS_OVERRIDE_URL or DATABASE_URL/,
    );
  });
});

describe('databaseAvailability', () => {
  const OPTIONS = { urlEnvVar: 'ASKS_TEST_DATABASE_URL' };

  it('is available when the probe answers, and reports host:port/db without the password', () => {
    const { probe } = scriptedProbe([true]);
    const { sleep } = recordingSleep();
    const answer = databaseAvailability(OPTIONS, { env: { ASKS_TEST_DATABASE_URL: APP_URL }, probe, sleep });

    expect(answer.available).toBe(true);
    expect(answer.target).toBe('127.0.0.1:5999/companion');
    expect(JSON.stringify(answer)).not.toContain('s3cret');
  });

  it('is available when the first probe fails and a retry succeeds', () => {
    const { probe, calls } = scriptedProbe([false, true]);
    const { sleep } = recordingSleep();

    expect(databaseAvailability(OPTIONS, { env: { DATABASE_URL: APP_URL }, probe, sleep }).available).toBe(
      true,
    );
    expect(calls).toHaveLength(2);
  });

  describe('CI_REQUIRE_DB unset — the skip stays a skip', () => {
    it('reports "no database configured" without probing anything', () => {
      const { probe, calls } = scriptedProbe([true]);
      const answer = databaseAvailability(OPTIONS, { env: {}, probe, sleep: () => undefined });

      expect(answer).toMatchObject({ available: false, target: '(unset)' });
      expect(answer.reason).toMatch(/ASKS_TEST_DATABASE_URL or DATABASE_URL/);
      expect(calls).toHaveLength(0);
    });

    it('reports an unreachable database as unavailable after all the attempts', () => {
      const { probe, calls } = scriptedProbe([false]);
      const { sleep } = recordingSleep();
      const answer = databaseAvailability(OPTIONS, { env: { DATABASE_URL: APP_URL }, probe, sleep });

      expect(answer.available).toBe(false);
      expect(answer.reason).toMatch(
        /nothing accepting connections at 127\.0\.0\.1:5999\/companion.*3 attempts/,
      );
      expect(calls).toHaveLength(PROBE_ATTEMPTS);
    });
  });

  describe('CI_REQUIRE_DB=1 — the skip becomes a failure', () => {
    const required = { CI_REQUIRE_DB: '1' };

    it('throws when nothing is configured, naming the variables to set', () => {
      const { probe } = scriptedProbe([true]);

      expect(() => databaseAvailability(OPTIONS, { env: required, probe, sleep: () => undefined })).toThrow(
        /CI_REQUIRE_DB=1 forbids skipping the database-backed suite that reads ASKS_TEST_DATABASE_URL or DATABASE_URL.*no database configured/s,
      );
    });

    it('throws when the database is configured but unreachable, naming the target — after retrying', () => {
      const { probe, calls } = scriptedProbe([false]);
      const { sleep } = recordingSleep();

      expect(() =>
        databaseAvailability(OPTIONS, { env: { ...required, DATABASE_URL: APP_URL }, probe, sleep }),
      ).toThrow(/target 127\.0\.0\.1:5999\/companion/);
      expect(calls).toHaveLength(PROBE_ATTEMPTS);
    });

    it('does not throw when the database is there', () => {
      const { probe } = scriptedProbe([true]);

      expect(
        databaseAvailability(OPTIONS, {
          env: { ...required, DATABASE_URL: APP_URL },
          probe,
          sleep: () => undefined,
        }).available,
      ).toBe(true);
    });

    it('does not throw for a database that answers only on a retry', () => {
      const { probe } = scriptedProbe([false, false, true]);

      expect(
        databaseAvailability(OPTIONS, {
          env: { ...required, DATABASE_URL: APP_URL },
          probe,
          sleep: () => undefined,
        }).available,
      ).toBe(true);
    });

    it('never puts the password in the thrown message', () => {
      const { probe } = scriptedProbe([false]);

      try {
        databaseAvailability(OPTIONS, {
          env: { ...required, DATABASE_URL: APP_URL },
          probe,
          sleep: () => undefined,
        });
        throw new Error('expected databaseAvailability to throw');
      } catch (error) {
        expect((error as Error).message).not.toContain('s3cret');
      }
    });
  });

  it('does not cache an injected answer: two calls with different deps get their own', () => {
    const { sleep } = recordingSleep();
    const up = databaseAvailability(OPTIONS, { env: { DATABASE_URL: APP_URL }, probe: () => true, sleep });
    const down = databaseAvailability(OPTIONS, { env: { DATABASE_URL: APP_URL }, probe: () => false, sleep });

    expect([up.available, down.available]).toEqual([true, false]);
  });
});

describe('scratchDatabaseAvailability', () => {
  const ADMIN_ENV = { DATABASE_ADMIN_PASSWORD: 'adminpw', DATABASE_URL: APP_URL };

  it('resolves the admin connection from the injected environment only', () => {
    expect(resolveAdminConnection({})).toBeNull();
    expect(resolveAdminConnection(ADMIN_ENV)).toMatchObject({
      host: '127.0.0.1',
      port: 5999,
      username: 'postgres',
      password: 'adminpw',
      database: 'postgres',
    });
  });

  it('is unavailable with no admin connection, and throws under CI_REQUIRE_DB=1', () => {
    const deps = { probe: () => true, sleep: () => undefined };

    expect(scratchDatabaseAvailability({ env: {}, ...deps })).toMatchObject({
      available: false,
      target: '(unset)',
    });
    expect(() => scratchDatabaseAvailability({ env: { CI_REQUIRE_DB: '1' }, ...deps })).toThrow(
      /CI_REQUIRE_DB=1 forbids skipping the scratch-database suite.*DATABASE_ADMIN_PASSWORD/s,
    );
  });

  it('retries the probe, then reports unavailable — or throws under CI_REQUIRE_DB=1', () => {
    const { probe, calls } = scriptedProbe([false]);
    const { sleep } = recordingSleep();

    expect(scratchDatabaseAvailability({ env: ADMIN_ENV, probe, sleep }).available).toBe(false);
    expect(calls).toHaveLength(PROBE_ATTEMPTS);

    expect(() =>
      scratchDatabaseAvailability({ env: { ...ADMIN_ENV, CI_REQUIRE_DB: '1' }, probe, sleep }),
    ).toThrow(/nothing accepting connections at 127\.0\.0\.1:5999/);
  });

  it('is available when the server answers, including on a retry', () => {
    const { probe } = scriptedProbe([false, true]);

    expect(
      scratchDatabaseAvailability({
        env: { ...ADMIN_ENV, CI_REQUIRE_DB: '1' },
        probe,
        sleep: () => undefined,
      }),
    ).toMatchObject({ available: true, target: '127.0.0.1:5999' });
  });
});

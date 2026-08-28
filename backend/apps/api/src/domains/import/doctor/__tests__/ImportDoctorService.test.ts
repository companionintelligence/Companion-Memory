import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { DOCTOR_CHECKS } from '../checks';
import {
  clampTimeout,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  ImportDoctorService,
  TIMEOUT_BOUNDS,
} from '../ImportDoctorService';

/** Postgres's `query_canceled`, which is what `statement_timeout` raises. */
const canceled = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

interface FakeRunner {
  statements: string[];
  released: boolean;
}

/**
 * A DataSource whose query runner answers each check from `answers`, keyed by
 * check id — or throws, if the answer is an Error.
 *
 * The fake matches on the check's own SQL rather than on call order, so a test
 * that stubs two checks keeps working when a third is added to the registry
 * between them.
 */
function fakeDataSource(answers: Record<string, unknown[] | Error>): {
  dataSource: DataSource;
  runner: FakeRunner;
} {
  const runner: FakeRunner = { statements: [], released: false };

  const queryRunner = {
    connect: async () => undefined,
    release: async () => {
      runner.released = true;
    },
    query: async (sql: string) => {
      runner.statements.push(sql);

      const match = DOCTOR_CHECKS.find((check) => check.sql === sql);

      if (match == null) {
        // SET / RESET statement_timeout.
        return [];
      }

      const answer = answers[match.id];

      if (answer instanceof Error) {
        throw answer;
      }

      return answer ?? [{ count: '0' }];
    },
  };

  return {
    dataSource: { createQueryRunner: () => queryRunner } as unknown as DataSource,
    runner,
  };
}

const logger = { setContext: () => undefined, warn: () => undefined } as unknown as LoggerService;

describe('ImportDoctorService', () => {
  it('reports a clean suite as ok, with a finding per check', async () => {
    const { dataSource } = fakeDataSource({});
    const report = await new ImportDoctorService(dataSource, logger).run();

    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(DOCTOR_CHECKS.length);
    expect(report.totals.clean).toBe(DOCTOR_CHECKS.length);
    expect(report.findings.every((finding) => finding.status === 'clean')).toBe(true);
  });

  it('carries the count, breakdown and sample through for a check that found rows', async () => {
    // A HIGH check on purpose — the gate assertions below depend on it.
    const { dataSource } = fakeDataSource({
      'comms-missing-participants': [
        { count: '4', breakdown: { claude: 4 }, sample: { id: 'abc', source_system: 'claude' } },
      ],
    });

    const report = await new ImportDoctorService(dataSource, logger).run();
    const finding = report.findings.find((f) => f.id === 'comms-missing-participants');

    expect(finding).toMatchObject({
      status: 'found',
      count: 4,
      breakdown: { claude: 4 },
      sample: { id: 'abc', source_system: 'claude' },
    });
    // The check ships its own remedy, so a caller never has to look one up.
    expect(finding?.remedy.length).toBeGreaterThan(60);
    expect(report.ok).toBe(false);
    expect(report.totals.highFindings).toBe(1);
  });

  it('drops the breakdown and sample of a clean check rather than reporting empty aggregates', async () => {
    // Postgres returns NULL for `jsonb_object_agg` over no rows, and the fake
    // reproduces that. Normalizing keeps the JSON of a clean check uniform
    // whatever shape its statement happens to have.
    const { dataSource } = fakeDataSource({
      'comms-missing-thread-id': [{ count: '0', breakdown: null, sample: null }],
    });

    const report = await new ImportDoctorService(dataSource, logger).run();

    expect(report.findings.find((f) => f.id === 'comms-missing-thread-id')).toMatchObject({
      status: 'clean',
      count: 0,
      breakdown: null,
      sample: null,
    });
  });

  it('reports a timed-out check as TIMEOUT and keeps running the rest', async () => {
    // The whole reason the suite is nineteen statements and not one union: a
    // single slow check must cost one check, not the audit.
    const { dataSource } = fakeDataSource({
      'comms-placeholder-content': canceled(),
      'pipeline-dead-letters': [{ count: '8' }],
    });

    const report = await new ImportDoctorService(dataSource, logger).run();
    const timedOut = report.findings.find((f) => f.id === 'comms-placeholder-content');

    expect(timedOut).toMatchObject({ status: 'timeout', count: null });
    expect(timedOut?.error).toContain('statement timeout');
    expect(report.findings.find((f) => f.id === 'pipeline-dead-letters')).toMatchObject({
      status: 'found',
      count: 8,
    });
    expect(report.totals.timeout).toBe(1);
    expect(report.findings).toHaveLength(DOCTOR_CHECKS.length);
  });

  it('fails the gate when a HIGH check could not answer', () => {
    // "I could not look" is not "there is nothing there". A gate that treated
    // the two alike would pass precisely when the corpus grew big enough for
    // the checks to matter.
    const { dataSource } = fakeDataSource({ 'comms-placeholder-content': canceled() });

    return new ImportDoctorService(dataSource, logger).run().then((report) => {
      expect(report.ok).toBe(false);
      expect(report.totals.highFindings).toBe(0);
      expect(report.totals.highUnresolved).toBe(1);
    });
  });

  it('reports a broken statement as an error without taking the suite down', async () => {
    const { dataSource } = fakeDataSource({
      'pipeline-orphan-shards': new Error('relation "ci.pipeline_shards" does not exist'),
    });

    const report = await new ImportDoctorService(dataSource, logger).run();

    expect(report.findings.find((f) => f.id === 'pipeline-orphan-shards')).toMatchObject({
      status: 'error',
      count: null,
    });
    // MEDIUM, so a missing table on an older database does not fail the gate.
    expect(report.ok).toBe(true);
    expect(report.totals.error).toBe(1);
  });

  it('runs only the checks it was asked for', async () => {
    const { dataSource } = fakeDataSource({});
    const report = await new ImportDoctorService(dataSource, logger).run({
      checks: ['pipeline-dead-letters', 'person-duplicate-names'],
    });

    expect(report.findings.map((f) => f.id)).toEqual(['person-duplicate-names', 'pipeline-dead-letters']);
    // Registry order, not the caller's — the report reads as a walk down the
    // pipeline regardless of how the request was spelled.
  });

  it('sets the statement timeout and resets it before returning the connection', async () => {
    // A connection released to the pool still carrying a cap would break
    // unrelated queries elsewhere in the process, and look like a flaky
    // database rather than like this service.
    const { dataSource, runner } = fakeDataSource({});

    await new ImportDoctorService(dataSource, logger).run({ statementTimeoutMs: 4_000 });

    expect(runner.statements[0]).toBe('SET statement_timeout = 4000');
    expect(runner.statements.at(-1)).toBe('RESET statement_timeout');
    expect(runner.released).toBe(true);
  });

  it('resets and releases even when a check throws', async () => {
    const { dataSource, runner } = fakeDataSource({
      'comms-missing-thread-id': new Error('connection terminated'),
    });

    await new ImportDoctorService(dataSource, logger).run();

    expect(runner.statements.at(-1)).toBe('RESET statement_timeout');
    expect(runner.released).toBe(true);
  });
});

describe('clampTimeout', () => {
  it('defaults when given nothing or nonsense', () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
  });

  it('floors at the minimum, because Postgres reads 0 as "no timeout at all"', () => {
    // The dangerous direction: a caller asking for 0 to mean "be quick" would
    // otherwise get an uncapped statement and hang the request forever.
    expect(clampTimeout(0)).toBe(TIMEOUT_BOUNDS.min);
    expect(clampTimeout(-1)).toBe(TIMEOUT_BOUNDS.min);
  });

  it('caps the maximum and rounds to an integer', () => {
    expect(clampTimeout(9_999_999)).toBe(TIMEOUT_BOUNDS.max);
    expect(clampTimeout(1500.6)).toBe(1501);
  });
});

import { buildIndexHealth, type EntityIndexHealth } from '../EmbedCoverageTelemetryService';
import {
  BASELINE_LOOKBACK_DAYS,
  BASELINE_MAX_AGE_DAYS,
  buildRetrievalHealthAlerts,
  MAX_ALERTS_PER_RUN,
  REGRESSION_DROP,
  RETENTION_DAYS,
  RetrievalHealthService,
  type RetrievalHealthBaseline,
} from '../RetrievalHealthService';

/**
 * The derivation layer's failure mode is silence: a producer stops and nothing
 * says so. These specs pin the two halves of the cure — that the measurement is
 * PERSISTED (a number nobody can compare to last week is not a trend), and that
 * a type going dark becomes an alert rather than a log line.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-21T03:40:50.000Z');

function health(total: number, embedded: number, vectored: number): EntityIndexHealth {
  return buildIndexHealth(total, embedded, vectored);
}

function baseline(
  entityType: string,
  embedRatio: number,
  vectorRatio: number,
  ageDays = 7,
): RetrievalHealthBaseline {
  return {
    entityType,
    embedRatio,
    vectorRatio,
    capturedAt: new Date(NOW.getTime() - ageDays * DAY_MS),
  };
}

function makeService(options: { rows?: unknown[] } = {}) {
  const saved: unknown[] = [];

  const repository = {
    create: jest.fn((row: unknown) => row),
    save: jest.fn(async (rows: unknown[]) => {
      saved.push(...rows);

      return rows;
    }),
    find: jest.fn(async () => options.rows ?? []),
    delete: jest.fn(async () => ({ affected: 4 })),
  };

  const telemetry = {
    computeIndexHealth: jest.fn(async () => ({
      perType: {
        content: health(366862, 366862, 0),
        event: health(42376, 42376, 42376),
      },
      alarms: [],
      vectorAlarms: ['content'],
      underThreshold: [],
      divergent: ['content'],
      computedAt: NOW.toISOString(),
    })),
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new RetrievalHealthService(repository as never, telemetry as never, logger as never);

  return { service, repository, telemetry, logger, saved };
}

describe('RetrievalHealthService.capture', () => {
  it('reuses the existing coverage service rather than counting again', async () => {
    const { service, telemetry } = makeService();

    await service.capture(NOW);

    expect(telemetry.computeIndexHealth).toHaveBeenCalledTimes(1);
  });

  it('persists one row per type carrying BOTH index counts', async () => {
    const { service, saved } = makeService();

    const run = await service.capture(NOW);

    expect(run.persisted).toBe(2);
    expect(saved).toHaveLength(2);

    const content = saved.find((row) => (row as { entityType: string }).entityType === 'content');

    // Without vector_count on the row, next week's comparison could not tell
    // "fully embedded" from "fully embedded and invisible".
    expect(content).toMatchObject({
      runId: run.runId,
      entityType: 'content',
      sourceTotal: 366862,
      embeddedCount: 366862,
      vectorCount: 0,
      embedRatio: 1,
      vectorRatio: 0,
      embedAlarm: false,
      vectorAlarm: true,
      divergent: true,
    });
  });

  it('stamps every row of a run with one run id', async () => {
    const { service, saved } = makeService();

    const run = await service.capture(NOW);

    expect(saved.map((row) => (row as { runId: string }).runId)).toEqual([run.runId, run.runId]);
  });

  it('prunes snapshots past the retention horizon', async () => {
    const { service, repository } = makeService();

    const run = await service.capture(NOW);

    expect(run.pruned).toBe(4);

    const [criteria] = repository.delete.mock.calls[0] as unknown as [{ capturedAt: { value: Date } }];
    const cutoff = criteria.capturedAt.value;

    expect(cutoff.getTime()).toBe(NOW.getTime() - RETENTION_DAYS * DAY_MS);
  });
});

describe('RetrievalHealthService.loadBaselines', () => {
  it('reads only the window between the lookback and the max age', async () => {
    const { service, repository } = makeService();

    await service.loadBaselines(NOW);

    const [args] = repository.find.mock.calls[0] as unknown as [{ where: { capturedAt: { value: Date[] } } }];
    const [from, to] = args.where.capturedAt.value;

    expect(from.getTime()).toBe(NOW.getTime() - BASELINE_MAX_AGE_DAYS * DAY_MS);
    expect(to.getTime()).toBe(NOW.getTime() - BASELINE_LOOKBACK_DAYS * DAY_MS);
  });

  it('keeps the newest reading per type inside that window', async () => {
    const older = {
      entityType: 'content',
      capturedAt: new Date(NOW.getTime() - 13 * DAY_MS),
      embedRatio: 0.2,
      vectorRatio: 0.2,
    };
    const newer = {
      entityType: 'content',
      capturedAt: new Date(NOW.getTime() - 8 * DAY_MS),
      embedRatio: 0.99,
      vectorRatio: 0.98,
    };

    // The repository is asked for ascending order, so the newest arrives last.
    const { service } = makeService({ rows: [older, newer] });

    const baselines = await service.loadBaselines(NOW);

    expect(baselines.content.embedRatio).toBe(0.99);
    expect(baselines.content.capturedAt).toEqual(newer.capturedAt);
  });
});

describe('buildRetrievalHealthAlerts', () => {
  it('raises the documented incident: fully embedded, zero vectors, invisible to search', () => {
    const alerts = buildRetrievalHealthAlerts({ content: health(366862, 366862, 0) }, {});

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      entityType: 'content',
      reason: 'vector_zero',
      key: 'retrieval_health:content:vector_zero',
    });
    expect(alerts[0].text).toContain('366,862');
    expect(alerts[0].detail).toMatchObject({ embedded: 366862, vectored: 0 });
  });

  it('says nothing about a type that has no source rows', () => {
    expect(buildRetrievalHealthAlerts({ receipt: health(0, 0, 0) }, {})).toEqual([]);
  });

  it('says nothing about a healthy type', () => {
    expect(buildRetrievalHealthAlerts({ event: health(1000, 1000, 1000) }, {})).toEqual([]);
  });

  it('raises embed_zero when embeddings are the missing half', () => {
    const alerts = buildRetrievalHealthAlerts({ note: health(500, 0, 500) }, {});

    expect(alerts.map((alert) => alert.reason)).toEqual(['embed_zero']);
  });

  it('does not also raise divergence for a type already reported as a zero hole', () => {
    // vectored 0 makes divergence 1, but two cards about one fact is noise.
    const alerts = buildRetrievalHealthAlerts({ content: health(1000, 1000, 0) }, {});

    expect(alerts.map((alert) => alert.reason)).toEqual(['vector_zero']);
  });

  it('raises divergence when both halves exist but disagree', () => {
    const alerts = buildRetrievalHealthAlerts({ item: health(1000, 1000, 400) }, {});

    expect(alerts.map((alert) => alert.reason)).toEqual(['index_divergence']);
  });

  it('raises a week-over-week regression when coverage falls materially', () => {
    const alerts = buildRetrievalHealthAlerts(
      { event: health(10000, 5000, 5000) },
      { event: baseline('event', 0.98, 0.98) },
    );

    expect(alerts.map((alert) => alert.reason)).toEqual(['coverage_regression']);
    expect(alerts[0].detail).toMatchObject({ baselineEmbedRatio: 0.98, embedRatio: 0.5 });
  });

  it('ignores a drop smaller than the regression threshold', () => {
    const drop = REGRESSION_DROP / 2;
    const alerts = buildRetrievalHealthAlerts(
      { event: health(10000, Math.round(10000 * (1 - drop)), Math.round(10000 * (1 - drop))) },
      { event: baseline('event', 1, 1) },
    );

    expect(alerts).toEqual([]);
  });

  it('catches a regression the vector side alone shows', () => {
    // Embeddings held steady; vectors halved. Coverage looks fine on the side
    // the old report measured, and search got twice as bad.
    const alerts = buildRetrievalHealthAlerts(
      { event: health(10000, 10000, 5000) },
      { event: baseline('event', 1, 1) },
    );

    expect(alerts.map((alert) => alert.reason)).toEqual(
      expect.arrayContaining(['coverage_regression', 'index_divergence']),
    );
  });

  it('never raises more than the per-run cap, worst first', () => {
    const perType = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((type) => [type, health(1000, 1000, 0)]),
    );
    // One type is worse still: it has neither half of the index.
    perType.z = health(1000, 0, 0);

    const alerts = buildRetrievalHealthAlerts(perType, {});

    expect(alerts).toHaveLength(MAX_ALERTS_PER_RUN);
    expect(alerts.every((alert) => alert.reason === 'vector_zero')).toBe(true);
  });

  it('orders vector holes ahead of divergence', () => {
    const alerts = buildRetrievalHealthAlerts(
      { diverged: health(1000, 1000, 500), dark: health(1000, 1000, 0) },
      {},
    );

    expect(alerts.map((alert) => alert.reason)).toEqual(['vector_zero', 'index_divergence']);
  });
});

import { DataSource, type QueryRunner } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import {
  EVENT_LIFECYCLE_CASES,
  EVENT_STATUSES,
  eventStatusVocabulary,
  readEventLocations,
  seedLifecycleCases,
  WHERE_IT_WAS_TO_BE,
  WHERE_THE_USER_WAS,
  type EventLocation,
  type SeededLifecycleCase,
} from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import {
  DEFAULT_ESTIMATE_SOURCE_SYSTEMS,
  DEFAULT_MAX_GAP_HOURS,
  LocationEstimateService,
} from '../LocationEstimateService';

/**
 * The legacy sweep (`POST /api/maintenance/estimate-locations`, the
 * `estimate_locations` self-heal leg) held to the rule `enrich.estimate_location`
 * v3 follows: an event that did not happen neither lends a coordinate nor
 * receives one. Same cases, same fixtures, from
 * `domains/__tests__/support/eventLifecycleFixtures.ts`. See
 * `pipeline/stages/__tests__/EstimateLocationDidNotHappen.integration.spec.ts`
 * for the stage.
 *
 * The service states the rule three times, and each copy is checked here: the
 * candidate filter, the donor `EXISTS` that keeps `countCandidates` exact, and
 * the donor `LATERAL` that picks the coordinate. The orphan blocks are what
 * catch a stale `EXISTS`: a candidate whose only neighbour did not happen is
 * counted but never filled.
 *
 * Filled rows are read back from the table rather than from `estimated`.
 * On main that count is `.length` of TypeORM's `[rows, rowCount]` pair, so it
 * reports 2 for every batch.
 *
 * Everything runs in one transaction that is always rolled back.
 */

const availability = databaseAvailability();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/LocationEstimateDidNotHappen.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

const NOWHERE: EventLocation = { lat: null, lng: null, locationSource: null, donorId: null };

describeWithDb(`LocationEstimateService: events that did not happen (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let schemaLock: SchemaLock | null = null;

  let seeded: SeededLifecycleCase[];
  /** `countCandidates`, before the batch. */
  let counted: number;
  let locations: Map<string, EventLocation>;

  const query = (sql: string, params?: unknown[]): Promise<unknown> => runner.query(sql, params);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(),
      entities: [],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'maintenance/LocationEstimateDidNotHappen.integration',
    );
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    const userId = await createSyntheticTestUser(query, 'LocationEstimateDidNotHappen');
    seeded = await seedLifecycleCases(query, userId);

    const service = new LocationEstimateService({ query } as never, noopLogger);
    const sourceSystems = [...DEFAULT_ESTIMATE_SOURCE_SYSTEMS];

    counted = await service.countCandidates(userId, sourceSystems, DEFAULT_MAX_GAP_HOURS * 3600);
    await service.estimateBatch(userId, { limit: 1000, maxGapHours: DEFAULT_MAX_GAP_HOURS, sourceSystems });

    locations = await readEventLocations(
      query,
      seeded.flatMap((s) => [s.candidate, s.target, s.orphan]),
    );
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    await schemaLock?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const byName = (name: string): SeededLifecycleCase => seeded.find((s) => s.case.name === name)!;
  const cases = EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const);

  it('classifies every status ci.events allows', async () => {
    expect([...(await eventStatusVocabulary(query))].sort()).toEqual([...EVENT_STATUSES].sort());
  });

  it('counts exactly the candidates it fills', () => {
    // Every candidate always has its fallback, so only the orphans, whose one
    // neighbour is the case's event, can tell a stale EXISTS from the LATERAL.
    const filled = [...locations.values()].filter((l) => l.locationSource === 'estimated').length;
    const happened = EVENT_LIFECYCLE_CASES.filter((c) => c.happened).length;

    expect(filled).toBe(EVENT_LIFECYCLE_CASES.length + 2 * happened);
    expect(counted).toBe(filled);
  });

  it.each(cases)('%s (happened: %s), as a donor, lends its coordinate only if it happened', (name) => {
    const s = byName(name);
    const expected = s.case.happened
      ? { donorId: s.donor, point: WHERE_IT_WAS_TO_BE }
      : { donorId: s.fallback, point: WHERE_THE_USER_WAS };
    const location = locations.get(s.candidate)!;

    expect(location).toMatchObject({ locationSource: 'estimated', donorId: expected.donorId });
    expect(location.lat).toBeCloseTo(expected.point.lat, 6);
    expect(location.lng).toBeCloseTo(expected.point.lng, 6);
  });

  it.each(cases)('%s (happened: %s), as the only neighbour, locates it only if it happened', (name) => {
    const s = byName(name);

    expect(locations.get(s.orphan)).toEqual(
      s.case.happened
        ? expect.objectContaining({ locationSource: 'estimated', donorId: s.orphanDonor })
        : NOWHERE,
    );
  });

  it.each(cases)('%s (happened: %s), as a target, receives an estimate only if it happened', (name) => {
    const s = byName(name);

    expect(locations.get(s.target)).toEqual(
      s.case.happened ? expect.objectContaining({ locationSource: 'estimated', donorId: s.donor }) : NOWHERE,
    );
  });
});

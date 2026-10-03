import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import {
  EVENT_LIFECYCLE_CASES,
  EVENT_STATUSES,
  eventStatusVocabulary,
  HAPPENED,
  insertEvent,
  readEventLocations,
  seedLifecycleCases,
  WHERE_IT_WAS_TO_BE,
  WHERE_THE_USER_WAS,
  type EventLocation,
  type SeededLifecycleCase,
} from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import {
  ENRICH_ESTIMATE_LOCATION_STAGE_ID,
  ESTIMATE_LOCATION_VERSION,
  EstimateLocationStage,
} from '../enrich/EstimateLocationStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EVENT THAT DID NOT HAPPEN NEITHER LENDS A COORDINATE NOR RECEIVES ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `enrich.estimate_location` v1 and v2 refused only a DELETED donor. A cancelled
 * meeting whose venue `enrich.geocode` had resolved, a no-show, a skipped
 * block, a prediction, or a Takeout reservation cancelled in its metadata
 * could each lend its coordinate to the nearest unlocated event. The target
 * side refused deleted and predicted rows but estimated a cancelled one.
 *
 * v3 applies one rule, `eventHappenedSql`, on both sides. What only a real
 * database can show, and a stubbed `query` agrees with unconditionally:
 *
 *  1. every status `ci.events` allows is classified (the shared case table is
 *     checked against the live CHECK constraint);
 *  2. as a donor, each kind of event that did not happen loses to a farther
 *     event that did, and on its own leaves its neighbour unlocated, while
 *     each near miss (`is_predicted` NULL, `Canceled: false`, `tentative`,
 *     `rescheduled`, …) still lends;
 *  3. as a target, the sweep does not offer it, and a slice that carries it
 *     anyway (called off between sweep and slice) records a skip and writes
 *     nothing;
 *  4. the bump re-derives an earlier estimate that was copied from a cancelled
 *     donor, through the real ledger;
 *  5. where no donor that happened is left, the earlier estimate stays. This stage
 *     never withdraws a coordinate. The test pins that, so the limit is
 *     visible rather than assumed.
 *
 * The legacy `LocationEstimateService` is held to the same cases in
 * `maintenance/services/__tests__/LocationEstimateDidNotHappen.integration.spec.ts`.
 *
 * Everything runs in one transaction that is always rolled back. Opt-in like
 * its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or `DATABASE_URL`) to a
 * migrated database, or run `make test-db ARGS=EstimateLocationDidNotHappen`.
 */

const DATABASE_ENV = { urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/EstimateLocationDidNotHappen.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** Why the stage declines a target that did not happen, by the column that says so. */
function declineReason({ lifecycle }: SeededLifecycleCase['case']): string {
  if (lifecycle.isDeleted) {
    return 'event_deleted';
  }

  return lifecycle.isPredicted === true ? 'predicted_event' : 'event_did_not_happen';
}

describeWithDb(`enrich.estimate_location v3: events that did not happen (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let schemaLock: SchemaLock | null = null;

  let ctx: UserServiceContext;
  let seeded: SeededLifecycleCase[];
  /** What the sweep offered, before anything ran. */
  let offered: Set<string>;
  /** One slice over every unlocated seeded event, as the pipeline would dispatch it. */
  let results: Map<string, StageResult>;
  let locations: Map<string, EventLocation>;

  const query = (sql: string, params?: unknown[]): Promise<unknown> => runner.query(sql, params);
  const transactional = { query } as never;
  const stage = () => new EstimateLocationStage(transactional, makeLogger() as never);
  const ledger = () => new PipelineStateService(transactional, makeLogger() as never);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    // SHARED: the transaction below row-locks shared ci.* tables for the length
    // of the suite. This only ever waits on a suite applying a migration.
    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'pipeline/EstimateLocationDidNotHappen.integration',
    );
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ctx = {
      userId: await createSyntheticTestUser(query, 'EstimateLocationDidNotHappen'),
    } as UserServiceContext;
    seeded = await seedLifecycleCases(query, ctx.userId);

    offered = new Set(await ledger().selectStale(stage(), ctx.userId, null, 1000));

    const unlocated = seeded.flatMap((s) => [s.candidate, s.target, s.orphan]);
    results = await stage().run(ctx, unlocated);
    locations = await readEventLocations(query, unlocated);
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    // Before `destroy()`: the lock is held on a connection from this pool.
    await schemaLock?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('classifies every status ci.events allows', async () => {
    // A status added to the CHECK constraint fails here until the case table
    // says whether an event carrying it happened.
    expect([...(await eventStatusVocabulary(query))].sort()).toEqual([...EVENT_STATUSES].sort());
  });

  describe('as a donor', () => {
    it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
      '%s (happened: %s) lends its coordinate only if it happened',
      (name) => {
        const s = seeded.find((candidate) => candidate.case.name === name)!;
        const expected = s.case.happened
          ? { donorId: s.donor, point: WHERE_IT_WAS_TO_BE }
          : { donorId: s.fallback, point: WHERE_THE_USER_WAS };

        // The case's event is 5 minutes away and the fallback 60, so the nearer
        // one wins unless the rule refuses it.
        expect(results.get(s.candidate)).toMatchObject({
          outcome: 'done',
          detail: { donor: 'event', donorId: expected.donorId },
        });

        const location = locations.get(s.candidate)!;
        expect(location).toMatchObject({ locationSource: 'estimated', donorId: expected.donorId });
        expect(location.lat).toBeCloseTo(expected.point.lat, 6);
        expect(location.lng).toBeCloseTo(expected.point.lng, 6);
      },
    );

    it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
      '%s (happened: %s), as the only neighbour, locates it only if it happened',
      (name) => {
        const s = seeded.find((candidate) => candidate.case.name === name)!;

        if (s.case.happened) {
          expect(results.get(s.orphan)).toMatchObject({
            outcome: 'done',
            detail: { donorId: s.orphanDonor },
          });
          expect(locations.get(s.orphan)).toMatchObject({
            locationSource: 'estimated',
            donorId: s.orphanDonor,
          });
        } else {
          expect(results.get(s.orphan)).toEqual({ outcome: 'skipped', reason: 'no_donor_in_window' });
          expect(locations.get(s.orphan)).toEqual({
            lat: null,
            lng: null,
            locationSource: null,
            donorId: null,
          });
        }
      },
    );
  });

  describe('as a target', () => {
    it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
      '%s (happened: %s) is offered by the sweep only if it happened',
      (name, happened) => {
        const s = seeded.find((candidate) => candidate.case.name === name)!;

        // The applicability predicate, evaluated by Postgres. The events that
        // happened around it are offered either way.
        expect(offered.has(s.target)).toBe(happened);
        expect(offered.has(s.candidate)).toBe(true);
        expect(offered.has(s.fallback)).toBe(true);
      },
    );

    it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
      '%s (happened: %s) receives an estimate only if it happened, even in a slice',
      (name) => {
        const s = seeded.find((candidate) => candidate.case.name === name)!;

        if (s.case.happened) {
          // Its own event 5 minutes earlier, which happened too, is the nearest.
          expect(results.get(s.target)).toMatchObject({ outcome: 'done', detail: { donorId: s.donor } });
          expect(locations.get(s.target)).toMatchObject({ locationSource: 'estimated', donorId: s.donor });
        } else {
          // Not offered by the sweep (above), so reaching the slice means it
          // was called off after the sweep. The slice still refuses it.
          expect(results.get(s.target)).toEqual({ outcome: 'skipped', reason: declineReason(s.case) });
          expect(locations.get(s.target)).toEqual({
            lat: null,
            lng: null,
            locationSource: null,
            donorId: null,
          });
        }
      },
    );
  });

  describe('the bump', () => {
    /**
     * An estimate as an earlier generation wrote it: copied from a cancelled meeting's
     * geocoded venue, and recorded `done` at the version before this one.
     */
    async function seedEarlierEstimate(args: { withFallback: boolean; at: string }) {
      const ids = { estimated: randomUUID(), cancelled: randomUUID(), fallback: randomUUID() };
      const at = Date.parse(args.at);
      const minute = 60_000;

      await insertEvent(query, ctx.userId, {
        id: ids.estimated,
        title: 'Standup',
        at,
        lifecycle: HAPPENED,
        point: null,
      });
      await query(
        `UPDATE ci.events
            SET location_coordinates = ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)::geography,
                is_inferred = true,
                confidence_score = 0.4,
                metadata = metadata || '{"location_source": "estimated"}'::jsonb,
                inference_sources = jsonb_build_object('method', 'temporal_nn', 'donor', 'event',
                                                       'donor_id', $4::text, 'delta_seconds', 300,
                                                       'accuracy_meters', NULL, 'max_gap_hours', 24)
          WHERE event_id = $1`,
        [ids.estimated, WHERE_IT_WAS_TO_BE.lng, WHERE_IT_WAS_TO_BE.lat, ids.cancelled],
      );
      await insertEvent(query, ctx.userId, {
        id: ids.cancelled,
        title: 'Pottery class',
        at: at + 5 * minute,
        lifecycle: { ...HAPPENED, status: 'cancelled' },
        point: WHERE_IT_WAS_TO_BE,
      });

      if (args.withFallback) {
        await insertEvent(query, ctx.userId, {
          id: ids.fallback,
          title: 'Lunch',
          at: at + 60 * minute,
          lifecycle: HAPPENED,
          point: WHERE_THE_USER_WAS,
        });
      }

      const earlier = { id: ENRICH_ESTIMATE_LOCATION_STAGE_ID, version: ESTIMATE_LOCATION_VERSION - 1 };
      await ledger().claim(earlier, 'event', [ids.estimated], ctx.userId);
      await ledger().complete(
        earlier,
        'event',
        new Map<string, StageResult>([[ids.estimated, { outcome: 'done', confidence: 0.4 }]]),
      );

      return ids;
    }

    /** The sweep, claim, run and complete, for one id. */
    async function sweepAndRun(id: string): Promise<StageResult | undefined> {
      const real = stage();
      const stale = await ledger().selectStale(real, ctx.userId, null, 1000);

      expect(stale).toContain(id);

      const claimed = await ledger().claim(real, 'event', [id], ctx.userId);
      const outcome = await real.run(ctx, claimed);
      await ledger().complete(real, 'event', outcome);

      return outcome.get(id);
    }

    async function ledgerRow(id: string) {
      const [row] = (await query(
        `SELECT status, reason, stage_version FROM ci.pipeline_state
          WHERE entity_type = 'event' AND entity_id = $1 AND stage = $2`,
        [id, ENRICH_ESTIMATE_LOCATION_STAGE_ID],
      )) as Array<{ status: string; reason: string | null; stage_version: number }>;

      return row;
    }

    it('re-derives an earlier estimate copied from a cancelled donor', async () => {
      const ids = await seedEarlierEstimate({ withFallback: true, at: '2021-03-02T16:00:00Z' });

      expect(await sweepAndRun(ids.estimated)).toMatchObject({
        outcome: 'done',
        detail: { donor: 'event', donorId: ids.fallback },
      });

      const location = (await readEventLocations(query, [ids.estimated])).get(ids.estimated)!;
      expect(location).toMatchObject({ locationSource: 'estimated', donorId: ids.fallback });
      expect(location.lat).toBeCloseTo(WHERE_THE_USER_WAS.lat, 6);
      expect(location.lng).toBeCloseTo(WHERE_THE_USER_WAS.lng, 6);
      expect(await ledgerRow(ids.estimated)).toEqual({
        status: 'done',
        reason: null,
        stage_version: ESTIMATE_LOCATION_VERSION,
      });
    });

    it('keeps an earlier estimate when no donor that happened is left, and records no donor', async () => {
      // THE RESIDUE, pinned so it is a known limit rather than an assumption.
      // The stage only ever writes a donor's coordinate; it never clears one,
      // so a row whose only donor was refused keeps what was copied. On the
      // reference corpus no estimate had an event donor, so no row was left
      // like this. A change that withdraws such estimates has to change this
      // test, deliberately.
      const ids = await seedEarlierEstimate({ withFallback: false, at: '2021-03-16T16:00:00Z' });

      expect(await sweepAndRun(ids.estimated)).toEqual({ outcome: 'skipped', reason: 'no_donor_in_window' });
      expect((await readEventLocations(query, [ids.estimated])).get(ids.estimated)).toMatchObject({
        locationSource: 'estimated',
        donorId: ids.cancelled,
      });
      expect(await ledgerRow(ids.estimated)).toEqual({
        status: 'skipped',
        reason: 'no_donor_in_window',
        stage_version: ESTIMATE_LOCATION_VERSION,
      });
    });
  });
});

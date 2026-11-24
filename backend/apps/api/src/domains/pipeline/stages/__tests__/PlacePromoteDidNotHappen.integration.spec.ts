import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { DeterministicEdgeBackfillService } from '@ci/domains/maintenance';
import { GraphDeltaWriter } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import {
  EVENT_LIFECYCLE_CASES,
  EVENT_STATUSES,
  eventStatusVocabulary,
  HAPPENED,
  insertEvent,
  type EventLifecycle,
  type LifecycleCase,
} from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PIPELINE_QUEUES } from '../../constants';
import { PipelineSliceListener } from '../../listeners/PipelineSliceListener';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { Stage } from '../../types';
import { EventEdgePromoteStage } from '../promote/EdgePromoteStage';
import {
  PLACE_UNCERTAINTY_FLOOR_METRES,
  PROMOTE_PLACE_STAGE_ID,
  PROMOTE_PLACE_VERSION,
  PlacePromoteStage,
} from '../promote/PlacePromoteStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EVENT THAT DID NOT HAPPEN IS NOT A VISIT TO ITS VENUE. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `promote.place` linked any undeleted event with a coordinate and a name to a
 * Location. A meeting cancelled at the source keeps its venue, and
 * `enrich.geocode` resolves it, so the link counted the meeting as a visit,
 * put it in the place's footprint, and let `promote.edge_event` project
 * Event −LOCATED_AT→ Place (`event.happened_at`). The stage now applies
 * `eventHappenedSql`, the rule `enrich.estimate_location` applies, as
 * applicability. What only a real database can show, and a stubbed `query`
 * agrees with unconditionally:
 *
 *  1. every status `ci.events` allows is classified (the shared case table is
 *     checked against the live CHECK constraint);
 *  2. the sweep offers no kind of event that did not happen, and offers every
 *     near miss (`is_predicted` NULL, `Canceled: false`, `tentative`, …);
 *  3. a slice that carries one anyway (called off between the sweep and the
 *     slice) records a skip, mints no place and writes no link, so the edge
 *     leg projects no `event.happened_at` edge and no footprint grows;
 *  4. why it is applicability: a cancelled event that is reinstated is offered
 *     again with no bump, where a recorded skip waits for one;
 *  5. the limit: a link written while the event was live stays when it is
 *     cancelled afterwards. Migration
 *     `20261001153044_withdraw_place_links_from_events_that_did_not_happen`
 *     withdrew the ones written before this rule; its spec is
 *     `PlaceLinkDidNotHappenRepair.integration.spec.ts`.
 *
 * Everything runs through the real `PipelineSliceListener`,
 * `PipelineStateService`, `PlacePromoteStage`, `EventEdgePromoteStage` and
 * `DeterministicEdgeBackfillService`. The one stand-in is `PlaceService`, as in
 * `PlaceLinkReopensEdgeEvent.integration.spec.ts`: it mints one Location per
 * venue name, for real, and so also records which venues it was asked for.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a migrated database, or run
 * `make test-db ARGS=PlacePromoteDidNotHappen`. Every fixture belongs to a
 * synthetic user and is deleted in `afterAll`.
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PlacePromoteDidNotHappen.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** One venue per seeded event, a dedupe cell apart, so no two share a Location by accident. */
const venue = (n: number) => ({ lat: -42 - n * 0.05, lng: -32 - n * 0.05 });

/** Any fixed hour: the stage never reads the time. */
const AT = Date.parse('2019-02-04T15:00:00Z');

const caseNamed = (name: string): LifecycleCase => EVENT_LIFECYCLE_CASES.find((c) => c.name === name)!;

/** Why the stage declines a slice row that did not happen, by the column that says so. */
function declineReason({ lifecycle }: LifecycleCase): string {
  return lifecycle.isDeleted ? 'event_deleted' : 'event_did_not_happen';
}

interface Seeded {
  id: string;
  venueName: string;
}

describeWithDb(`promote.place: events that did not happen (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let ctx: UserServiceContext;

  let ledger: PipelineStateService;
  let placeStage: PlacePromoteStage;
  let edgeStage: EventEdgePromoteStage;
  let worker: PipelineSliceListener;

  /** Location ids the `PlaceService` stand-in minted, by venue name. */
  const placesByName = new Map<string, string>();
  let venues = 0;

  /** One located, named event per lifecycle case. */
  const byCase = new Map<string, Seeded>();
  /** What the promote.place sweep offered, before anything ran. */
  let offered: Set<string>;

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);

  /** A located event with a venue name of its own, at a venue no other seeded event uses. */
  async function seedEvent(
    title: string,
    lifecycle: EventLifecycle,
    at: { lat: number; lng: number } = venue((venues += 1)),
    venueName = `${title} venue`,
  ): Promise<Seeded> {
    const id = uuidv7();

    await insertEvent(query, ctx.userId, {
      id,
      title,
      at: AT,
      lifecycle,
      point: at,
      locationName: venueName,
    });

    return { id, venueName };
  }

  /** One slice through the real worker, exactly as a dispatched job arrives. */
  async function runSlice(stage: Stage, ids: string[]): Promise<void> {
    await worker.handleSlice(PIPELINE_QUEUES.INDEX, {
      stage: stage.id,
      entityType: 'event',
      userId: ctx.userId,
      ids,
    });
  }

  const offeredTo = async (stage: Stage): Promise<Set<string>> =>
    new Set(await ledger.selectStale(stage, ctx.userId, null, 1000));

  async function ledgerRow(eventId: string) {
    const [row] = (await query(
      `SELECT status, reason, stage_version FROM ci.pipeline_state
        WHERE entity_type = 'event' AND entity_id = $1 AND stage = $2`,
      [eventId, PROMOTE_PLACE_STAGE_ID],
    )) as Array<{ status: string; reason: string | null; stage_version: number }>;

    return row;
  }

  /** The link and its provenance, as `PlaceService.getVisitStats` and the edge leg read it. */
  async function link(eventId: string) {
    const [row] = (await query(
      `SELECT location_entity_id, metadata->'promote'->>'stage' AS promoted_by
         FROM ci.events WHERE event_id = $1`,
      [eventId],
    )) as Array<{ location_entity_id: string | null; promoted_by: string | null }>;

    return row;
  }

  async function happenedAtEdges(eventId: string) {
    return (await query(
      `SELECT to_entity_id FROM ci.relationships
        WHERE owner_user_id = $1
          AND from_entity_id = $2
          AND relationship_type = 'LOCATED_AT'
          AND properties->>'rule' = 'event.happened_at'
          AND is_active`,
      [ctx.userId, eventId],
    )) as Array<{ to_entity_id: string }>;
  }

  /** A Location's footprint, as an effective radius, and whose it is. */
  async function footprint(placeId: string) {
    const [row] = (await query(
      `SELECT sqrt(ST_Area(location_boundary) / pi()) AS radius_m,
              properties->'promote'->>'stage'          AS stage
         FROM ci.entities WHERE entity_id = $1`,
      [placeId],
    )) as Array<{ radius_m: number | null; stage: string | null }>;

    return { radiusM: row.radius_m == null ? null : Number(row.radius_m), stage: row.stage };
  }

  const linkedTo = (seeded: Seeded) => ({
    location_entity_id: placesByName.get(seeded.venueName),
    promoted_by: PROMOTE_PLACE_STAGE_ID,
  });
  const UNLINKED = { location_entity_id: null, promoted_by: null };

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/PlacePromoteDidNotHappen.integration');

    ctx = {
      userId: await createSyntheticTestUser(query, 'PlacePromoteDidNotHappen'),
    } as UserServiceContext;

    const logger = () => makeLogger() as never;

    ledger = new PipelineStateService(dataSource, logger());
    edgeStage = new EventEdgePromoteStage(
      new DeterministicEdgeBackfillService(dataSource, new GraphDeltaWriter(dataSource, logger()), logger()),
      logger(),
    );
    placeStage = new PlacePromoteStage(
      dataSource,
      {
        // Mints one Location per venue name, for real, so the link and the
        // footprint write have a row to land on.
        findOrCreateForGeocode: async (_ctx: unknown, input: { name: string; lat: number; lng: number }) => {
          const existing = placesByName.get(input.name);

          if (existing != null) {
            return { id: existing, created: false };
          }

          const placeId = uuidv7();

          await dataSource.query(
            `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point, place_kind)
             VALUES ($1, 'Location', $2, $3, '{}'::jsonb,
                     ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, 'address')`,
            [placeId, ctx.userId, input.name, input.lng, input.lat],
          );
          placesByName.set(input.name, placeId);

          return { id: placeId, created: true };
        },
      } as never,
      logger(),
    );

    const stages = new Map<string, Stage>([
      [edgeStage.id, edgeStage],
      [placeStage.id, placeStage],
    ]);

    worker = new PipelineSliceListener(
      {
        get: (stageId: string) => {
          const stage = stages.get(stageId);

          if (stage == null) {
            throw new Error(`Unknown pipeline stage "${stageId}".`);
          }

          return stage;
        },
      } as never,
      ledger,
      logger(),
    );

    for (const lifecycleCase of EVENT_LIFECYCLE_CASES) {
      byCase.set(lifecycleCase.name, await seedEvent(lifecycleCase.name, lifecycleCase.lifecycle));
    }

    offered = await offeredTo(placeStage);

    // ONE slice over every case, as if each had been offered and the ones that
    // did not happen were called off before the slice ran. The worker claims
    // ids without consulting the predicate, so they reach the stage.
    await runSlice(
      placeStage,
      [...byCase.values()].map((seeded) => seeded.id),
    );

    // Then the edge leg, over whatever its own sweep offers.
    const edgeCandidates = [...(await offeredTo(edgeStage))];

    if (edgeCandidates.length > 0) {
      await runSlice(edgeStage, edgeCandidates);
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (ctx != null) {
        await dataSource.query('DELETE FROM ci.pipeline_state WHERE user_id = $1', [ctx.userId]);
        await dataSource.query(`DELETE FROM ci.pipeline_dead_letters WHERE payload->>'userId' = $1`, [
          ctx.userId,
        ]);
        await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
        await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [ctx.userId]);
        await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
        await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      }

      // Before `destroy()`: the lock is held on a connection from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('classifies every status ci.events allows', async () => {
    // A status added to the CHECK constraint fails here until the shared case
    // table says whether an event carrying it happened.
    expect([...(await eventStatusVocabulary(query))].sort()).toEqual([...EVENT_STATUSES].sort());
  });

  it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
    '%s (happened: %s) is offered by the sweep only if it happened',
    (name, happened) => {
      // The applicability predicate, evaluated by Postgres.
      expect(offered.has(byCase.get(name)!.id)).toBe(happened);
    },
  );

  it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
    '%s (happened: %s) is linked to a place only if it happened, even in a slice',
    async (name, happened) => {
      const seeded = byCase.get(name)!;

      if (happened) {
        expect(await ledgerRow(seeded.id)).toEqual({
          status: 'done',
          reason: null,
          stage_version: PROMOTE_PLACE_VERSION,
        });
        expect(await link(seeded.id)).toEqual(linkedTo(seeded));
        expect(await footprint(placesByName.get(seeded.venueName)!)).toMatchObject({
          stage: PROMOTE_PLACE_STAGE_ID,
        });
      } else {
        // Not offered by the sweep (above), so reaching the slice means it was
        // called off after the sweep. The slice still refuses it, before any
        // place is resolved: no Location is minted for its venue.
        expect(await ledgerRow(seeded.id)).toEqual({
          status: 'skipped',
          reason: declineReason(caseNamed(name)),
          stage_version: PROMOTE_PLACE_VERSION,
        });
        expect(await link(seeded.id)).toEqual(UNLINKED);
        expect(placesByName.has(seeded.venueName)).toBe(false);
      }
    },
  );

  it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened] as const))(
    '%s (happened: %s) gets an event.happened_at edge only if it happened',
    async (name, happened) => {
      const seeded = byCase.get(name)!;

      expect(await happenedAtEdges(seeded.id)).toEqual(
        happened ? [{ to_entity_id: placesByName.get(seeded.venueName) }] : [],
      );
    },
  );

  it('does not widen the footprint of a venue the user did visit', async () => {
    // Two events with one venue name, ~110 m apart: one cell in latitude, so
    // two observations. When both happened the hull spans them and the
    // footprint is wider than the dedupe-cell floor. When the second was
    // cancelled, the place is the first one's floor circle and nothing more.
    const at = venue((venues += 1));
    const apart = { lat: at.lat + 0.001, lng: at.lng };
    const visited = await seedEvent('Visited', HAPPENED, at, 'Shared venue');
    const cancelled = await seedEvent(
      'Cancelled',
      { ...HAPPENED, status: 'cancelled' },
      apart,
      'Shared venue',
    );
    const controlAt = venue((venues += 1));
    const controlA = await seedEvent('Control A', HAPPENED, controlAt, 'Control venue');
    const controlB = await seedEvent(
      'Control B',
      HAPPENED,
      { lat: controlAt.lat + 0.001, lng: controlAt.lng },
      'Control venue',
    );

    await runSlice(placeStage, [visited.id, cancelled.id, controlA.id, controlB.id]);

    expect(await link(cancelled.id)).toEqual(UNLINKED);

    const shared = await footprint(placesByName.get('Shared venue')!);
    const control = await footprint(placesByName.get('Control venue')!);

    // `ST_Buffer` approximates a circle with 8 segments per quadrant, so a
    // single observation's area is a couple of percent under a true circle.
    expect(shared.radiusM).toBeGreaterThan(PLACE_UNCERTAINTY_FLOOR_METRES * 0.95);
    expect(shared.radiusM).toBeLessThan(PLACE_UNCERTAINTY_FLOOR_METRES * 1.05);
    expect(control.radiusM).toBeGreaterThan(PLACE_UNCERTAINTY_FLOOR_METRES * 1.2);
  });

  describe('applicability, not a recorded skip', () => {
    it('offers a cancelled event again once it is reinstated, with no bump', async () => {
      const seeded = await seedEvent('Reinstated', { ...HAPPENED, status: 'cancelled' });

      expect((await offeredTo(placeStage)).has(seeded.id)).toBe(false);
      expect(await ledgerRow(seeded.id)).toBeUndefined();

      await query(`UPDATE ci.events SET status = 'confirmed' WHERE event_id = $1`, [seeded.id]);

      expect((await offeredTo(placeStage)).has(seeded.id)).toBe(true);

      await runSlice(placeStage, [seeded.id]);

      expect(await link(seeded.id)).toEqual(linkedTo(seeded));
    });

    it('holds an event skipped mid-flight until a bump, as every recorded skip is held', async () => {
      // What a recorded skip would have done to every cancelled event, pinned
      // where it does happen: only for one called off in the seconds between a
      // sweep and its slice.
      const seeded = await seedEvent('Called off mid-flight', { ...HAPPENED, status: 'cancelled' });

      await runSlice(placeStage, [seeded.id]);

      expect(await ledgerRow(seeded.id)).toEqual({
        status: 'skipped',
        reason: 'event_did_not_happen',
        stage_version: PROMOTE_PLACE_VERSION,
      });

      await query(`UPDATE ci.events SET status = 'confirmed' WHERE event_id = $1`, [seeded.id]);

      expect((await offeredTo(placeStage)).has(seeded.id)).toBe(false);
      expect(await link(seeded.id)).toEqual(UNLINKED);
    });
  });

  it('keeps a link written while the event was live when it is cancelled afterwards', async () => {
    // THE LIMIT, pinned so it is a known one rather than an assumption. The
    // sweep stops offering the row, and this stage never withdraws a link from
    // a row it is not offered. The repair migration withdrew the links written
    // before the rule existed; nothing withdraws one written after it. A change
    // that does has to change this test, deliberately.
    const seeded = await seedEvent('Cancelled later', HAPPENED);

    await runSlice(placeStage, [seeded.id]);

    expect(await link(seeded.id)).toEqual(linkedTo(seeded));

    await query(`UPDATE ci.events SET status = 'cancelled' WHERE event_id = $1`, [seeded.id]);

    expect((await offeredTo(placeStage)).has(seeded.id)).toBe(false);
    expect(await link(seeded.id)).toEqual(linkedTo(seeded));
  });
});

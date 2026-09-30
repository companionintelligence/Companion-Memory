import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { DeterministicEdgeBackfillService } from '@ci/domains/maintenance';
import { GraphDeltaWriter } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PIPELINE_QUEUES } from '../../constants';
import { PipelineSliceListener } from '../../listeners/PipelineSliceListener';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { Stage } from '../../types';
import {
  EventEdgePromoteStage,
  PROMOTE_EDGE_EVENT_STAGE_ID,
  PROMOTE_EDGE_EVENT_VERSION,
} from '../promote/EdgePromoteStage';
import { PROMOTE_PLACE_STAGE_ID, PlacePromoteStage } from '../promote/PlacePromoteStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PLACE LINK THAT ARRIVES AFTER THE EDGE LEG DECIDED THE EVENT STILL GETS ITS
 * EDGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `promote.edge_event` applies to an event with ANY of four linkage columns. An
 * event with participants is therefore projected — PARTICIPATED_IN — and
 * recorded `done` before it has a place. When `promote.place` links it later
 * (nightly, against an hourly edge leg: the ordinary order), THE ONE RULE never
 * offers the decided row again, and the Event −LOCATED_AT→ Place edge
 * (`event.happened_at`) is never projected.
 *
 * The fix is `STAGE_REOPENS` (`reopens.ts`): the worker re-opens the edge leg's
 * decision for every event `promote.place` records `done`. What only a real
 * database can show, and a stubbed `query` would agree with unconditionally:
 *
 *  1. the gap is real — the ledger, the predicate and the projection SQL
 *     together strand the event, with the stage doing nothing wrong;
 *  2. the worker's re-open puts exactly the linked event back in front of THE
 *     ONE RULE, and the next edge slice projects `event.happened_at` without
 *     duplicating the edges already there;
 *  3. only `done` re-opens — an event whose link another writer owns is left
 *     decided;
 *  4. `reopen()` reports the rows it moved. On a bare `UPDATE … RETURNING`
 *     TypeORM hands back `[rows, rowCount]`, so it used to report 2, always.
 *
 * Everything runs through the real `PipelineSliceListener`, `PipelineStateService`,
 * `PlacePromoteStage`, `EventEdgePromoteStage` and
 * `DeterministicEdgeBackfillService`. The one stand-in is `PlaceService`: this
 * suite is about the ledger, not about place identity, which
 * `PlacePromoteStage.spec.ts` and `PlaceService.geocode.spec.ts` cover.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. Every
 * fixture belongs to a synthetic user and is deleted in `afterAll`.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://… yarn workspace @ci/be-api jest PlaceLinkReopensEdgeEvent.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PlaceLinkReopensEdgeEvent.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** One venue per event, a dedupe cell apart, so no two share a Location. */
const venue = (n: number) => ({ lat: -41 - n * 0.05, lng: -31 - n * 0.05 });

/**
 * The check this change was measured with, scoped to the ids asked about: an
 * event carrying a place link with no active `event.happened_at` edge from it.
 * 0 of 37 linked events on the reference appliance, where no event yet has a
 * participant for the edge leg to decide it by first.
 */
const GAP_SQL = `
  SELECT e.event_id
    FROM ci.events e
   WHERE e.user_id = $1
     AND e.event_id = ANY($2::uuid[])
     AND e.location_entity_id IS NOT NULL
     AND NOT EXISTS (SELECT 1
                       FROM ci.relationships r
                      WHERE r.from_entity_id = e.event_id
                        AND r.relationship_type = 'LOCATED_AT'
                        AND r.is_active = TRUE
                        AND r.properties->>'rule' = 'event.happened_at')
   ORDER BY e.event_id`;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describeWithDb(`promote.place re-opens promote.edge_event against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let ctx: UserServiceContext;

  let ledger: PipelineStateService;
  let edgeStage: EventEdgePromoteStage;
  let placeStage: PlacePromoteStage;
  let worker: PipelineSliceListener;
  let workerLogger: ReturnType<typeof makeLogger>;

  const person = uuidv7();
  /** The place another writer (not `promote.place`) already linked `ownedElsewhere` to. */
  const otherWritersPlace = uuidv7();

  const ids = {
    /** Participants, a name and a coordinate, no link yet: the victim. */
    linkedLate: uuidv7(),
    /** Linked by another writer before the edge leg ran; promote.place must not touch it. */
    ownedElsewhere: uuidv7(),
    /** The same shape as `linkedLate`, promoted by the stage alone — no worker, no re-open. */
    stageAlone: uuidv7(),
    /** Participants only; used for the ledger-count checks. */
    countOnly: uuidv7(),
    countRunning: uuidv7(),
  };

  /** Location ids the `PlaceService` stand-in minted, by venue name. */
  const placesByName = new Map<string, string>();

  async function seedEvent(
    eventId: string,
    n: number,
    args: { locationName: string | null; located: boolean; locationEntityId?: string },
  ): Promise<void> {
    const at = venue(n);

    // An event is a CTI aggregate: the ci.entities row comes first, and it is
    // what the projection joins as the edge's Event endpoint.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [eventId, `Reopen fixture ${n}`, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, source_type, source_system, source_id, location_name,
          location_coordinates, participant_entity_ids, location_entity_id)
       VALUES ($1::uuid, $2, '2025-06-01T15:00:00Z', 'ci.import', 'calendar', $1::text, $3,
               CASE WHEN $4::bool THEN ST_SetSRID(ST_MakePoint($6::float8, $5::float8), 4326)::geography END,
               ARRAY[$7::uuid], $8::uuid)`,
      [
        eventId,
        ctx.userId,
        args.locationName,
        args.located,
        at.lat,
        at.lng,
        person,
        args.locationEntityId ?? null,
      ],
    );
  }

  /** One slice through the real worker, exactly as a dispatched job arrives. */
  async function runSlice(stage: Stage, sliceIds: string[]): Promise<void> {
    await worker.handleSlice(PIPELINE_QUEUES.INDEX, {
      stage: stage.id,
      entityType: 'event',
      userId: ctx.userId,
      ids: sliceIds,
    });
  }

  async function ledgerRow(stageId: string, eventId: string) {
    const [row] = await dataSource.query(
      `SELECT status, stage_version FROM ci.pipeline_state
        WHERE entity_type = 'event' AND entity_id = $1 AND stage = $2`,
      [eventId, stageId],
    );

    return row as { status: string; stage_version: number } | undefined;
  }

  async function edges(fromId: string | null, toId: string | null, type: string) {
    return dataSource.query(
      `SELECT from_entity_id, to_entity_id, properties->>'rule' AS rule, is_active
         FROM ci.relationships
        WHERE owner_user_id = $1
          AND relationship_type = $2
          AND ($3::uuid IS NULL OR from_entity_id = $3::uuid)
          AND ($4::uuid IS NULL OR to_entity_id = $4::uuid)`,
      [ctx.userId, type, fromId, toId],
    ) as Promise<Array<{ from_entity_id: string; to_entity_id: string; rule: string; is_active: boolean }>>;
  }

  const offeredTo = (stage: Stage) => ledger.selectStale(stage, ctx.userId, null, 500);

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

    schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/PlaceLinkReopensEdgeEvent.integration');

    ctx = {
      userId: await createSyntheticTestUser(
        (sql, params) => dataSource.query(sql, params),
        'PlaceLinkReopensEdgeEvent',
      ),
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

    workerLogger = makeLogger();
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
      workerLogger as never,
    );

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Person', 'Ada Participant', '{}'::jsonb, $2)`,
      [person, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point, place_kind)
       VALUES ($1, 'Location', $2, 'Somewhere a geocoder chose', '{}'::jsonb,
               ST_SetSRID(ST_MakePoint(-20, -60), 4326)::geography, 'address')`,
      [otherWritersPlace, ctx.userId],
    );

    await seedEvent(ids.linkedLate, 1, { locationName: 'Blue Bottle Coffee', located: true });
    await seedEvent(ids.ownedElsewhere, 2, {
      locationName: 'Tartine Bakery',
      located: true,
      locationEntityId: otherWritersPlace,
    });
    await seedEvent(ids.stageAlone, 3, { locationName: 'Sightglass Coffee', located: true });
    await seedEvent(ids.countOnly, 4, { locationName: null, located: false });
    await seedEvent(ids.countRunning, 5, { locationName: null, located: false });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [
        Object.values(ids),
      ]);
      await dataSource.query(`DELETE FROM ci.pipeline_dead_letters WHERE payload->>'userId' = $1`, [
        ctx.userId,
      ]);
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('projects the LOCATED_AT edge of a place link that arrived after the edge leg decided the event', async () => {
    const victims = [ids.linkedLate, ids.ownedElsewhere];

    // ── The edge leg runs first: hourly, against a nightly place promoter. ──
    expect(await offeredTo(edgeStage)).toEqual(expect.arrayContaining(victims));
    await runSlice(edgeStage, victims);

    expect(await edges(person, ids.linkedLate, 'PARTICIPATED_IN')).toHaveLength(1);
    expect(await edges(ids.linkedLate, null, 'LOCATED_AT')).toEqual([]);
    // A link that already existed is projected on the first pass — the leg
    // itself was never the problem.
    expect(await edges(ids.ownedElsewhere, otherWritersPlace, 'LOCATED_AT')).toEqual([
      expect.objectContaining({ rule: 'event.happened_at', is_active: true }),
    ]);
    expect(await ledgerRow(PROMOTE_EDGE_EVENT_STAGE_ID, ids.linkedLate)).toEqual({
      status: 'done',
      stage_version: PROMOTE_EDGE_EVENT_VERSION,
    });

    // Decided: THE ONE RULE will not offer it again at this version.
    expect(await offeredTo(edgeStage)).not.toContain(ids.linkedLate);

    // ── Then promote.place links it, through the real worker. ──
    expect(await offeredTo(placeStage)).toEqual(expect.arrayContaining(victims));
    await runSlice(placeStage, victims);

    const [{ location_entity_id: placeId }] = await dataSource.query(
      `SELECT location_entity_id FROM ci.events WHERE event_id = $1`,
      [ids.linkedLate],
    );
    expect(placeId).toBe(placesByName.get('Blue Bottle Coffee'));
    expect(await ledgerRow(PROMOTE_PLACE_STAGE_ID, ids.linkedLate)).toMatchObject({ status: 'done' });
    expect(await ledgerRow(PROMOTE_PLACE_STAGE_ID, ids.ownedElsewhere)).toMatchObject({ status: 'skipped' });

    // The gap, exactly as it was measured, now open for this one event.
    const gap = await dataSource.query(GAP_SQL, [ctx.userId, victims]);
    expect(gap.map((row: { event_id: string }) => row.event_id)).toEqual([ids.linkedLate]);

    // ── The worker re-opened the linked event's edge decision, and only it. ──
    expect(await ledgerRow(PROMOTE_EDGE_EVENT_STAGE_ID, ids.linkedLate)).toEqual({
      status: 'done',
      stage_version: 0,
    });
    // `skipped: place_link_not_owned` wrote nothing, so it re-opened nothing.
    expect(await ledgerRow(PROMOTE_EDGE_EVENT_STAGE_ID, ids.ownedElsewhere)).toEqual({
      status: 'done',
      stage_version: PROMOTE_EDGE_EVENT_VERSION,
    });
    const placeSliceLog = workerLogger.log.mock.calls.find(
      ([message, fields]) =>
        message === 'Processed pipeline slice' && fields?.stage === PROMOTE_PLACE_STAGE_ID,
    );
    // The real count from real Postgres: one row moved. The pre-fix reopen()
    // said 2 here whatever happened.
    expect(placeSliceLog?.[1]).toEqual(expect.objectContaining({ reopened: 1, done: 1, skipped: 1 }));

    // ── So the next sweep offers it again, and the edge follows. ──
    const offered = await offeredTo(edgeStage);
    expect(offered).toContain(ids.linkedLate);
    expect(offered).not.toContain(ids.ownedElsewhere);

    await runSlice(edgeStage, [ids.linkedLate]);

    expect(await edges(ids.linkedLate, placeId, 'LOCATED_AT')).toEqual([
      expect.objectContaining({ rule: 'event.happened_at', is_active: true }),
    ]);
    // Re-projecting what was already there wrote nothing twice.
    expect(await edges(person, ids.linkedLate, 'PARTICIPATED_IN')).toHaveLength(1);
    expect(await ledgerRow(PROMOTE_EDGE_EVENT_STAGE_ID, ids.linkedLate)).toEqual({
      status: 'done',
      stage_version: PROMOTE_EDGE_EVENT_VERSION,
    });
    expect(await dataSource.query(GAP_SQL, [ctx.userId, victims])).toEqual([]);
  });

  it('strands the event when the stage runs without the worker — a stage never writes the ledger', async () => {
    // The pre-fix behaviour, reproduced exactly: the link is written, and the
    // edge leg's decision stays where it was. This is the control that shows the
    // re-open above came from the worker's `STAGE_REOPENS` step, not from
    // anything the stage or the projection does on its own.
    await runSlice(edgeStage, [ids.stageAlone]);

    const results = await placeStage.run(ctx, [ids.stageAlone]);
    expect(results.get(ids.stageAlone)).toMatchObject({ outcome: 'done' });

    expect(await ledgerRow(PROMOTE_EDGE_EVENT_STAGE_ID, ids.stageAlone)).toEqual({
      status: 'done',
      stage_version: PROMOTE_EDGE_EVENT_VERSION,
    });
    expect(await offeredTo(edgeStage)).not.toContain(ids.stageAlone);

    const gap = await dataSource.query(GAP_SQL, [ctx.userId, [ids.stageAlone]]);
    expect(gap.map((row: { event_id: string }) => row.event_id)).toEqual([ids.stageAlone]);
  });

  it('reopen() reports the rows it moved, and leaves a live claim alone', async () => {
    await runSlice(edgeStage, [ids.countOnly, ids.countRunning]);

    // A decided row moves once; asking again moves nothing, because it is
    // already at 0. An id with no ledger row is not an error — it is simply
    // not decided yet, so it is already a candidate.
    expect(await ledger.reopen('event', PROMOTE_EDGE_EVENT_STAGE_ID, [ids.countOnly, uuidv7()])).toBe(1);
    expect(await ledger.reopen('event', PROMOTE_EDGE_EVENT_STAGE_ID, [ids.countOnly])).toBe(0);

    // A row a worker holds right now is left to that worker, whose complete()
    // stamps it at the current version. That is the residual window
    // `reopens.ts` documents: a projection that read the event before the link
    // committed and completes after the re-open.
    // (Failed first, because a row decided at the current version cannot be
    // claimed; a failed one can, at the version it failed under.)
    await ledger.fail(edgeStage, 'event', [ids.countRunning], 'edge_projection_failed');
    expect(await ledger.claim(edgeStage, 'event', [ids.countRunning], ctx.userId)).toEqual([
      ids.countRunning,
    ]);

    expect(await ledger.reopen('event', PROMOTE_EDGE_EVENT_STAGE_ID, [ids.countRunning])).toBe(0);
    expect(await ledgerRow(PROMOTE_EDGE_EVENT_STAGE_ID, ids.countRunning)).toEqual({
      status: 'running',
      stage_version: PROMOTE_EDGE_EVENT_VERSION,
    });
  });
});

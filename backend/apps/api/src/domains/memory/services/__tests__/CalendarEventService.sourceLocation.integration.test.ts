import type { Point } from 'typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { EventUpdatedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { calendarEventIdentity, platformIdentity } from '../../identity';
import { clearExpansionZoneCache } from '../../recurrence/queries';
import type { CreateEventDto } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { stubPipelineReopeners } from './harness/pipelineReopeners';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SOURCE'S RE-DELIVERED PLACE, AGAINST THE ROWS IT LANDS ON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `createOne` refreshed the status (#2890), the time and the title (#2898), and
 * left the place alone on purpose: it is a cluster of columns (a name, a point,
 * the confidence that rides with it, a link to a Location) written by the
 * source, a person, three pipeline stages and a promoter. It now merges the name
 * and the point as ONE unit against what the source delivered last time
 * (sourceLocationMerge.ts has the rule and the argument; the sibling suites
 * cover the other fields). This file pins what that does to real rows, through
 * `create`, the door every connection uses:
 *
 *  - what lands, what is withdrawn with it (the link, the tags, an estimate's
 *    marks, the LOCATED_AT edge projected from the link) and who is told;
 *  - that the name never moves without the point, in either direction;
 *  - that a person's edit stands, including one that commits while the sync
 *    waits on a lock (live connections and a `pg_blocking_pids` rendezvous, which
 *    is why this is not a unit spec);
 *  - that what the pipeline wrote counts as the source's, and only where the
 *    stage could have written it;
 *  - that a person's write to the place takes the stage's marks with it, so a
 *    correction is never mistaken for the pipeline's.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CalendarEventService.sourceLocation] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const START = new Date('2026-10-07T17:00:00Z');
const END = new Date('2026-10-07T18:00:00Z');
const MOVED_START = new Date('2026-10-09T15:00:00Z');
const MOVED_END = new Date('2026-10-09T16:30:00Z');

const TITLE = 'Lunch with Ada';

const point = (longitude: number, latitude: number): Point => ({
  type: 'Point',
  coordinates: [longitude, latitude],
});

const ROMA = point(12.4964, 41.9028);
const APPIA = point(12.5113, 41.8719);
const USERS = point(12.55, 41.95);
const STAGES = point(12.6, 41.8);

const CAFE = 'Cafe Roma';
const CAFE_APPIA = 'Cafe Roma, 12 Via Appia';

interface StoredRow {
  title: string | null;
  start_time: Date;
  status: string;
  is_deleted: boolean;
  updated_at: Date;
  ctid: string;
  location_name: string | null;
  lng: number | null;
  lat: number | null;
  location_entity_id: string | null;
  confidence_score: number;
  is_inferred: boolean;
  inference_sources: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source_location: { name: string | null; coordinates: number[] | null } | null;
}

describeWithDb(`CalendarEventService — a source re-delivering a place (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: CalendarEventService;
  let uid: string;
  let venues = 0;

  const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const signalling = { send: jest.fn(async () => undefined) };
  const hbpe = { notifyEvents: jest.fn(async () => undefined) };
  // What PipelineModule binds to the three tokens, as stand-ins that only record being asked. The shared
  // harness answers by token, so a service that resolves the wrong one gets an error. The pipeline's own
  // spec runs the real ledger.
  const {
    time: timeReopener,
    status: statusReopener,
    location: locationReopener,
    moduleRef,
  } = stubPipelineReopeners();
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  /** What a calendar connection sends for one meeting: the same identity every time, with a place. */
  function delivery(over: Partial<CreateEventDto> = {}, recurrenceId?: string): CreateEventDto {
    const identity = calendarEventIdentity(uid, recurrenceId);

    return {
      title: TITLE,
      event_type: 'calendar_event',
      start_time: START,
      end_time: END,
      status: 'confirmed',
      location_name: CAFE,
      location_coordinates: ROMA,
      confidence_score: 0.8,
      source_type: 'ETL',
      source_system: identity?.system,
      source_id: identity?.id,
      ...over,
    };
  }

  /** The same meeting with no place at all, as the transforms send one the organizer left blank. */
  const placeless = (over: Partial<CreateEventDto> = {}): CreateEventDto =>
    delivery({
      location_name: undefined,
      location_coordinates: undefined,
      confidence_score: undefined,
      ...over,
    });

  /** A place the geocoder could not place this time: a name and no point. */
  const nameOnly = (name: string, over: Partial<CreateEventDto> = {}): CreateEventDto =>
    delivery({ location_name: name, location_coordinates: undefined, confidence_score: undefined, ...over });

  async function row(id: string): Promise<StoredRow> {
    const [found] = await dataSource.query(
      `SELECT b.name AS title, e.start_time, e.status, e.is_deleted, e.updated_at, e.ctid::text AS ctid,
              e.location_name,
              ST_X(e.location_coordinates::geometry) AS lng, ST_Y(e.location_coordinates::geometry) AS lat,
              e.location_entity_id, e.confidence_score, e.is_inferred, e.inference_sources,
              e.metadata, e.source_location
         FROM ci.events e JOIN ci.entities b ON b.entity_id = e.event_id
        WHERE e.event_id = $1`,
      [id],
    );

    return found;
  }

  const at = (found: StoredRow): [number, number] | null =>
    found.lng === null || found.lat === null ? null : [found.lng, found.lat];

  function refreshDeltas(id: string): Promise<Array<{ changed_fields: Record<string, unknown> }>> {
    return dataSource.query(
      `SELECT changed_fields FROM ci.graph_deltas
        WHERE entity_id = $1 AND change_source = 'CalendarEventService.refreshFromSource'
        ORDER BY changed_at`,
      [id],
    );
  }

  // ── what the pipeline and the promoter leave on a row ────────────────────

  /** What `enrich.geocode` writes for a name: a point, its precision, and the tag. */
  async function geocodedPoint(id: string, where: Point, tag = 'geocoded', confidence = 0.8): Promise<void> {
    await dataSource.query(
      `UPDATE ci.events
          SET location_coordinates = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
              confidence_score = $4,
              metadata = metadata || jsonb_build_object('location_source', $5::text)
        WHERE event_id = $1`,
      [id, where.coordinates[0], where.coordinates[1], confidence, tag],
    );
  }

  /** What `enrich.estimate_location` writes for an event with no place of its own. */
  async function estimatedPoint(id: string, where: Point): Promise<void> {
    await dataSource.query(
      `UPDATE ci.events
          SET location_coordinates = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
              is_inferred = true,
              confidence_score = 0.4,
              inference_sources = '{"method": "temporal_nn", "donor": "position", "delta_seconds": 5}'::jsonb,
              metadata = metadata || '{"location_source": "estimated"}'::jsonb
        WHERE event_id = $1`,
      [id, where.coordinates[0], where.coordinates[1]],
    );
  }

  /** A Location, one grid cell apart from every other this suite makes. */
  async function location(name = CAFE): Promise<string> {
    const id = uuidv7();
    venues += 1;

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, properties, location_point,
                                  place_kind, is_active)
         VALUES ($1::uuid, 'Location', $2, $3::uuid, '{}'::jsonb,
                 ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, 'address', true)`,
      [id, name, ctx.userId, 100 + venues * 0.05, -30 - venues * 0.05],
    );

    return id;
  }

  /** `promote.place`'s link, with the marker it stamps, and the edge the edge leg projected from it. */
  async function promotedLink(eventId: string, placeId: string, rule = 'event.happened_at'): Promise<string> {
    const edgeId = uuidv7();

    await dataSource.query(
      `UPDATE ci.events
            SET location_entity_id = $2,
                metadata = metadata || '{"promote": {"stage": "promote.place", "version": 1}}'::jsonb
          WHERE event_id = $1`,
      [eventId, placeId],
    );
    await edge(eventId, placeId, edgeId, rule);

    return edgeId;
  }

  async function edge(
    fromId: string,
    toId: string,
    id = uuidv7(),
    rule = 'event.happened_at',
  ): Promise<string> {
    await dataSource.query(
      `INSERT INTO ci.relationships (relationship_id, from_entity_id, to_entity_id, relationship_type, strength,
                                       properties, owner_user_id, from_entity_type, to_entity_type)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'LOCATED_AT', 0.6, $4::jsonb, $5::uuid, 'Event', 'Location')`,
      [id, fromId, toId, JSON.stringify({ rule, derived_from: 'events.location_entity_id' }), ctx.userId],
    );

    return id;
  }

  async function edgeExists(id: string): Promise<boolean> {
    const rows = await dataSource.query('SELECT 1 FROM ci.relationships WHERE relationship_id = $1', [id]);

    return rows.length === 1;
  }

  async function placeExists(id: string): Promise<boolean> {
    const rows = await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [id]);

    return rows.length === 1;
  }

  async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`Timed out waiting for ${what}`);
  }

  /** Whether some backend is waiting on a lock `pid` holds. */
  async function someoneWaitsOn(pid: number): Promise<boolean> {
    const [{ waiting }] = await dataSource.query(
      'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
      [pid],
    );

    return waiting > 0;
  }

  /**
   * Run `hold` in a transaction on its own connection, then `whileHeld` while
   * that transaction is still open, then commit. Returns `whileHeld`'s result.
   */
  async function withOpenTransaction<T>(
    hold: (query: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
    whileHeld: (pid: number) => Promise<T>,
  ): Promise<T> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
      await hold((sql, params) => runner.query(sql, params));
      const result = await whileHeld(pid);

      return result;
    } finally {
      if (runner.isTransactionActive) {
        await runner.commitTransaction();
      }

      await runner.release();
    }
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CalendarEventService.sourceLocation');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Source location fixture', $2, 'x', true, 'UTC')`,
      [ctx.userId, `source-location.${ctx.userId}@example.test`],
    );

    service = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      signalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
      hbpe as never,
      moduleRef as never,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    locationReopener.reopenLocationDecisions.mockImplementation(async () => 0);
    timeReopener.reopenTimeDecisions.mockImplementation(async () => 0);
    statusReopener.reopenStatusDecisions.mockImplementation(async () => 0);
    clearExpansionZoneCache();
    uid = `lunch-${uuidv7()}@example.test`;
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  describe('what an insert records', () => {
    it("records the source's place beside the row, with none as a base of its own, through both doors", async () => {
      const [single] = await service.create(ctx, delivery());

      expect(await row(single.id)).toMatchObject({
        source_location: { name: CAFE, coordinates: [...ROMA.coordinates] },
      });

      // A source that sent no place has said so: the base is "no place", not "no base".
      uid = `blank-${uuidv7()}@example.test`;
      const [blank] = await service.create(ctx, placeless());

      expect((await row(blank.id)).source_location).toEqual({ name: null, coordinates: null });

      // The importer's push: the set-based INSERT records the same base...
      uid = `import-${uuidv7()}@example.test`;
      const [bulk] = await service.create(ctx, [delivery({ source_type: 'ci-import-tools' })]);

      expect((await row(bulk.id)).source_location).toEqual({
        name: CAFE,
        coordinates: [...ROMA.coordinates],
      });

      // ...and still refreshes nothing on a conflict: the bulk door is find-or-return.
      await service.create(ctx, [
        delivery({
          source_type: 'ci-import-tools',
          location_name: CAFE_APPIA,
          location_coordinates: APPIA,
        }),
      ]);

      expect(await row(bulk.id)).toMatchObject({ location_name: CAFE });
    });

    it('records no base on a row no source owns, nor on a planned block', async () => {
      const [own] = await service.create(ctx, {
        title: 'My own event',
        start_time: START,
        end_time: END,
        location_name: CAFE,
        location_coordinates: ROMA,
      });
      const identity = platformIdentity('planning', 'task', uuidv7());
      const [block] = await service.create(ctx, {
        title: 'Write the memo',
        event_type: 'planned_block',
        start_time: START,
        end_time: END,
        status: 'planned',
        source_type: 'planning',
        source_system: identity.system,
        source_id: identity.id,
      });

      for (const id of [own.id, block.id]) {
        expect((await row(id)).source_location).toBeNull();
      }
    });
  });

  describe('a source moving the place', () => {
    it('moves the name and the point together, and publishes what update publishes', async () => {
      const [stored] = await service.create(ctx, delivery());
      jest.clearAllMocks();

      const [resynced] = await service.create(
        ctx,
        delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA, confidence_score: 0.95 }),
      );

      expect(resynced.id).toBe(stored.id);
      expect(resynced.locationName).toBe(CAFE_APPIA);
      const after = await row(stored.id);
      expect(after).toMatchObject({
        location_name: CAFE_APPIA,
        // The precision that rode with the new point, not the old one's.
        confidence_score: 0.95,
        source_location: { name: CAFE_APPIA, coordinates: [...APPIA.coordinates] },
        // Nothing else on the row moved.
        title: TITLE,
        start_time: START,
      });
      expect(at(after)).toEqual(APPIA.coordinates);

      expect(signalling.send).toHaveBeenCalledTimes(1);
      expect(signalling.send).toHaveBeenCalledWith(EventUpdatedEvent, { eventId: stored.id });
      // HBPE reads an event's status, time and title; the place is not one of them.
      expect(hbpe.notifyEvents).not.toHaveBeenCalled();
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
      expect(timeReopener.reopenTimeDecisions).not.toHaveBeenCalled();
      expect(await refreshDeltas(stored.id)).toEqual([
        {
          changed_fields: expect.objectContaining({
            location_name: { old: CAFE, new: CAFE_APPIA },
            location_coordinates: { old: [...ROMA.coordinates], new: [...APPIA.coordinates] },
          }),
        },
      ]);
    });

    it('takes what was derived from the old place with it: the link, the tags and the edge', async () => {
      // The provider was down at the first sync: a name, no point. The stage
      // placed it later, the promoter linked it, the edge leg projected it.
      const [stored] = await service.create(ctx, nameOnly(CAFE, { metadata: { rawEventId: 'g-1' } }));
      await geocodedPoint(stored.id, ROMA);
      const oldPlace = await location();
      const oldEdge = await promotedLink(stored.id, oldPlace);
      jest.clearAllMocks();

      await service.create(
        ctx,
        delivery({
          location_name: CAFE_APPIA,
          location_coordinates: APPIA,
          confidence_score: 0.95,
          metadata: { rawEventId: 'g-1' },
        }),
      );

      const after = await row(stored.id);
      expect(after).toMatchObject({
        location_name: CAFE_APPIA,
        location_entity_id: null,
        confidence_score: 0.95,
      });
      expect(at(after)).toEqual(APPIA.coordinates);
      // The tags go with the value they described; nothing else in the bag does.
      expect(after.metadata).not.toHaveProperty('location_source');
      expect(after.metadata).not.toHaveProperty('promote');
      expect(after.metadata).toMatchObject({ rawEventId: 'g-1' });

      // The projection only ever inserts, so this is the one place the edge can go.
      expect(await edgeExists(oldEdge)).toBe(false);
      expect(
        await dataSource.query(
          `SELECT change_type, change_source FROM ci.graph_deltas WHERE relationship_id = $1`,
          [oldEdge],
        ),
      ).toEqual([{ change_type: 'deleted', change_source: 'CalendarEventService.refreshFromSource' }]);
      expect(await refreshDeltas(stored.id)).toEqual([
        {
          changed_fields: expect.objectContaining({ location_entity_id: { old: oldPlace, new: null } }),
        },
      ]);
      // The Location itself is the stages' to manage.
      expect(await placeExists(oldPlace)).toBe(true);
    });

    it('deletes the matrix edge to the old place, and not another event’s edge to it', async () => {
      const [stored] = await service.create(ctx, delivery());
      const [neighbour] = await service.create(ctx, delivery({ title: 'Another lunch' }, '20261008T170000Z'));
      const oldPlace = await location();
      const matrixEdge = await promotedLink(stored.id, oldPlace);
      // Another event at the same place keeps its own.
      const neighbourEdge = await promotedLink(neighbour.id, oldPlace);
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      expect(await edgeExists(matrixEdge)).toBe(false);
      expect(await edgeExists(neighbourEdge)).toBe(true);
    });

    it('keeps an edge to the same place that another rule drew', async () => {
      const [stored] = await service.create(ctx, delivery());
      const oldPlace = await location();
      // One active LOCATED_AT per pair: had a receipt drawn it first, the matrix's
      // insert would have found it there. It is justified by its receipt, not by the
      // event's place, so it stays when the place moves.
      const receiptEdge = await promotedLink(stored.id, oldPlace, 'receipt.event_at_place');
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      expect(await edgeExists(receiptEdge)).toBe(true);
      expect((await row(stored.id)).location_entity_id).toBeNull();
    });

    it("finds the edge through the old place's merge survivor", async () => {
      const [stored] = await service.create(ctx, delivery());
      const loser = await location();
      const survivor = await location('Cafe Roma (merged)');
      await dataSource.query(
        'UPDATE ci.entities SET merged_into_entity_id = $2, is_active = false WHERE entity_id = $1',
        [loser, survivor],
      );
      // The link still names the loser; the projection resolved the edge to the survivor.
      await dataSource.query(
        `UPDATE ci.events SET location_entity_id = $2,
                  metadata = metadata || '{"promote": {"stage": "promote.place"}}'::jsonb
            WHERE event_id = $1`,
        [stored.id, loser],
      );
      const survivorEdge = await edge(stored.id, survivor);

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      expect(await edgeExists(survivorEdge)).toBe(false);
    });

    it('moves a name to a place nobody could place this time: the old pin goes with the old name', async () => {
      const [stored] = await service.create(ctx, delivery());
      jest.clearAllMocks();

      // A name, and no point: the provider is down, or the text is "TBD".
      await service.create(ctx, nameOnly('Cafe Appia'));

      const after = await row(stored.id);
      expect(after).toMatchObject({
        location_name: 'Cafe Appia',
        lng: null,
        lat: null,
        // A row with no point carries the column default.
        confidence_score: 1,
        source_location: { name: 'Cafe Appia', coordinates: null },
      });
      // The shape `enrich.geocode` exists to fill, and it is told so.
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
    });

    it('clears the place the organizer cleared, or turned into a meeting link', async () => {
      const [stored] = await service.create(ctx, delivery());

      await service.create(ctx, placeless());

      expect(await row(stored.id)).toMatchObject({
        location_name: null,
        lng: null,
        lat: null,
        confidence_score: 1,
        source_location: { name: null, coordinates: null },
      });
    });

    it('adds a place to an event that had none', async () => {
      const [stored] = await service.create(ctx, placeless());
      jest.clearAllMocks();

      await service.create(ctx, delivery({ confidence_score: 0.95 }));

      const after = await row(stored.id);
      expect(after).toMatchObject({
        location_name: CAFE,
        confidence_score: 0.95,
        source_location: { name: CAFE, coordinates: [...ROMA.coordinates] },
      });
      expect(at(after)).toEqual(ROMA.coordinates);
      expect(signalling.send).toHaveBeenCalledWith(EventUpdatedEvent, { eventId: stored.id });
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
    });

    it('follows the source from a first sync whose place was only whitespace', async () => {
      // The row stores the text as sent; the base reads it as no name. A real place
      // afterwards must find the row still showing its source.
      const [stored] = await service.create(ctx, placeless({ location_name: '   ' }));
      expect(await row(stored.id)).toMatchObject({
        location_name: '   ',
        source_location: { name: null, coordinates: null },
      });

      await service.create(ctx, delivery());

      expect(await row(stored.id)).toMatchObject({ location_name: CAFE });
    });

    it('moves only the point when the name stays', async () => {
      const [stored] = await service.create(ctx, delivery());

      await service.create(ctx, delivery({ location_coordinates: APPIA, confidence_score: 0.95 }));

      const after = await row(stored.id);
      expect(after).toMatchObject({ location_name: CAFE, confidence_score: 0.95 });
      expect(at(after)).toEqual(APPIA.coordinates);
    });

    it('moves only the name when the point stays, and the link made for the old name goes', async () => {
      const [stored] = await service.create(ctx, delivery());
      const oldPlace = await location();
      await promotedLink(stored.id, oldPlace);

      // An Outlook room whose display name gains a letter and keeps its coordinates.
      await service.create(ctx, delivery({ location_name: 'Cafe Roma 2' }));

      const after = await row(stored.id);
      expect(after).toMatchObject({ location_name: 'Cafe Roma 2', location_entity_id: null });
      expect(at(after)).toEqual(ROMA.coordinates);
    });

    it('costs nothing when the source repeats itself: the row is not even rewritten', async () => {
      const [stored] = await service.create(ctx, delivery());
      const before = await row(stored.id);
      jest.clearAllMocks();

      await service.create(ctx, delivery());

      // ctid moves on every UPDATE, even one that writes the same values.
      expect(await row(stored.id)).toEqual(before);
      expect(signalling.send).not.toHaveBeenCalled();
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
    });

    it('does not clear a pin because the geocoder was down for a repeat of the same name', async () => {
      const [stored] = await service.create(ctx, delivery());
      const before = await row(stored.id);
      jest.clearAllMocks();

      // The same place, delivered with no point: a provider outage, not the
      // organizer clearing the pin.
      await service.create(ctx, nameOnly(CAFE));

      expect(await row(stored.id)).toEqual(before);
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();

      // And the base kept its point, so the organizer's later move still lands.
      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));
      expect(await row(stored.id)).toMatchObject({ location_name: CAFE_APPIA });
    });

    it('moves the place, the time, the title and a series rule in one statement, and tells HBPE of the time', async () => {
      const rule = ['RRULE:FREQ=WEEKLY;BYDAY=MO'];
      const moved = ['RRULE:FREQ=WEEKLY;BYDAY=TU'];
      const [stored] = await service.create(
        ctx,
        delivery({
          is_recurring: true,
          metadata: { rawEventId: 'g-2', recurrenceRule: rule, recurrenceTimeZone: 'Europe/London' },
        }),
      );
      const oldPlace = await location();
      await promotedLink(stored.id, oldPlace);
      await geocodedPoint(stored.id, ROMA, 'approximate');
      jest.clearAllMocks();

      await service.create(
        ctx,
        delivery({
          title: 'Lunch with Ada (Tuesdays)',
          start_time: MOVED_START,
          end_time: MOVED_END,
          location_name: CAFE_APPIA,
          location_coordinates: APPIA,
          is_recurring: true,
          metadata: { rawEventId: 'g-2', recurrenceRule: moved, recurrenceTimeZone: 'Europe/London' },
        }),
      );

      const after = await row(stored.id);
      expect(after).toMatchObject({
        title: 'Lunch with Ada (Tuesdays)',
        start_time: MOVED_START,
        location_name: CAFE_APPIA,
        location_entity_id: null,
      });
      // The series' new rule landed, and the pipeline's marks left, in one bag.
      expect(after.metadata).toMatchObject({
        rawEventId: 'g-2',
        recurrenceRule: moved,
        recurrenceTimeZone: 'Europe/London',
      });
      expect(after.metadata).not.toHaveProperty('location_source');
      expect(after.metadata).not.toHaveProperty('promote');
      expect(hbpe.notifyEvents).toHaveBeenCalledWith(ctx.userId, [START, MOVED_START]);
      expect(timeReopener.reopenTimeDecisions).toHaveBeenCalledTimes(1);
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledTimes(1);
    });

    it('tells HBPE of the time when the place moves with it', async () => {
      const [stored] = await service.create(ctx, delivery());
      jest.clearAllMocks();

      // The title, the status and the series are untouched: only the time and the place.
      await service.create(
        ctx,
        delivery({
          start_time: MOVED_START,
          end_time: MOVED_END,
          location_name: CAFE_APPIA,
          location_coordinates: APPIA,
        }),
      );

      expect(hbpe.notifyEvents).toHaveBeenCalledTimes(1);
      expect(hbpe.notifyEvents).toHaveBeenCalledWith(ctx.userId, [START, MOVED_START]);
      expect(timeReopener.reopenTimeDecisions).toHaveBeenCalledTimes(1);
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
    });

    it('commits the move, the withdrawn edge and its re-open together, or none of them', async () => {
      const [stored] = await service.create(ctx, delivery());
      const oldPlace = await location();
      const oldEdge = await promotedLink(stored.id, oldPlace);
      const before = await row(stored.id);
      locationReopener.reopenLocationDecisions.mockImplementation(async () => {
        throw new Error('pipeline unavailable');
      });

      await expect(
        service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA })),
      ).rejects.toThrow('pipeline unavailable');

      // Rolled back whole, so the source's next delivery retries it.
      expect(await row(stored.id)).toEqual(before);
      expect(await edgeExists(oldEdge)).toBe(true);
    });
  });

  describe("a person's edit stands", () => {
    it('keeps a pin the user moved, and the name with it, when the organizer renames the venue', async () => {
      const [stored] = await service.create(ctx, delivery());
      await service.update(ctx, stored.id, { location_coordinates: USERS });
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      // No hybrid: the user moved half the place, so the place is theirs.
      const after = await row(stored.id);
      expect(after).toMatchObject({
        location_name: CAFE,
        source_location: { name: CAFE_APPIA, coordinates: [...APPIA.coordinates] },
      });
      expect(at(after)).toEqual(USERS.coordinates);
      expect(signalling.send).not.toHaveBeenCalled();
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
    });

    it('keeps a name the user typed, and the pin with it, when the organizer moves the pin', async () => {
      const [stored] = await service.create(ctx, delivery());
      await service.update(ctx, stored.id, { location_name: 'Mum’s' });
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_coordinates: APPIA }));

      const after = await row(stored.id);
      expect(after.location_name).toBe('Mum’s');
      expect(at(after)).toEqual(ROMA.coordinates);
      expect(signalling.send).not.toHaveBeenCalled();
    });

    it('keeps a place link the user chose, even though the name and the point are still the source’s', async () => {
      const [stored] = await service.create(ctx, delivery());
      const mine = await location('My usual café');
      await service.update(ctx, stored.id, { location_entity_id: mine });
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      // A link nobody can account for is somebody's choice, so the place is theirs.
      expect(await row(stored.id)).toMatchObject({ location_name: CAFE, location_entity_id: mine });
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
    });

    it('follows the source again once the two agree', async () => {
      const [stored] = await service.create(ctx, delivery());
      await service.update(ctx, stored.id, { location_name: 'Mum’s', location_coordinates: USERS });

      // The organizer comes round to the user's place: nothing moves, and that
      // agreement becomes the base...
      await service.create(ctx, delivery({ location_name: 'Mum’s', location_coordinates: USERS }));
      expect(await row(stored.id)).toMatchObject({
        location_name: 'Mum’s',
        source_location: { name: 'Mum’s', coordinates: [...USERS.coordinates] },
      });

      // ...so the organizer's next move is followed.
      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));
      expect(await row(stored.id)).toMatchObject({ location_name: CAFE_APPIA });
    });

    it("reads a row with no base as possibly the user's: it records the base and moves nothing", async () => {
      const [stored] = await service.create(ctx, delivery());
      // A row stored before bases existed, which the backfill could not clear of an edit.
      await dataSource.query('UPDATE ci.events SET source_location = NULL WHERE event_id = $1', [stored.id]);
      const before = await row(stored.id);
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      const after = await row(stored.id);
      expect(after).toMatchObject({
        location_name: CAFE,
        source_location: { name: CAFE_APPIA, coordinates: [...APPIA.coordinates] },
      });
      // Nothing anyone reads moved.
      expect(after.updated_at).toEqual(before.updated_at);
      expect(signalling.send).not.toHaveBeenCalled();
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
      expect(await refreshDeltas(stored.id)).toEqual([]);
    });

    it('lets a row with no base and no place follow its source: nothing there can be a person’s', async () => {
      const [stored] = await service.create(ctx, placeless());
      await dataSource.query('UPDATE ci.events SET source_location = NULL WHERE event_id = $1', [stored.id]);

      await service.create(ctx, delivery());

      expect(await row(stored.id)).toMatchObject({
        location_name: CAFE,
        source_location: { name: CAFE, coordinates: [...ROMA.coordinates] },
      });
    });
  });

  describe("a person's write takes the pipeline's marks with it", () => {
    it('a corrected pin is no longer tagged as the geocoder’s, so the source cannot mistake it', async () => {
      // The geocoder got the name wrong; the user fixes the pin.
      const [stored] = await service.create(ctx, nameOnly(CAFE));
      await geocodedPoint(stored.id, STAGES);
      await service.update(ctx, stored.id, { location_coordinates: USERS });

      expect((await row(stored.id)).metadata).not.toHaveProperty('location_source');

      // And the organizer's later edit does not replace the correction.
      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));
      expect(at(await row(stored.id))).toEqual(USERS.coordinates);
    });

    it('takes every tag that describes a point, and no other', async () => {
      for (const tag of ['geocoded', 'approximate', 'estimated', 'virtual', 'reverse_geocoded']) {
        uid = `tags-${tag}-${uuidv7()}@example.test`;
        const [stored] = await service.create(ctx, delivery());
        await dataSource.query(
          `UPDATE ci.events SET metadata = metadata || jsonb_build_object('location_source', $2::text, 'keep', 1)
              WHERE event_id = $1`,
          [stored.id, tag],
        );

        await service.update(ctx, stored.id, { location_coordinates: USERS });

        const { metadata } = await row(stored.id);
        expect(metadata.keep).toBe(1);
        // A name's tag, and a tag the pipeline does not use for a point, survive a point.
        expect(metadata.location_source === undefined).toBe(
          ['geocoded', 'approximate', 'estimated'].includes(tag),
        );
      }
    });

    it('a typed name is no longer tagged as derived from the point', async () => {
      const [stored] = await service.create(ctx, placeless({ location_coordinates: ROMA }));
      await dataSource.query(
        `UPDATE ci.events SET location_name = 'Via Appia 12',
                  metadata = metadata || '{"location_source": "reverse_geocoded"}'::jsonb
            WHERE event_id = $1`,
        [stored.id],
      );

      await service.update(ctx, stored.id, { location_name: 'Mum’s' });

      expect((await row(stored.id)).metadata).not.toHaveProperty('location_source');

      // The organizer adds a name later: the user's stands.
      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: ROMA }));
      expect((await row(stored.id)).location_name).toBe('Mum’s');
    });

    it('a chosen link is no longer marked as promote.place’s', async () => {
      const [stored] = await service.create(ctx, delivery());
      const old = await location();
      await promotedLink(stored.id, old);
      const mine = await location('My usual café');

      await service.update(ctx, stored.id, { location_entity_id: mine });

      expect((await row(stored.id)).metadata).not.toHaveProperty('promote');
    });

    it('leaves the bag alone when the caller sends one, and when nothing about the place is written', async () => {
      const [stored] = await service.create(ctx, nameOnly(CAFE));
      await geocodedPoint(stored.id, STAGES);

      // The legacy listener's second step: it owns the bag it sends.
      await service.update(ctx, stored.id, {
        location_coordinates: USERS,
        metadata: { location_source: 'approximate' },
      });
      expect((await row(stored.id)).metadata).toEqual({ location_source: 'approximate' });

      // A rename of something else touches no mark.
      await service.update(ctx, stored.id, { title: 'Renamed' });
      expect((await row(stored.id)).metadata).toEqual({ location_source: 'approximate' });
    });
  });

  describe('what the pipeline wrote counts as the source’s', () => {
    it.each(['geocoded', 'approximate'])(
      'follows the source over a point enrich.geocode placed for the name the source gave (%s)',
      async (tag) => {
        const [stored] = await service.create(ctx, nameOnly(CAFE));
        await geocodedPoint(stored.id, STAGES, tag, tag === 'approximate' ? 0.4 : 0.8);
        jest.clearAllMocks();

        await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

        const after = await row(stored.id);
        expect(after.location_name).toBe(CAFE_APPIA);
        expect(at(after)).toEqual(APPIA.coordinates);
        expect(after.metadata).not.toHaveProperty('location_source');
        expect(locationReopener.reopenLocationDecisions).toHaveBeenCalled();
      },
    );

    it('leaves the row alone when the source now says what the stage had found', async () => {
      const [stored] = await service.create(ctx, nameOnly(CAFE));
      await geocodedPoint(stored.id, ROMA);
      const before = await row(stored.id);
      jest.clearAllMocks();

      // The transform's geocoder is back, and answers as the stage's did.
      await service.create(ctx, delivery());

      const after = await row(stored.id);
      // The base now holds the point; the row, its tag and its precision stand.
      expect(after).toMatchObject({
        location_name: CAFE,
        confidence_score: before.confidence_score,
        metadata: before.metadata,
        source_location: { name: CAFE, coordinates: [...ROMA.coordinates] },
      });
      expect(signalling.send).not.toHaveBeenCalled();
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
    });

    it('replaces an estimate when the source adds a place, and takes the estimator’s marks with it', async () => {
      const [stored] = await service.create(ctx, placeless());
      await estimatedPoint(stored.id, STAGES);
      jest.clearAllMocks();

      await service.create(ctx, delivery({ confidence_score: 0.95 }));

      const after = await row(stored.id);
      expect(after).toMatchObject({
        location_name: CAFE,
        // What the source delivered, not the estimator's 0.4 and not LEAST of it.
        confidence_score: 0.95,
        is_inferred: false,
        inference_sources: {},
      });
      expect(at(after)).toEqual(ROMA.coordinates);
      expect(after.metadata).not.toHaveProperty('location_source');
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
    });

    it('keeps an estimate while the source still says nothing about the place', async () => {
      const [stored] = await service.create(ctx, placeless());
      await estimatedPoint(stored.id, STAGES);
      const before = await row(stored.id);
      jest.clearAllMocks();

      await service.create(ctx, placeless({ title: 'Lunch with Ada (renamed)' }));

      const after = await row(stored.id);
      expect(at(after)).toEqual(STAGES.coordinates);
      expect(after.metadata).toEqual(before.metadata);
      expect(after.is_inferred).toBe(true);
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
    });

    it('takes an estimate away when the source then adds a name and no point, leaving the row for the geocoder', async () => {
      const [stored] = await service.create(ctx, placeless());
      await estimatedPoint(stored.id, STAGES);

      await service.create(ctx, nameOnly(CAFE));

      // An estimate under a name is the fabricated visit enrich.estimate_location v2 refuses.
      const after = await row(stored.id);
      expect(after).toMatchObject({ location_name: CAFE, lng: null, lat: null, confidence_score: 1 });
      expect(after.is_inferred).toBe(false);
    });

    it('leaves inference marks the estimator did not write', async () => {
      const [stored] = await service.create(ctx, delivery());
      await dataSource.query(
        `UPDATE ci.events SET is_inferred = true, inference_sources = '{"method": "agent", "note": "x"}'::jsonb
            WHERE event_id = $1`,
        [stored.id],
      );

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      expect(await row(stored.id)).toMatchObject({
        location_name: CAFE_APPIA,
        is_inferred: true,
        inference_sources: { method: 'agent', note: 'x' },
      });
    });

    it('follows the source over a name enrich.event_reverse derived from the source’s own point', async () => {
      const [stored] = await service.create(ctx, placeless({ location_coordinates: ROMA }));
      await dataSource.query(
        `UPDATE ci.events SET location_name = 'Via Appia 12',
                  metadata = metadata || '{"location_source": "reverse_geocoded"}'::jsonb
            WHERE event_id = $1`,
        [stored.id],
      );

      await service.create(ctx, delivery());

      const after = await row(stored.id);
      expect(after.location_name).toBe(CAFE);
      expect(after.metadata).not.toHaveProperty('location_source');
    });

    it('takes a name enrich.event_reverse derived from the old point away when the source moves the point', async () => {
      const [stored] = await service.create(ctx, placeless({ location_coordinates: ROMA }));
      await dataSource.query(
        `UPDATE ci.events SET location_name = 'Via Appia 12',
                metadata = metadata || '{"location_source": "reverse_geocoded"}'::jsonb
          WHERE event_id = $1`,
        [stored.id],
      );
      jest.clearAllMocks();

      // The source still names nothing, and has moved the pin.
      await service.create(ctx, placeless({ location_coordinates: APPIA }));

      // The name described the old pin: it goes, and the stage is re-opened to name the new one.
      const after = await row(stored.id);
      expect(after.location_name).toBeNull();
      expect(at(after)).toEqual(APPIA.coordinates);
      expect(after.metadata).not.toHaveProperty('location_source');
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
    });

    it('does not mistake a geocoded point for the source’s when the name is no longer the source’s', async () => {
      const [stored] = await service.create(ctx, nameOnly(CAFE));
      await geocodedPoint(stored.id, STAGES);
      // The user renamed it after the stage placed the old name; the tag is still there.
      await service.update(ctx, stored.id, { location_name: 'Mum’s' });
      await dataSource.query(
        `UPDATE ci.events SET metadata = metadata || '{"location_source": "geocoded"}'::jsonb WHERE event_id = $1`,
        [stored.id],
      );
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      expect((await row(stored.id)).location_name).toBe('Mum’s');
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
    });
  });

  describe('tombstones, planned blocks, and deliveries that do not speak for the place', () => {
    it('moves a tombstone’s place quietly, withdraws its edge, and still re-opens its decisions', async () => {
      const [stored] = await service.create(ctx, delivery());
      const oldPlace = await location();
      const oldEdge = await promotedLink(stored.id, oldPlace);
      await service.remove(ctx, stored.id);
      jest.clearAllMocks();

      await service.create(ctx, delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      const after = await row(stored.id);
      // The deletion outlives the sync, and nothing is published for a row nobody reads.
      expect(after).toMatchObject({ is_deleted: true, location_name: CAFE_APPIA, location_entity_id: null });
      expect(signalling.send).not.toHaveBeenCalled();
      expect(await refreshDeltas(stored.id)).toEqual([]);
      expect(await edgeExists(oldEdge)).toBe(false);
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
    });

    it('leaves a planned block’s place to the planner', async () => {
      const identity = platformIdentity('planning', 'task', uuidv7());
      const block = (over: Partial<CreateEventDto>): CreateEventDto => ({
        title: 'Write the memo',
        event_type: 'planned_block',
        start_time: START,
        end_time: END,
        status: 'planned',
        source_type: 'planning',
        source_system: identity.system,
        source_id: identity.id,
        ...over,
      });
      const [stored] = await service.create(ctx, block({ location_name: CAFE, location_coordinates: ROMA }));

      await service.create(ctx, block({ location_name: CAFE_APPIA, location_coordinates: APPIA }));

      expect(await row(stored.id)).toMatchObject({ location_name: CAFE, source_location: null });
    });

    it.each([[['status']], [['status', 'time']]] as const)(
      'leaves the place alone when a delivery speaks only for %j',
      async (asserts) => {
        const [stored] = await service.create(ctx, delivery());
        const before = await row(stored.id);

        // A cancelled occurrence rebuilt from its series, or an attendee's copy of a
        // cancelled meeting: neither says anything about where it was.
        await service.create(ctx, placeless({ status: 'cancelled', source_asserts: asserts }));

        const after = await row(stored.id);
        expect(after).toMatchObject({ location_name: CAFE, source_location: before.source_location });
        expect(at(after)).toEqual(ROMA.coordinates);
      },
    );

    it('leaves the place and its base alone through the status-only door', async () => {
      const [stored] = await service.create(ctx, delivery());
      const before = await row(stored.id);

      await service.applyStatusFromSource(ctx, stored.id, 'cancelled');

      const after = await row(stored.id);
      expect(after).toMatchObject({
        status: 'cancelled',
        location_name: CAFE,
        source_location: before.source_location,
      });
      expect(at(after)).toEqual(ROMA.coordinates);
      expect(locationReopener.reopenLocationDecisions).not.toHaveBeenCalled();
    });

    it('settles both the status and the place when one delivery cancels the event and moves it', async () => {
      const [stored] = await service.create(ctx, nameOnly(CAFE));
      jest.clearAllMocks();

      await service.create(
        ctx,
        delivery({ status: 'cancelled', location_name: CAFE_APPIA, location_coordinates: APPIA }),
      );

      // Called off AND moved: each contract is asked once, on the refresh's transaction.
      expect(await row(stored.id)).toMatchObject({ status: 'cancelled', location_name: CAFE_APPIA });
      expect(statusReopener.reopenStatusDecisions).toHaveBeenCalledTimes(1);
      expect(statusReopener.reopenStatusDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledTimes(1);
      expect(locationReopener.reopenLocationDecisions).toHaveBeenCalledWith([stored.id], expect.anything());
    });

    it('speaks for the place alone when it says so, and leaves the title', async () => {
      const [stored] = await service.create(ctx, delivery());

      await service.create(
        ctx,
        delivery({
          title: 'A filler title',
          location_name: CAFE_APPIA,
          location_coordinates: APPIA,
          source_asserts: ['location'],
        }),
      );

      expect(await row(stored.id)).toMatchObject({ title: TITLE, location_name: CAFE_APPIA });
    });
  });

  describe('decided under the lock', () => {
    it('keeps a pin the user moved that commits while the sync waits on the row lock', async () => {
      const [stored] = await service.create(ctx, delivery());

      await withOpenTransaction(
        async (query) => {
          // The user fixes the pin, and has not committed yet.
          await query(
            `UPDATE ci.events SET location_coordinates = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
                WHERE event_id = $1`,
            [stored.id, USERS.coordinates[0], USERS.coordinates[1]],
          );
        },
        async (pid) => {
          // Meanwhile the organizer moves the meeting, and the sync delivers that.
          const sync = service.create(
            ctx,
            delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }),
          );
          // Rendezvous on the lock itself, not on timing: the sync must be
          // QUEUED behind the user before the user commits.
          await waitFor(() => someoneWaitsOn(pid), 'the sync to queue behind the user');

          return { sync };
        },
      ).then(({ sync }) => sync);

      const after = await row(stored.id);
      expect(at(after)).toEqual(USERS.coordinates);
      expect(after).toMatchObject({
        location_name: CAFE,
        source_location: { name: CAFE_APPIA, coordinates: [...APPIA.coordinates] },
      });
    });

    it('keeps a link the user chose that commits while the sync waits on the row lock', async () => {
      const [stored] = await service.create(ctx, delivery());
      const mine = await location('My usual café');

      await withOpenTransaction(
        async (query) => {
          await query('UPDATE ci.events SET location_entity_id = $2 WHERE event_id = $1', [stored.id, mine]);
        },
        async (pid) => {
          const sync = service.create(
            ctx,
            delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }),
          );
          await waitFor(() => someoneWaitsOn(pid), 'the sync to queue behind the user');

          return { sync };
        },
      ).then(({ sync }) => sync);

      expect(await row(stored.id)).toMatchObject({ location_name: CAFE, location_entity_id: mine });
    });

    it('reads the stage’s write that commits while the sync waits, and follows the source over it', async () => {
      const [stored] = await service.create(ctx, nameOnly(CAFE));

      await withOpenTransaction(
        async (query) => {
          // enrich.geocode places the name, and has not committed yet.
          await query(
            `UPDATE ci.events
                  SET location_coordinates = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
                      metadata = metadata || '{"location_source": "geocoded"}'::jsonb
                WHERE event_id = $1`,
            [stored.id, STAGES.coordinates[0], STAGES.coordinates[1]],
          );
        },
        async (pid) => {
          const sync = service.create(
            ctx,
            delivery({ location_name: CAFE_APPIA, location_coordinates: APPIA }),
          );
          await waitFor(() => someoneWaitsOn(pid), 'the sync to queue behind the stage');

          return { sync };
        },
      ).then(({ sync }) => sync);

      // The stage's point is the source's, so the source's move replaces it and its tag.
      const after = await row(stored.id);
      expect(at(after)).toEqual(APPIA.coordinates);
      expect(after.metadata).not.toHaveProperty('location_source');
    });
  });
});

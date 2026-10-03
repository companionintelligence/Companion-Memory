import { DataSource, type Point } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import {
  BaseEntity,
  CalendarEventService,
  EVENT_LOCATION_REOPENER,
  EVENT_STATUS_REOPENER,
  EVENT_TIME_REOPENER,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  calendarEventIdentity,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { STAGE_IDS } from '../../constants';
import { EstimateLocationStage } from '../../stages/enrich/EstimateLocationStage';
import { EventReverseStage } from '../../stages/enrich/EventReverseStage';
import { GeocodeStage } from '../../stages/enrich/GeocodeStage';
import { PlacePromoteStage } from '../../stages/promote/PlacePromoteStage';
import type { Stage } from '../../types';
import { EVENT_LOCATION_STAGES, EventLocationReopenService } from '../EventLocationReopenService';
import { PipelineStateService } from '../PipelineStateService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SOURCE THAT MOVES AN EVENT'S PLACE PUTS IT BACK IN FRONT OF THE STAGES THAT
 * DECIDED ON THE OLD ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The stages decide on an event's place once and record `done` or `skipped`, and
 * THE ONE RULE never offers the row again at that version. When a calendar
 * connection re-delivers a meeting whose place changed, `CalendarEventService`
 * moves the place and re-opens those decisions through `EVENT_LOCATION_REOPENER`.
 * The service-level spec (memory/…/CalendarEventService.sourceLocation) fakes
 * that contract; this one runs the real thing against the real ledger:
 *
 *  1. the four decisions that read the place (the geocode, the reverse geocode,
 *     the estimate and the place link) go back to version 0, whether they were
 *     `done` or `skipped`, and no other decision does, nor any other event's;
 *  2. THE ONE RULE then offers the event to each of them again, through the
 *     stage's own applicability predicate: that is what "re-opened" means;
 *  3. a decision a stage is in the middle of (`running`) is a live claim and is
 *     left alone;
 *  4. the re-open commits with the move and rolls back with it.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or
 * `MEMORY_TEST_DATABASE_URL`) to a database with the migrations applied.
 */
const DATABASE_ENV = { urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/EventLocationReopen.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const START = new Date('2026-10-07T17:00:00Z');
const END = new Date('2026-10-07T18:00:00Z');

const point = (longitude: number, latitude: number): Point => ({
  type: 'Point',
  coordinates: [longitude, latitude],
});
const ROMA = point(12.4964, 41.9028);
const APPIA = point(12.5113, 41.8719);

const logger = () =>
  ({ setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) as never;

describeWithDb(`an event's source moving its place, against the ledger (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: CalendarEventService;
  let ledger: PipelineStateService;
  /** The meeting under test and its neighbour: two identities, so two events. */
  let uidA: string;
  let uidB: string;

  const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const signalling = { send: jest.fn(async () => undefined) };
  const timeReopener = { reopenTimeDecisions: jest.fn(async () => 0) };

  const stages = new Map<string, Stage>([
    [STAGE_IDS.ENRICH_GEOCODE, new GeocodeStage({} as never, {} as never, logger())],
    [STAGE_IDS.ENRICH_EVENT_REVERSE, new EventReverseStage({} as never, {} as never, logger(), {} as never)],
    [STAGE_IDS.ENRICH_ESTIMATE_LOCATION, new EstimateLocationStage({} as never, logger())],
    [STAGE_IDS.PROMOTE_PLACE, new PlacePromoteStage({} as never, {} as never, logger())],
  ]);

  // The real service, over the real ledger. The registry only supplies the stages.
  type Reopen = (ids: readonly string[], manager: { query: DataSource['query'] }) => Promise<number>;
  let realReopen: Reopen;
  /** What the module hands the refresh: the real service, unless a test wraps it. */
  let reopen: Reopen;

  function delivery(forUid: string, over: Record<string, unknown> = {}) {
    const identity = calendarEventIdentity(forUid, undefined);

    return {
      title: 'Lunch with Ada',
      event_type: 'calendar_event',
      start_time: START,
      end_time: END,
      status: 'confirmed',
      location_name: 'Cafe Roma',
      location_coordinates: ROMA,
      confidence_score: 0.8,
      source_type: 'ETL',
      source_system: identity?.system,
      source_id: identity?.id,
      ...over,
    };
  }

  async function decide(
    eventId: string,
    stage: string,
    status: 'done' | 'skipped' | 'running',
    version?: number,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, reason, attempts, user_id)
       VALUES ('event', $1::uuid, $2, $3, $4, $5, 1, $6::uuid)`,
      [
        eventId,
        stage,
        version ?? stages.get(stage)?.version ?? 1,
        status,
        status === 'skipped' ? 'zero_results' : null,
        ctx.userId,
      ],
    );
  }

  async function ledgerOf(eventId: string): Promise<Record<string, { version: number; status: string }>> {
    const rows: Array<{ stage: string; stage_version: number; status: string }> = await dataSource.query(
      `SELECT stage, stage_version, status FROM ci.pipeline_state
        WHERE entity_type = 'event' AND entity_id = $1 ORDER BY stage`,
      [eventId],
    );

    return Object.fromEntries(
      rows.map((row) => [row.stage, { version: row.stage_version, status: row.status }]),
    );
  }

  /** The event is stale for `stage` if THE ONE RULE would offer it now. */
  async function offeredTo(stage: string, eventId: string): Promise<boolean> {
    const offered = await ledger.selectStale(stages.get(stage) as Stage, ctx.userId, null, 100);

    return offered.includes(eventId);
  }

  async function decideEverything(eventId: string): Promise<void> {
    await decide(eventId, STAGE_IDS.ENRICH_GEOCODE, 'skipped');
    await decide(eventId, STAGE_IDS.ENRICH_EVENT_REVERSE, 'done');
    await decide(eventId, STAGE_IDS.ENRICH_ESTIMATE_LOCATION, 'skipped');
    await decide(eventId, STAGE_IDS.PROMOTE_PLACE, 'done');
    await decide(eventId, STAGE_IDS.PROMOTE_EDGE_EVENT, 'done', 1);
    await decide(eventId, STAGE_IDS.INDEX_VECTOR_EVENT, 'done', 1);
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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/EventLocationReopen');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Location reopen fixture', $2, 'x', true, 'UTC')`,
      [ctx.userId, `location-reopen.${ctx.userId}@example.test`],
    );

    ledger = new PipelineStateService(dataSource, logger());
    const real = new EventLocationReopenService(ledger, {
      get: (id: string) => stages.get(id) as Stage,
    } as never);
    realReopen = (ids, manager) => real.reopenLocationDecisions(ids, manager);
    reopen = realReopen;

    const moduleRef = {
      // As Nest's does: by token, and an unbound one is an error rather than an undefined.
      get: (token: string) => {
        if (token === EVENT_LOCATION_REOPENER) {
          return { reopenLocationDecisions: (ids: string[], manager: never) => reopen(ids, manager) };
        }

        if (token === EVENT_TIME_REOPENER) {
          return timeReopener;
        }

        if (token === EVENT_STATUS_REOPENER) {
          return { reopenStatusDecisions: async () => 0 };
        }

        throw new Error(`No provider is bound to ${token}.`);
      },
    };

    service = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      signalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, logger()),
      undefined,
      moduleRef as never,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    reopen = realReopen;
    uidA = `reopen-a-${uuidv7()}@example.test`;
    uidB = `reopen-b-${uuidv7()}@example.test`;
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.pipeline_state WHERE user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
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

  const MOVED = { location_name: 'Cafe Roma, 12 Via Appia', location_coordinates: APPIA };

  it('puts the event back in front of the four stages that read its place, and no other', async () => {
    const [stored] = await service.create(ctx, delivery(uidA));
    const [neighbour] = await service.create(ctx, delivery(uidB));
    await decideEverything(stored.id);
    await decideEverything(neighbour.id);

    // Decided at the current version: the rule has nothing to offer.
    for (const stage of EVENT_LOCATION_STAGES) {
      expect(await offeredTo(stage, stored.id)).toBe(false);
    }

    await service.create(ctx, delivery(uidA, MOVED));

    // The four decisions went back to version 0, whether the stage had recorded
    // `done` or `skipped`. The edge leg and the search index are not among them:
    // the first is re-opened by promote.place's own `done`, the second by the
    // update event the refresh publishes.
    expect(await ledgerOf(stored.id)).toEqual({
      [STAGE_IDS.ENRICH_GEOCODE]: { version: 0, status: 'skipped' },
      [STAGE_IDS.ENRICH_EVENT_REVERSE]: { version: 0, status: 'done' },
      [STAGE_IDS.ENRICH_ESTIMATE_LOCATION]: { version: 0, status: 'skipped' },
      [STAGE_IDS.PROMOTE_PLACE]: { version: 0, status: 'done' },
      [STAGE_IDS.PROMOTE_EDGE_EVENT]: { version: 1, status: 'done' },
      [STAGE_IDS.INDEX_VECTOR_EVENT]: { version: 1, status: 'done' },
    });
    // Another event's decisions are not this event's to re-open.
    for (const state of Object.values(await ledgerOf(neighbour.id))) {
      expect(state.version).toBeGreaterThan(0);
    }

    // That is what "re-opened" means: THE ONE RULE offers it again, through each
    // stage's own applicability predicate.
    for (const stage of EVENT_LOCATION_STAGES) {
      expect(await offeredTo(stage, stored.id)).toBe(true);
      expect(await offeredTo(stage, neighbour.id)).toBe(false);
    }
  });

  it('leaves a decision a stage is in the middle of: it is a live claim', async () => {
    const [stored] = await service.create(ctx, delivery(uidA));
    await decide(stored.id, STAGE_IDS.PROMOTE_PLACE, 'running');
    await decide(stored.id, STAGE_IDS.ENRICH_GEOCODE, 'done');

    await service.create(ctx, delivery(uidA, MOVED));

    expect(await ledgerOf(stored.id)).toMatchObject({
      [STAGE_IDS.PROMOTE_PLACE]: { version: stages.get(STAGE_IDS.PROMOTE_PLACE)?.version, status: 'running' },
      [STAGE_IDS.ENRICH_GEOCODE]: { version: 0, status: 'done' },
    });
  });

  it('touches no decision when the place did not move', async () => {
    const [stored] = await service.create(ctx, delivery(uidA));
    await decideEverything(stored.id);
    const before = await ledgerOf(stored.id);

    // The source repeats itself, and then changes only the title.
    await service.create(ctx, delivery(uidA));
    await service.create(ctx, delivery(uidA, { title: 'Lunch with Ada (renamed)' }));

    expect(await ledgerOf(stored.id)).toEqual(before);
  });

  it('commits the re-open with the move, or neither', async () => {
    const [stored] = await service.create(ctx, delivery(uidA));
    await decideEverything(stored.id);
    const before = await ledgerOf(stored.id);

    // The ledger is written, and then the pipeline fails before the refresh commits.
    reopen = async (ids, manager) => {
      await realReopen(ids, manager);

      throw new Error('pipeline unavailable');
    };

    await expect(service.create(ctx, delivery(uidA, MOVED))).rejects.toThrow('pipeline unavailable');

    // Rolled back whole: the ledger still says what it said, and so does the row,
    // so the source's next delivery retries the move.
    expect(await ledgerOf(stored.id)).toEqual(before);
    const [{ location_name }] = await dataSource.query(
      'SELECT location_name FROM ci.events WHERE event_id = $1',
      [stored.id],
    );
    expect(location_name).toBe('Cafe Roma');
  });
});

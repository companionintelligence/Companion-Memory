import { DataSource, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { DeterministicEdgeBackfillService } from '@ci/domains/maintenance';
import { GraphDeltaWriter, PlaceEntity, PlaceMergeService } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PIPELINE_QUEUES } from '../../constants';
import { PipelineSliceListener } from '../../listeners/PipelineSliceListener';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { Stage } from '../../types';
import {
  EventEdgePromoteStage,
  PlaceEdgePromoteStage,
  PositionEdgePromoteStage,
  PROMOTE_EDGE_EVENT_VERSION,
  PROMOTE_EDGE_PLACE_VERSION,
  PROMOTE_EDGE_POSITION_VERSION,
} from '../promote/EdgePromoteStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EDGE THE PROJECTION COMMITS WHILE A PLACE MERGE IS RUNNING IS MOVED ONTO
 * THE SURVIVOR — NOT DELETED WITH THE LOSER'S LEFTOVERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The place twin of `PersonMergeRacesEdgeProjection.integration.spec.ts`; read
 * that file's header for the mechanism. In short: `PlaceMergeService.
 * repointReferences` is ONE transaction at READ COMMITTED, so every statement in
 * it takes its own snapshot. It re-points the columns the edge projection reads
 * (`ci.events.location_entity_id`, `ci.position.location_entity_id`,
 * `ci.entities.parent_place_id`, …), re-points the losers' edges with a guarded
 * UPDATE, and then used to DELETE whatever loser edges were left, on the premise
 * that the UPDATE had declined each one as a duplicate.
 *
 * Until the merge commits, the projection still reads those columns as the LOSER
 * and writes the loser's edge — `ci.relationships` has no foreign key to
 * `ci.entities`, and a plain read does not wait for the merge's `FOR UPDATE` —
 * so an edge committed after the UPDATE's snapshot and before the DELETE's was
 * deleted without a delta, while the merge committed the column pointing at the
 * survivor and the leg's ledger row (`running` throughout) was stamped `done`.
 * Nothing offers that row to the leg again: the survivor never gets the edge.
 *
 * Several legs write an edge whose end is a place; three of them are driven here
 * by the REAL stage, worker and ledger:
 *
 *  - `promote.edge_event` — `ci.events.location_entity_id`, Event −LOCATED_AT→ Place;
 *  - `promote.edge_position` — `ci.position.location_entity_id`, the owner's
 *    Person −VISITED→ Place;
 *  - `promote.edge_place` — `ci.entities.parent_place_id`, Place −PART_OF→ Place,
 *    the one that puts the LOSER at the `from` end of its edge.
 *
 * What only a real database can show, and a stubbed `query` would agree with
 * unconditionally:
 *
 *  1. the loss is real — on a merge that ends in the plain DELETE the survivor is
 *     left without the edge while the ledger says the row is `done` (each test
 *     asserts the ledger first, so a failing run shows both);
 *  2. the sweep moves what it finds onto the survivor instead — same
 *     `relationship_id`, same every other column — so a `relationship/created`
 *     delta never outlives its edge, and writes one `relationship/updated` delta
 *     per edge it moved, which is also how the race is counted;
 *  3. the sweep still drops what the survivor already holds, keeps the oldest of
 *     several losers' edges onto one shape, and keeps inactive history;
 *  4. a swept edge that would become a self-reference is dropped, not inserted —
 *     `no_self_references` is a CHECK, which no `ON CONFLICT` can absorb, and it
 *     would abort the whole merge;
 *  5. the sweep and the deltas it writes are part of the merge's transaction: a
 *     merge that fails after the sweep leaves no moved edge and no delta behind.
 *
 * The interleave is exact rather than lucky. The merge runs on the real
 * `PlaceMergeService` against the real manager; the only stand-in is that its
 * `em.query` is wrapped to run a callback the moment a named statement returns.
 * The callback runs the projection (or another writer's INSERT) on a different
 * pooled connection and waits for its commit, so it lands strictly between the
 * guarded UPDATE's snapshot and the sweep's.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. Every
 * fixture belongs to a synthetic user (one per test) and is deleted in `afterAll`.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://… yarn workspace @ci/be-api jest PlaceMergeRacesEdgeProjection.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PlaceMergeRacesEdgeProjection.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** What a test runs once a named statement of the merge has returned. */
interface Interleave {
  /** After the guarded UPDATE that re-points `from_entity_id` — the last read of the from side before its sweep. */
  afterFromRepoint?: () => Promise<void>;
  /** After the guarded UPDATE that re-points `to_entity_id`. */
  afterToRepoint?: () => Promise<void>;
  /**
   * Just before the merge writes its audit row — after both sweeps and every
   * delta they wrote. A hook that throws fails the merge at exactly that point.
   */
  beforeAudit?: () => void | Promise<void>;
}

interface EdgeRow {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  is_active: boolean;
}

interface MergeCounts {
  events: number;
  positions: number;
  relationshipsFrom: number;
  relationshipsTo: number;
  relationshipsDropped: number;
  relationshipsRescued: number;
}

function makeLogger() {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  };
}

describeWithDb(`a place merge racing the edge projection, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  /** One synthetic user per test, so a test's edges and deltas are the only ones its checks can see. */
  let ctx: UserServiceContext;

  let ledger: PipelineStateService;
  let eventStage: EventEdgePromoteStage;
  let positionStage: PositionEdgePromoteStage;
  let placeStage: PlaceEdgePromoteStage;
  let worker: PipelineSliceListener;
  let merger: PlaceMergeService;

  /** Set by the test for the duration of one merge; read by the wrapped `em.query`. */
  let interleave: Interleave = {};
  const userIds: string[] = [];
  const ledgerIds: string[] = [];
  /** `ci.position` is keyed (time, user_id): every fix needs its own minute. */
  let fixMinute = 0;

  /**
   * The merge's own transaction, with `query` wrapped. Everything else is the
   * real `EntityManager`, so every statement runs for real, in one real
   * transaction — the callback just gets to run between two of them.
   */
  function interleaving(em: EntityManager): EntityManager {
    return new Proxy(em, {
      get(target, property, receiver) {
        if (property !== 'query') {
          return Reflect.get(target, property, receiver);
        }

        return async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO ci.entity_merges')) {
            await interleave.beforeAudit?.();
          }

          const result = await target.query(sql, params);

          if (sql.includes('UPDATE ci.relationships r SET from_entity_id')) {
            await interleave.afterFromRepoint?.();
          }

          if (sql.includes('UPDATE ci.relationships r SET to_entity_id')) {
            await interleave.afterToRepoint?.();
          }

          return result;
        };
      },
    });
  }

  async function mergeDuring(hooks: Interleave, sources: string[], target: string): Promise<void> {
    interleave = hooks;

    try {
      await merger.mergePlaces(ctx, sources, target);
    } finally {
      interleave = {};
    }
  }

  /** Wrap a callback so a test can tell it really ran inside the merge — an interleave that never fired proves nothing. */
  function once(
    label: string,
    run: () => Promise<void>,
  ): { hook: () => Promise<void>; fired: () => boolean } {
    let ran = false;

    return {
      hook: async () => {
        if (ran) {
          throw new Error(`the "${label}" interleave fired twice`);
        }

        ran = true;
        await run();
      },
      fired: () => ran,
    };
  }

  async function entity(type: string, name: string, parent: string | null = null): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, parent_place_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5)`,
      [id, type, name, ctx.userId, parent],
    );

    return id;
  }

  const place = (name: string, parent: string | null = null) => entity('Location', name, parent);
  const person = (name: string) => entity('Person', name);

  /** An event at a place, plus its CTI base row, which the projection joins as the edge's Event endpoint. */
  async function eventAt(placeId: string): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, 'events', $1)`,
      [id, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, location_entity_id) VALUES ($1, $2, now(), $3)`,
      [id, ctx.userId, placeId],
    );
    ledgerIds.push(id);

    return id;
  }

  /**
   * A GPS fix snapped to a place. The fixes are dated 1985, before any real
   * history, and the table is a hypertable: nothing here can touch a real chunk.
   */
  async function fixAt(placeId: string): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.position (id, time, user_id, location, source, location_entity_id)
       VALUES ($1, '1985-03-01T00:00:00Z'::timestamptz + make_interval(mins => $2::int), $3,
               'SRID=4326;POINT(-117.748 33.695)'::geography, 'gps', $4)`,
      [id, fixMinute++, ctx.userId, placeId],
    );
    ledgerIds.push(id);

    return id;
  }

  /** The `position.visited` rule starts its edge at the OWNER's Person entity, so the user has to have one. */
  async function ownerPerson(name: string): Promise<string> {
    const id = await person(name);

    await dataSource.query('UPDATE ci.users SET entity_id = $2 WHERE id = $1', [ctx.userId, id]);

    return id;
  }

  /** One slice through the real worker, exactly as a dispatched job arrives: claim, project, `complete()`. */
  async function project(stage: Stage, entityType: string, ids: string[]): Promise<void> {
    await worker.handleSlice(PIPELINE_QUEUES.INDEX, {
      stage: stage.id,
      entityType,
      userId: ctx.userId,
      ids,
    });
  }

  async function ledgerRow(stage: Stage, entityType: string, id: string) {
    const [row] = await dataSource.query(
      `SELECT status, stage_version FROM ci.pipeline_state
        WHERE entity_type = $1 AND entity_id = $2 AND stage = $3`,
      [entityType, id, stage.id],
    );

    return row as { status: string; stage_version: number } | undefined;
  }

  async function edgesAt(entityId: string, end: 'from_entity_id' | 'to_entity_id'): Promise<EdgeRow[]> {
    return dataSource.query(
      `SELECT relationship_id, from_entity_id, to_entity_id, relationship_type, is_active
         FROM ci.relationships
        WHERE owner_user_id = $1 AND ${end} = $2
        ORDER BY relationship_type, to_entity_id, from_entity_id`,
      [ctx.userId, entityId],
    );
  }

  /** Every edge touching ANY of `entityIds` at either end. */
  async function edgesTouching(entityIds: string[]): Promise<EdgeRow[]> {
    return dataSource.query(
      `SELECT relationship_id, from_entity_id, to_entity_id, relationship_type, is_active
         FROM ci.relationships
        WHERE owner_user_id = $1 AND (from_entity_id = ANY($2::uuid[]) OR to_entity_id = ANY($2::uuid[]))
        ORDER BY relationship_type, to_entity_id, from_entity_id`,
      [ctx.userId, entityIds],
    );
  }

  /** The columns of one edge other than the ones a merge moves. */
  async function otherColumns(relationshipId: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await dataSource.query(
      `SELECT to_jsonb(r) - 'from_entity_id' - 'to_entity_id' AS rest
         FROM ci.relationships r WHERE relationship_id = $1`,
      [relationshipId],
    );

    return row?.rest;
  }

  async function mergeCounts(target: string): Promise<MergeCounts> {
    const [row] = await dataSource.query(
      `SELECT details->'counts' AS counts FROM ci.entity_merges
        WHERE owner_user_id = $1 AND target_entity_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.userId, target],
    );

    return row.counts;
  }

  /**
   * In WRITE order. `delta_id` is a uuidv7 minted when the row is written;
   * `changed_at` defaults to `now()`, which is the start of the writer's
   * TRANSACTION — so the merge's delta, written inside a transaction that began
   * before the projection committed, carries the earlier `changed_at`.
   */
  async function deltasFor(relationshipId: string) {
    return dataSource.query(
      `SELECT change_type, change_source, change_reason, relationship_type, from_entity_id, to_entity_id,
              changed_fields, changed_by_user_id
         FROM ci.graph_deltas
        WHERE owner_user_id = $1 AND node_type = 'relationship' AND relationship_id = $2
        ORDER BY delta_id`,
      [ctx.userId, relationshipId],
    ) as Promise<
      Array<{
        change_type: string;
        change_source: string;
        change_reason: string | null;
        relationship_type: string;
        from_entity_id: string;
        to_entity_id: string;
        changed_fields: Record<string, { old?: unknown; new?: unknown }>;
        changed_by_user_id: string | null;
      }>
    >;
  }

  /**
   * The check the person-merge loss was found with: a delta for a relationship
   * that is no longer in `ci.relationships`, which is what a silent hard delete
   * leaves behind. Scoped to this test's user.
   */
  async function deltasOfVanishedEdges(): Promise<string[]> {
    const rows: Array<{ relationship_id: string }> = await dataSource.query(
      `SELECT d.relationship_id
         FROM ci.graph_deltas d
         LEFT JOIN ci.relationships r ON r.relationship_id = d.relationship_id
        WHERE d.owner_user_id = $1 AND d.node_type = 'relationship' AND r.relationship_id IS NULL`,
      [ctx.userId],
    );

    return rows.map((row) => row.relationship_id);
  }

  /** Another writer's INSERT, committed on its own connection. Every column set, so a copy that drops one shows. */
  async function insertEdge(
    from: string,
    to: string,
    type: string,
    overrides: {
      createdAt?: string;
      active?: boolean;
      strength?: number;
      properties?: Record<string, unknown>;
      fromType?: string;
      toType?: string;
    } = {},
  ): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO ci.relationships
              (from_entity_id, to_entity_id, relationship_type, owner_user_id, strength, properties,
               is_bidirectional, is_active, start_date, end_date, created_at, updated_at,
               from_entity_type, to_entity_type)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, $7, '2019-05-06', '2019-12-31', $8::timestamptz,
               $8::timestamptz + interval '1 day', $9, $10)
       RETURNING relationship_id`,
      [
        from,
        to,
        type,
        ctx.userId,
        overrides.strength ?? 0.37,
        JSON.stringify(overrides.properties ?? { note: `${type} ${from.slice(-4)}→${to.slice(-4)}` }),
        overrides.active ?? true,
        overrides.createdAt ?? '2020-03-04T05:06:07Z',
        overrides.fromType ?? 'Person',
        overrides.toType ?? 'Location',
      ],
    );

    return row.relationship_id;
  }

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

    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'pipeline/PlaceMergeRacesEdgeProjection.integration',
    );

    const logger = () => makeLogger() as never;
    const edgeService = () =>
      new DeterministicEdgeBackfillService(dataSource, new GraphDeltaWriter(dataSource, logger()), logger());

    ledger = new PipelineStateService(dataSource, logger());
    eventStage = new EventEdgePromoteStage(edgeService(), logger());
    positionStage = new PositionEdgePromoteStage(edgeService(), logger());
    placeStage = new PlaceEdgePromoteStage(edgeService(), logger());

    const stages = new Map<string, Stage>(
      [eventStage, positionStage, placeStage].map((stage) => [stage.id, stage]),
    );
    worker = new PipelineSliceListener(
      {
        get: (stageId: string): Stage => {
          const stage = stages.get(stageId);

          if (stage == null) {
            throw new Error(`Unknown pipeline stage "${stageId}".`);
          }

          return stage;
        },
      } as never,
      ledger,
      makeLogger() as never,
    );

    merger = new PlaceMergeService(
      {
        manager: {
          transaction: <T>(work: (em: EntityManager) => Promise<T>): Promise<T> =>
            dataSource.manager.transaction((em) => work(interleaving(em))),
        },
        // The merge's last step reads the target back for its return value;
        // what it returns is not under test here.
        findOne: async () => Object.assign(new PlaceEntity(), { id: uuidv7(), properties: {} }),
      } as never,
      logger() as LoggerService,
      { send: async () => [] } as never,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  beforeEach(async () => {
    ctx = {
      userId: await createSyntheticTestUser(
        (sql, params) => dataSource.query(sql, params),
        'PlaceMergeRacesEdgeProjection',
      ),
    } as UserServiceContext;
    userIds.push(ctx.userId);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [ledgerIds]);

      for (const userId of userIds) {
        await dataSource.query('DELETE FROM ci.pipeline_state WHERE user_id = $1', [userId]);
        await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [userId]);
        await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
        await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
        await dataSource.query('DELETE FROM ci.position WHERE user_id = $1', [userId]);
        await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [userId]);
        await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [userId]);
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
        await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      }

      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('moves the Event → Place edges a projection commits mid-merge onto the survivor, keeping each edge and its deltas whole', async () => {
    const loser = await place('61 Plantation');
    const survivor = await place('61 Plantation, Irvine');
    const elsewhere = await place('Blue Bottle Coffee');

    // Two events at the loser and one elsewhere, none projected yet.
    const first = await eventAt(loser);
    const second = await eventAt(loser);
    const unrelated = await eventAt(elsewhere);

    let projected: EdgeRow[] = [];
    let elsewhereEdges: EdgeRow[] = [];
    const projection = once('projection', async () => {
      await project(eventStage, 'event', [first, second, unrelated]);
      projected = await edgesAt(loser, 'to_entity_id');
      elsewhereEdges = await edgesAt(elsewhere, 'to_entity_id');
    });

    await mergeDuring({ afterToRepoint: projection.hook }, [loser], survivor);

    // The interleave really happened: the projection committed the LOSER's edges
    // (it read the columns the merge had not yet committed) while the merge ran.
    expect(projection.fired()).toBe(true);
    expect(projected.map((edge) => [edge.relationship_type, edge.from_entity_id]).sort()).toEqual(
      [
        ['LOCATED_AT', first],
        ['LOCATED_AT', second],
      ].sort(),
    );

    // The leg's ledger already says "decided" — the projection ran to completion
    // inside the merge's window — so what follows has to make that TRUE: the
    // survivor must have its edges. On a merge that ends in a plain DELETE it
    // has none, and nothing would ever offer the events to the leg again.
    for (const id of [first, second, unrelated]) {
      expect(await ledgerRow(eventStage, 'event', id)).toEqual({
        status: 'done',
        stage_version: PROMOTE_EDGE_EVENT_VERSION,
      });
    }

    // The survivor holds exactly those edges — the SAME rows, re-seated.
    expect(await edgesAt(survivor, 'to_entity_id')).toEqual(
      projected.map((edge) => ({ ...edge, to_entity_id: survivor, is_active: true })),
    );
    expect(await edgesTouching([loser])).toEqual([]);

    // …and they agree with the column the merge wrote.
    const locations: Array<{ event_id: string; location_entity_id: string }> = await dataSource.query(
      `SELECT event_id, location_entity_id FROM ci.events WHERE user_id = $1 ORDER BY event_id`,
      [ctx.userId],
    );
    expect(Object.fromEntries(locations.map((row) => [row.event_id, row.location_entity_id]))).toEqual({
      [first]: survivor,
      [second]: survivor,
      [unrelated]: elsewhere,
    });

    // Every `created` delta still names an edge that exists; the check the
    // person-merge incident was found with comes back empty.
    expect(await deltasOfVanishedEdges()).toEqual([]);

    // The merge says what it did: one `updated` delta per swept edge, on top of
    // the projection's `created` one, naming the place the edge came from.
    for (const edge of projected) {
      const deltas = await deltasFor(edge.relationship_id);

      expect(deltas.map((delta) => delta.change_type)).toEqual(['created', 'updated']);
      expect(deltas[0]).toMatchObject({
        change_source: 'DeterministicEdgeBackfillService',
        to_entity_id: loser,
      });
      expect(deltas[1]).toMatchObject({
        change_source: 'PlaceMergeService.mergePlaces',
        change_reason: 'place_merge.rescued_edge',
        relationship_type: 'LOCATED_AT',
        from_entity_id: edge.from_entity_id,
        to_entity_id: survivor,
        changed_by_user_id: ctx.userId,
        changed_fields: { to_entity_id: { old: loser, new: survivor } },
      });
    }

    // …and the audit row counts them, apart from the rows the UPDATE moved and
    // the rows the sweep dropped.
    expect(await mergeCounts(survivor)).toMatchObject({
      events: 2,
      relationshipsFrom: 0,
      relationshipsTo: 0,
      relationshipsDropped: 0,
      relationshipsRescued: 2,
    });

    // The unrelated place's own edge was written once and left exactly as it was.
    expect(elsewhereEdges).toHaveLength(1);
    expect(await edgesAt(elsewhere, 'to_entity_id')).toEqual(elsewhereEdges);
  });

  it('moves the owner’s VISITED edge a position projection commits mid-merge onto the survivor', async () => {
    const owner = await ownerPerson('Alex Owner');
    const loser = await place('Coffee Bean #12');
    const survivor = await place('The Coffee Bean & Tea Leaf, Irvine');

    // Two fixes at the same place collapse to ONE edge: the projection's DISTINCT.
    const fixes = [await fixAt(loser), await fixAt(loser)];

    let projected: EdgeRow[] = [];
    const projection = once('projection', async () => {
      await project(positionStage, 'position', fixes);
      projected = await edgesAt(loser, 'to_entity_id');
    });

    await mergeDuring({ afterToRepoint: projection.hook }, [loser], survivor);

    expect(projection.fired()).toBe(true);
    expect(projected.map((edge) => [edge.relationship_type, edge.from_entity_id])).toEqual([
      ['VISITED', owner],
    ]);

    // The leg already says "decided"; the owner's one VISITED edge has to be
    // there to make that true — the same row, now at the survivor.
    for (const id of fixes) {
      expect(await ledgerRow(positionStage, 'position', id)).toEqual({
        status: 'done',
        stage_version: PROMOTE_EDGE_POSITION_VERSION,
      });
    }

    expect(await edgesAt(survivor, 'to_entity_id')).toEqual(
      projected.map((edge) => ({ ...edge, to_entity_id: survivor, is_active: true })),
    );
    expect(await edgesAt(owner, 'from_entity_id')).toHaveLength(1);
    expect(await edgesTouching([loser])).toEqual([]);

    expect(await deltasOfVanishedEdges()).toEqual([]);
    const deltas = await deltasFor(projected[0].relationship_id);
    expect(deltas.map((delta) => delta.change_type)).toEqual(['created', 'updated']);
    expect(deltas[1]).toMatchObject({
      change_reason: 'place_merge.rescued_edge',
      from_entity_id: owner,
      to_entity_id: survivor,
      changed_fields: { to_entity_id: { old: loser, new: survivor } },
    });

    expect(await mergeCounts(survivor)).toMatchObject({
      positions: 2,
      relationshipsDropped: 0,
      relationshipsRescued: 1,
    });
  });

  it('moves a child place’s PART_OF edge a place projection commits mid-merge onto the survivor — the loser at the FROM end', async () => {
    const city = await place('Irvine');
    const loser = await place('61 Plantation', city);
    const survivor = await place('61 Plantation, Irvine');

    let projected: EdgeRow[] = [];
    const projection = once('projection', async () => {
      await project(placeStage, 'place', [loser]);
      projected = await edgesAt(loser, 'from_entity_id');
    });

    await mergeDuring({ afterFromRepoint: projection.hook }, [loser], survivor);

    expect(projection.fired()).toBe(true);
    expect(projected.map((edge) => [edge.relationship_type, edge.to_entity_id])).toEqual([['PART_OF', city]]);

    // The loser is tombstoned and its leg row is `done`, which for a merged-away
    // place only means "nothing more to project" — the edge has to be on the
    // survivor, because nothing else will put it there.
    expect(await ledgerRow(placeStage, 'place', loser)).toEqual({
      status: 'done',
      stage_version: PROMOTE_EDGE_PLACE_VERSION,
    });

    // The survivor adopted the loser's parent (the merge's fold), and the edge
    // that says so is the projected one, re-seated: same row, other end unchanged.
    expect(await edgesAt(survivor, 'from_entity_id')).toEqual(
      projected.map((edge) => ({ ...edge, from_entity_id: survivor, is_active: true })),
    );
    expect(await edgesTouching([loser])).toEqual([]);

    const [{ parent_place_id: parent }] = await dataSource.query(
      'SELECT parent_place_id FROM ci.entities WHERE entity_id = $1',
      [survivor],
    );
    expect(parent).toBe(city);

    expect(await deltasOfVanishedEdges()).toEqual([]);
    const deltas = await deltasFor(projected[0].relationship_id);
    expect(deltas.map((delta) => delta.change_type)).toEqual(['created', 'updated']);
    expect(deltas[1]).toMatchObject({
      change_source: 'PlaceMergeService.mergePlaces',
      change_reason: 'place_merge.rescued_edge',
      from_entity_id: survivor,
      to_entity_id: city,
      changed_fields: { from_entity_id: { old: loser, new: survivor } },
    });

    expect(await mergeCounts(survivor)).toMatchObject({
      relationshipsFrom: 0,
      relationshipsDropped: 0,
      relationshipsRescued: 1,
    });
  });

  it('re-creates nothing the survivor already has: a loser duplicate is dropped, the survivor keeps its own edge', async () => {
    const owner = await ownerPerson('Sam Owner');
    const loser = await place('Trader Joe’s');
    const survivor = await place('Trader Joe’s, Irvine');

    // The owner has fixes at BOTH rows of what is really one shop — the usual
    // reason two places get merged. The projection writes both VISITED edges in
    // one commit, and after the merge they are the same shape.
    const fixes = [await fixAt(loser), await fixAt(survivor)];

    let survivorsOwn = '';
    const projection = once('projection', async () => {
      await project(positionStage, 'position', fixes);
      [{ relationship_id: survivorsOwn }] = await edgesAt(survivor, 'to_entity_id');
    });

    await mergeDuring({ afterToRepoint: projection.hook }, [loser], survivor);

    expect(projection.fired()).toBe(true);
    expect(await edgesTouching([loser])).toEqual([]);

    const visited = await edgesAt(survivor, 'to_entity_id');
    expect(visited).toHaveLength(1);
    expect(visited[0]).toMatchObject({ relationship_id: survivorsOwn, from_entity_id: owner });
    expect(await deltasFor(survivorsOwn)).toHaveLength(1);

    expect(await mergeCounts(survivor)).toMatchObject({ relationshipsDropped: 1, relationshipsRescued: 0 });
  });

  it('keeps the oldest of several losers’ edges onto one shape, keeps inactive history, and changes no other column', async () => {
    const first = await place('Home (old)');
    const second = await place('Home (older)');
    const survivor = await place('Home');
    const visitor = await person('Lee Visitor');

    const written: Record<string, string> = {};
    const writer = once('another writer', async () => {
      // The same active shape from both losers — the older row must win — and
      // an inactive twin from each, which are history, not duplicates.
      written.younger = await insertEdge(visitor, first, 'VISITED', {
        createdAt: '2020-01-02T00:00:00Z',
        strength: 0.37,
        properties: { from: 'first' },
      });
      written.older = await insertEdge(visitor, second, 'VISITED', {
        createdAt: '2020-01-01T00:00:00Z',
        strength: 0.81,
        properties: { from: 'second', nested: { a: [1, 2, 3] } },
      });
      written.inactiveFirst = await insertEdge(visitor, first, 'LIVED_IN', { active: false });
      written.inactiveSecond = await insertEdge(visitor, second, 'LIVED_IN', { active: false });
    });

    // Compare every column but the endpoint before and after: whatever the
    // table holds (the unit spec pins the list the service copies) must come
    // out unchanged.
    const before: Record<string, Record<string, unknown> | undefined> = {};
    const snapshot = once('snapshot', async () => {
      await writer.hook();

      for (const [name, id] of Object.entries(written)) {
        before[name] = await otherColumns(id);
      }
    });

    await mergeDuring({ afterToRepoint: snapshot.hook }, [first, second], survivor);

    expect(snapshot.fired()).toBe(true);
    expect(await edgesTouching([first, second])).toEqual([]);

    const atSurvivor = await edgesAt(survivor, 'to_entity_id');
    const ids = atSurvivor.map((edge) => edge.relationship_id).sort();

    // The older active edge survives; the younger duplicate was dropped; both
    // inactive twins are kept.
    expect(ids).toEqual([written.older, written.inactiveFirst, written.inactiveSecond].sort());
    expect(atSurvivor.filter((edge) => edge.is_active).map((edge) => edge.relationship_id)).toEqual([
      written.older,
    ]);

    for (const name of ['older', 'inactiveFirst', 'inactiveSecond']) {
      expect(await otherColumns(written[name])).toEqual(before[name]);
    }

    expect(await otherColumns(written.older)).toMatchObject({
      strength: 0.81,
      is_bidirectional: true,
      start_date: '2019-05-06',
      end_date: '2019-12-31',
      from_entity_type: 'Person',
      to_entity_type: 'Location',
      properties: { from: 'second', nested: { a: [1, 2, 3] } },
    });

    expect(await mergeCounts(survivor)).toMatchObject({ relationshipsDropped: 1, relationshipsRescued: 3 });
  });

  it('drops a swept edge that would become a self-reference instead of aborting the merge', async () => {
    const first = await place('Annex A');
    const second = await place('Annex B');
    const survivor = await place('Annex');
    const other = await place('Main Building');

    const near = { fromType: 'Location', toType: 'Location' };
    const hookA = once('writer after the from re-point', async () => {
      // Both land after the self-reference drop and after the guarded UPDATE.
      // Re-pointed, each would be survivor → survivor.
      await insertEdge(first, second, 'NEAR', near);
      await insertEdge(first, survivor, 'NEAR', near);
      // A healthy edge in the same sweep must still be rescued.
      await insertEdge(first, other, 'NEAR', near);
    });
    const hookB = once('writer after the to re-point', async () => {
      await insertEdge(survivor, first, 'NEAR', near);
      await insertEdge(second, first, 'NEAR', near);
    });

    await expect(
      mergeDuring({ afterFromRepoint: hookA.hook, afterToRepoint: hookB.hook }, [first, second], survivor),
    ).resolves.toBeUndefined();

    expect(hookA.fired() && hookB.fired()).toBe(true);
    expect(await edgesTouching([first, second])).toEqual([]);

    const atSurvivor = await edgesTouching([survivor]);
    expect(
      atSurvivor.map((edge) => [edge.from_entity_id, edge.to_entity_id, edge.relationship_type]),
    ).toEqual([[survivor, other, 'NEAR']]);

    // Four dropped (two from each hook), one moved.
    expect(await mergeCounts(survivor)).toMatchObject({ relationshipsDropped: 4, relationshipsRescued: 1 });
  });

  it('leaves the ordinary orders alone: projection before the merge is re-pointed in place, projection after lands on the survivor', async () => {
    // Projection FIRST — the guarded UPDATE moves the loser's edge, no race.
    const loser = await place('Pier 39');
    const survivor = await place('Pier 39, San Francisco');
    const earlier = await eventAt(loser);

    await project(eventStage, 'event', [earlier]);
    const projected = await edgesAt(loser, 'to_entity_id');
    expect(projected).toHaveLength(1);

    await merger.mergePlaces(ctx, [loser], survivor);

    expect(await edgesAt(survivor, 'to_entity_id')).toEqual(
      projected.map((edge) => ({ ...edge, to_entity_id: survivor })),
    );
    expect(await mergeCounts(survivor)).toMatchObject({
      relationshipsTo: 1,
      relationshipsDropped: 0,
      relationshipsRescued: 0,
    });
    // An in-place re-point writes no delta, exactly as before.
    expect((await deltasFor(projected[0].relationship_id)).map((delta) => delta.change_type)).toEqual([
      'created',
    ]);

    // Projection AFTER — it reads the survivor from the events table, so the
    // survivor gets the edge outright.
    const loser2 = await place('Ferry Building');
    const survivor2 = await place('Ferry Building Marketplace');
    const later = await eventAt(loser2);

    await merger.mergePlaces(ctx, [loser2], survivor2);
    await project(eventStage, 'event', [later]);

    expect(
      (await edgesAt(survivor2, 'to_entity_id')).map((edge) => [edge.relationship_type, edge.from_entity_id]),
    ).toEqual([['LOCATED_AT', later]]);
    expect(await edgesTouching([loser2])).toEqual([]);
    expect(await mergeCounts(survivor2)).toMatchObject({ relationshipsRescued: 0, relationshipsDropped: 0 });
  });

  it('rolls the sweep and its deltas back with the merge when a later statement fails', async () => {
    const loser = await place('Old Town Hall');
    const survivor = await place('Town Hall');
    const event = await eventAt(loser);

    let projected: EdgeRow[] = [];
    const projection = once('projection', async () => {
      await project(eventStage, 'event', [event]);
      projected = await edgesAt(loser, 'to_entity_id');
    });

    // The sweep has already moved the projected edge onto the survivor and
    // written its delta when the merge dies on its audit row.
    await expect(
      mergeDuring(
        {
          afterToRepoint: projection.hook,
          beforeAudit: () => {
            throw new Error('audit write failed');
          },
        },
        [loser],
        survivor,
      ),
    ).rejects.toThrow('audit write failed');

    expect(projection.fired()).toBe(true);
    expect(projected).toHaveLength(1);

    // Nothing of the merge survived: the edge is back where the projection put it…
    expect(await edgesAt(loser, 'to_entity_id')).toEqual(projected);
    expect(await edgesAt(survivor, 'to_entity_id')).toEqual([]);

    // …no delta says otherwise (a delta written outside the merge's transaction
    // would outlive it, and name a move that never happened)…
    expect((await deltasFor(projected[0].relationship_id)).map((delta) => delta.change_type)).toEqual([
      'created',
    ]);

    // …and the loser is still a live place the event still points at.
    const [row] = await dataSource.query(
      `SELECT e.merged_into_entity_id, ev.location_entity_id
         FROM ci.entities e, ci.events ev
        WHERE e.entity_id = $1 AND ev.event_id = $2`,
      [loser, event],
    );
    expect(row).toEqual({ merged_into_entity_id: null, location_entity_id: loser });

    const [{ audits }] = await dataSource.query(
      'SELECT count(*)::int AS audits FROM ci.entity_merges WHERE owner_user_id = $1',
      [ctx.userId],
    );
    expect(audits).toBe(0);
  });
});

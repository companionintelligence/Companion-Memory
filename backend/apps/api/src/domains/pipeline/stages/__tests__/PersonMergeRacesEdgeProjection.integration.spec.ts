import { DataSource, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { DeterministicEdgeBackfillService } from '@ci/domains/maintenance';
import { GraphDeltaWriter, PersonEntity, PersonMergeService } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PIPELINE_QUEUES } from '../../constants';
import { PipelineSliceListener } from '../../listeners/PipelineSliceListener';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { Stage } from '../../types';
import {
  CommunicationEdgePromoteStage,
  PROMOTE_EDGE_COMMUNICATION_STAGE_ID,
  PROMOTE_EDGE_COMMUNICATION_VERSION,
} from '../promote/EdgePromoteStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EDGE THE PROJECTION COMMITS WHILE A PERSON MERGE IS RUNNING IS MOVED ONTO
 * THE SURVIVOR — NOT DELETED WITH THE LOSER'S LEFTOVERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PersonMergeService.repointReferences` is ONE transaction at READ COMMITTED,
 * so every statement in it takes its own snapshot. It re-points the messages'
 * columns, re-points the losers' edges with a guarded UPDATE, and then sweeps
 * whatever loser edges are still there. `promote.edge_communication` projects
 * those same columns into `ci.relationships` on another connection, and
 * until the merge commits it reads the OLD columns: it writes the LOSER's edge.
 * `ci.relationships` has no foreign key to `ci.entities`, so nothing makes it
 * wait for the merge's row locks.
 *
 * A projection that commits after the UPDATE's snapshot and before the
 * sweep's was therefore deleted by the sweep. No delta was written (a hard
 * delete), the merge committed the columns pointing at the survivor, and the
 * leg's ledger row — `running` while all of this happened — was stamped `done`
 * by `complete()`. Nothing offers that message to the edge leg again, so the
 * survivor never got its edge. On the reference appliance five SENT/RECEIVED
 * edges went that way in one merge, during a `DeterministicPersonMergeCron`
 * drain; `ci.graph_deltas` still held their `relationship/created` rows, whose
 * `relationship_id` no longer existed in `ci.relationships`.
 *
 * What only a real database can show, and a stubbed `query` would agree with
 * unconditionally:
 *
 *  1. the loss is real — the actual stage, worker and ledger, interleaved with
 *     the merge's actual statements, leave the survivor without an edge while
 *     the ledger says the message is `done`;
 *  2. the sweep moves what it finds onto the survivor instead — same
 *     `relationship_id`, same every other column — so a `relationship/created`
 *     delta never outlives its edge, and writes one `relationship/updated`
 *     delta per edge it moved, which is also how the race is counted;
 *  3. the sweep still drops what the survivor already holds, keeps the oldest of
 *     several losers' edges onto one shape, and keeps inactive history;
 *  4. a swept edge that would become a self-reference is dropped, not inserted —
 *     `no_self_references` is a CHECK, which no `ON CONFLICT` can absorb, and it
 *     would abort the whole merge.
 *
 * The interleave is exact rather than lucky. The merge runs on the real
 * `PersonMergeService` against the real manager; the only stand-in is that its
 * `em.query` is wrapped to run a callback the moment a named statement returns.
 * The callback runs the projection (or another writer's INSERT) on a different
 * pooled connection and waits for its commit, so it lands strictly between the
 * guarded UPDATE's snapshot and the sweep's.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. Every
 * fixture belongs to a synthetic user and is deleted in `afterAll`.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://… yarn workspace @ci/be-api jest PersonMergeRacesEdgeProjection.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PersonMergeRacesEdgeProjection.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** What a test runs once a named statement of the merge has returned. */
interface Interleave {
  /** After the guarded UPDATE that re-points `from_entity_id` — the last read of the from side before its sweep. */
  afterFromRepoint?: () => Promise<void>;
  /** After the guarded UPDATE that re-points `to_entity_id`. */
  afterToRepoint?: () => Promise<void>;
}

interface EdgeRow {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  is_active: boolean;
}

interface MergeCounts {
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

describeWithDb(`a person merge racing the edge projection, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let ctx: UserServiceContext;

  let ledger: PipelineStateService;
  let edgeStage: CommunicationEdgePromoteStage;
  let worker: PipelineSliceListener;
  let merger: PersonMergeService;

  /** Set by the test for the duration of one merge; read by the wrapped `em.query`. */
  let interleave: Interleave = {};
  const messageIds: string[] = [];

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
      await merger.mergePeople(ctx, sources, target);
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

  async function person(name: string): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Person', $2, '{}'::jsonb, $3)`,
      [id, name, ctx.userId],
    );

    return id;
  }

  /** A message plus its CTI base row, which the projection joins as the edge's Communication endpoint. */
  async function message(from: string, to: string[]): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', $2, 'communications', $1)`,
      [id, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.communications
              (id, time, user_id, communication_type, direction, from_entity_id, to_entity_ids, content)
       VALUES ($1, now(), $2, 'email', 'inbound', $3, $4::uuid[], 'fixture')`,
      [id, ctx.userId, from, to],
    );
    messageIds.push(id);

    return id;
  }

  /** One slice through the real worker, exactly as a dispatched job arrives: claim, project, `complete()`. */
  async function project(ids: string[]): Promise<void> {
    await worker.handleSlice(PIPELINE_QUEUES.INDEX, {
      stage: edgeStage.id,
      entityType: 'communication',
      userId: ctx.userId,
      ids,
    });
  }

  async function ledgerRow(messageId: string) {
    const [row] = await dataSource.query(
      `SELECT status, stage_version FROM ci.pipeline_state
        WHERE entity_type = 'communication' AND entity_id = $1 AND stage = $2`,
      [messageId, PROMOTE_EDGE_COMMUNICATION_STAGE_ID],
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
   * The check this change was found with: a delta for a relationship that is no
   * longer in `ci.relationships`, which is what a silent hard delete leaves behind.
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
    } = {},
  ): Promise<string> {
    const [row] = await dataSource.query(
      `INSERT INTO ci.relationships
              (from_entity_id, to_entity_id, relationship_type, owner_user_id, strength, properties,
               is_bidirectional, is_active, start_date, end_date, created_at, updated_at,
               from_entity_type, to_entity_type)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, $7, '2019-05-06', '2019-12-31', $8::timestamptz,
               $8::timestamptz + interval '1 day', 'Person', 'Person')
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
      'pipeline/PersonMergeRacesEdgeProjection.integration',
    );

    ctx = {
      userId: await createSyntheticTestUser(
        (sql, params) => dataSource.query(sql, params),
        'PersonMergeRacesEdgeProjection',
      ),
    } as UserServiceContext;

    const logger = () => makeLogger() as never;

    ledger = new PipelineStateService(dataSource, logger());
    edgeStage = new CommunicationEdgePromoteStage(
      new DeterministicEdgeBackfillService(dataSource, new GraphDeltaWriter(dataSource, logger()), logger()),
      logger(),
    );
    worker = new PipelineSliceListener(
      {
        get: (stageId: string): Stage => {
          if (stageId !== edgeStage.id) {
            throw new Error(`Unknown pipeline stage "${stageId}".`);
          }

          return edgeStage;
        },
      } as never,
      ledger,
      makeLogger() as never,
    );

    merger = new PersonMergeService(
      {
        manager: {
          transaction: <T>(work: (em: EntityManager) => Promise<T>): Promise<T> =>
            dataSource.manager.transaction((em) => work(interleaving(em))),
        },
        // The merge's last step reads the target back for its return value;
        // what it returns is not under test here.
        findOne: async () =>
          Object.assign(new PersonEntity(), {
            id: uuidv7(),
            entityType: 'Person',
            properties: {},
            isActive: true,
            mergedIntoEntityId: null,
          }),
      } as never,
      logger() as LoggerService,
      { send: async () => [] } as never,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [messageIds]);
      await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('moves the loser edges a projection commits mid-merge onto the survivor, keeping the edge and its deltas whole', async () => {
    const loser = await person('Judy C.');
    const survivor = await person('Judy Collins');
    const friend = await person('Pat Friend');

    // The incident's shape: a message the loser SENT and one it RECEIVED, both
    // already linked, neither projected yet. `promote.edge_communication` writes
    // SENT and RECEIVED in separate transactions, so the merge sees two commits.
    const sent = await message(loser, [friend]);
    const received = await message(friend, [loser]);

    let projected: EdgeRow[] = [];
    let friendsEdges: EdgeRow[] = [];
    const projection = once('projection', async () => {
      await project([sent, received]);
      projected = await edgesAt(loser, 'from_entity_id');
      friendsEdges = await edgesAt(friend, 'from_entity_id');
    });

    await mergeDuring({ afterFromRepoint: projection.hook }, [loser], survivor);

    // The interleave really happened: the projection committed the LOSER's edges
    // (it read the columns the merge had not yet committed) while the merge ran.
    expect(projection.fired()).toBe(true);
    expect(projected.map(({ relationship_type: type, to_entity_id: to }) => [type, to])).toEqual([
      ['RECEIVED', received],
      ['SENT', sent],
    ]);

    // The survivor holds exactly those edges — the SAME rows, re-seated.
    const survivorEdges = await edgesAt(survivor, 'from_entity_id');
    expect(survivorEdges).toEqual(
      projected.map((edge) => ({ ...edge, from_entity_id: survivor, is_active: true })),
    );
    expect(await edgesTouching([loser])).toEqual([]);

    // The ledger says "decided", and for these two messages that is now TRUE:
    // the survivor has its SENT and RECEIVED. Before the fix it was `done` with
    // nothing to show for it, and nothing would ever offer them again.
    for (const id of [sent, received]) {
      expect(await ledgerRow(id)).toEqual({
        status: 'done',
        stage_version: PROMOTE_EDGE_COMMUNICATION_VERSION,
      });
    }

    // Every `created` delta still names an edge that exists; the check the
    // incident was found with comes back empty.
    expect(await deltasOfVanishedEdges()).toEqual([]);

    // The merge says what it did: one `updated` delta per swept edge, on top of
    // the projection's `created` one, naming the person the edge came from.
    for (const edge of projected) {
      const deltas = await deltasFor(edge.relationship_id);

      expect(deltas.map((delta) => delta.change_type)).toEqual(['created', 'updated']);
      expect(deltas[0]).toMatchObject({
        change_source: 'DeterministicEdgeBackfillService',
        from_entity_id: loser,
      });
      expect(deltas[1]).toMatchObject({
        change_source: 'PersonMergeService.mergePeople',
        change_reason: 'person_merge.rescued_edge',
        relationship_type: edge.relationship_type,
        from_entity_id: survivor,
        to_entity_id: edge.to_entity_id,
        changed_by_user_id: ctx.userId,
        changed_fields: { from_entity_id: { old: loser, new: survivor } },
      });
    }

    // …and the audit row counts them, apart from the rows the UPDATE moved and
    // the rows the sweep dropped.
    expect(await mergeCounts(survivor)).toMatchObject({
      relationshipsFrom: 0,
      relationshipsTo: 0,
      relationshipsDropped: 0,
      relationshipsRescued: 2,
    });

    // The friend's own edges — the other half of the same two messages — were
    // written once and left exactly as they were.
    expect(friendsEdges).toHaveLength(2);
    expect(await edgesAt(friend, 'from_entity_id')).toEqual(friendsEdges);
  });

  it('moves a to-side edge another writer commits mid-merge onto the survivor too', async () => {
    const loser = await person('Robin V.');
    const survivor = await person('Robin Vale');
    const friend = await person('Sam Friend');

    let mentorship = '';
    const writer = once('another writer', async () => {
      mentorship = await insertEdge(friend, loser, 'MENTORS');
    });

    await mergeDuring({ afterToRepoint: writer.hook }, [loser], survivor);

    expect(writer.fired()).toBe(true);
    expect(await edgesTouching([loser])).toEqual([]);
    expect(await edgesAt(survivor, 'to_entity_id')).toEqual([
      {
        relationship_id: mentorship,
        from_entity_id: friend,
        to_entity_id: survivor,
        relationship_type: 'MENTORS',
        is_active: true,
      },
    ]);

    const deltas = await deltasFor(mentorship);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      change_type: 'updated',
      change_source: 'PersonMergeService.mergePeople',
      from_entity_id: friend,
      to_entity_id: survivor,
      changed_fields: { to_entity_id: { old: loser, new: survivor } },
    });
    expect(await mergeCounts(survivor)).toMatchObject({ relationshipsDropped: 0, relationshipsRescued: 1 });
  });

  it('re-creates nothing the survivor already has: a loser duplicate is dropped, the survivor keeps its own edge', async () => {
    const loser = await person('Casey L.');
    const survivor = await person('Casey Lund');
    const friend = await person('Drew Friend');

    // One message addressed to BOTH the loser and the survivor. The projection
    // writes both RECEIVED edges in one commit, and after the merge they are
    // the same shape.
    const both = await message(friend, [loser, survivor]);

    let survivorsOwn = '';
    const projection = once('projection', async () => {
      await project([both]);
      [{ relationship_id: survivorsOwn }] = await edgesAt(survivor, 'from_entity_id');
    });

    await mergeDuring({ afterFromRepoint: projection.hook }, [loser], survivor);

    expect(projection.fired()).toBe(true);
    expect(await edgesTouching([loser])).toEqual([]);

    const received = (await edgesAt(survivor, 'from_entity_id')).filter(
      (edge) => edge.relationship_type === 'RECEIVED' && edge.to_entity_id === both,
    );
    expect(received).toHaveLength(1);
    expect(received[0].relationship_id).toBe(survivorsOwn);
    expect(await deltasFor(survivorsOwn)).toHaveLength(1);

    expect(await mergeCounts(survivor)).toMatchObject({ relationshipsDropped: 1, relationshipsRescued: 0 });
  });

  it('keeps the oldest of several losers’ edges onto one shape, keeps inactive history, and changes no other column', async () => {
    const first = await person('Ada Q.');
    const second = await person('Ada Quill');
    const survivor = await person('Ada Q. Quill');
    const colleague = await person('Lee Colleague');

    const written: Record<string, string> = {};
    const writer = once('another writer', async () => {
      // The same active shape from both losers — the older row must win — and
      // an inactive twin from each, which are history, not duplicates.
      written.younger = await insertEdge(first, colleague, 'KNOWS', {
        createdAt: '2020-01-02T00:00:00Z',
        strength: 0.37,
        properties: { from: 'first' },
      });
      written.older = await insertEdge(second, colleague, 'KNOWS', {
        createdAt: '2020-01-01T00:00:00Z',
        strength: 0.81,
        properties: { from: 'second', nested: { a: [1, 2, 3] } },
      });
      written.inactiveFirst = await insertEdge(first, colleague, 'KNEW', { active: false });
      written.inactiveSecond = await insertEdge(second, colleague, 'KNEW', { active: false });
    });

    // Compare every column but the endpoint before and after: whatever the
    // table holds (the spec below pins the list the service copies) must come
    // out unchanged.
    const before: Record<string, Record<string, unknown> | undefined> = {};
    const snapshot = once('snapshot', async () => {
      await writer.hook();

      for (const [name, id] of Object.entries(written)) {
        before[name] = await otherColumns(id);
      }
    });

    await mergeDuring({ afterFromRepoint: snapshot.hook }, [first, second], survivor);

    expect(snapshot.fired()).toBe(true);
    expect(await edgesTouching([first, second])).toEqual([]);

    const atSurvivor = await edgesAt(survivor, 'from_entity_id');
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
      to_entity_type: 'Person',
      properties: { from: 'second', nested: { a: [1, 2, 3] } },
    });

    expect(await mergeCounts(survivor)).toMatchObject({ relationshipsDropped: 1, relationshipsRescued: 3 });
  });

  it('drops a swept edge that would become a self-reference instead of aborting the merge', async () => {
    const first = await person('Mo A.');
    const second = await person('Mo Alvarez');
    const survivor = await person('Mo Al.');
    const other = await person('Kit Other');

    const hookA = once('writer after the from re-point', async () => {
      // Both land after the self-reference drop and after the guarded UPDATE.
      // Re-pointed, each would be survivor → survivor.
      await insertEdge(first, second, 'KNOWS');
      await insertEdge(first, survivor, 'KNOWS');
      // A healthy edge in the same sweep must still be rescued.
      await insertEdge(first, other, 'KNOWS');
    });
    const hookB = once('writer after the to re-point', async () => {
      await insertEdge(survivor, first, 'MENTORS');
      await insertEdge(second, first, 'MENTORS');
    });

    await expect(
      mergeDuring({ afterFromRepoint: hookA.hook, afterToRepoint: hookB.hook }, [first, second], survivor),
    ).resolves.toBeUndefined();

    expect(hookA.fired() && hookB.fired()).toBe(true);
    expect(await edgesTouching([first, second])).toEqual([]);

    const atSurvivor = await edgesTouching([survivor]);
    expect(
      atSurvivor.map((edge) => [edge.from_entity_id, edge.to_entity_id, edge.relationship_type]),
    ).toEqual([[survivor, other, 'KNOWS']]);

    // Four dropped (two from each hook), one moved.
    expect(await mergeCounts(survivor)).toMatchObject({ relationshipsDropped: 4, relationshipsRescued: 1 });
  });

  it('leaves the ordinary orders alone: projection before the merge is re-pointed in place, projection after lands on the survivor', async () => {
    // Projection FIRST — the guarded UPDATE moves the loser's edges, no race.
    const loser = await person('Noa B.');
    const survivor = await person('Noa Bell');
    const friend = await person('Quinn Friend');
    const earlier = await message(loser, [friend]);

    await project([earlier]);
    const projected = await edgesAt(loser, 'from_entity_id');
    expect(projected).toHaveLength(1);

    await merger.mergePeople(ctx, [loser], survivor);

    expect(await edgesAt(survivor, 'from_entity_id')).toEqual(
      projected.map((edge) => ({ ...edge, from_entity_id: survivor })),
    );
    expect(await mergeCounts(survivor)).toMatchObject({
      relationshipsFrom: 1,
      relationshipsDropped: 0,
      relationshipsRescued: 0,
    });
    // An in-place re-point writes no delta, exactly as before.
    expect((await deltasFor(projected[0].relationship_id)).map((delta) => delta.change_type)).toEqual([
      'created',
    ]);

    // Projection AFTER — it resolves the tombstone, so the survivor gets the edge outright.
    const loser2 = await person('Pip C.');
    const survivor2 = await person('Pip Chase');
    const later = await message(loser2, [friend]);

    await merger.mergePeople(ctx, [loser2], survivor2);
    await project([later]);

    expect(
      (await edgesAt(survivor2, 'from_entity_id')).map((edge) => [edge.relationship_type, edge.to_entity_id]),
    ).toEqual([['SENT', later]]);
    expect(await edgesTouching([loser2])).toEqual([]);
    expect(await mergeCounts(survivor2)).toMatchObject({ relationshipsRescued: 0, relationshipsDropped: 0 });
  });
});

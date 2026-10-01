import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphUtilityService } from '../../services/GraphUtilityService';
import { GraphEventListener } from '../GraphEventListener';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A NODE RETYPED OUT OF `Person` — AND THE PERSON INDEX IT LEAVES BEHIND.
 * REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.remember` `entity.update` with another `entityType` queues a
 * GRAPH_NODE_UPSERTED job; GraphEventListener writes it through
 * `createOrUpdateNode` and re-emits the NEW type's search event. Nothing used to
 * touch what the person stages had already written: `INDEX_EMBED_PERSON_SOURCE`
 * selects `entity_type = 'Person'`, so the row is invisible to the person sweeps
 * the moment it is retyped, and they neither refresh nor remove its
 * `ci_search.vectors` row (the search CANDIDATE source), its embedding, its skip
 * marker, or the two `ci.pipeline_state` rows recording the person stages as done.
 *
 * What only Postgres can show: the rows really surviving the write (the
 * control), the data-modifying CTE deleting exactly the five rows it should and
 * none of their neighbours, and the owner / current-type conditions holding.
 *
 * Every test runs in one transaction on one connection and rolls back. Opt-in
 * like the sibling suites: skips with the reason when nothing listens at
 * `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[GraphEventListener.personRetype.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** `ci_search.embeddings.embedding` is `vector(768)`. */
const EMBEDDING = `[${Array.from({ length: 768 }, () => 0.1).join(',')}]`;

const PERSON_STAGES = ['index.embed_person', 'index.vector_person'];

interface IndexState {
  vectors: number;
  embeddings: number;
  index_skips: number;
  /** The two ledger rows the person index stages wrote. */
  person_ledger: number;
  /** Every other ledger row the entity carries; none of them is this change's business. */
  other_ledger: number;
}

const INDEXED_AS_PERSON: IndexState = {
  vectors: 1,
  embeddings: 1,
  index_skips: 1,
  person_ledger: 2,
  other_ledger: 2,
};

const CLEANED: IndexState = {
  ...INDEXED_AS_PERSON,
  vectors: 0,
  embeddings: 0,
  index_skips: 0,
  person_ledger: 0,
};

describeWithDb(`GraphEventListener — a node retyped out of Person (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let service: GraphUtilityService;
  let listener: GraphEventListener;
  let send: jest.Mock;
  let alice: string;
  let bob: string;

  const newUser = (label: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), label);

  /** A Person as the person stages leave it: indexed, with its ledger rows. */
  const indexedPerson = async (ownerId: string, name: string) => {
    const entityId = uuidv7();

    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, description, search_content, properties)
       VALUES ($1, 'Person', $2, $3, $3, $3, '{}'::jsonb)`,
      [entityId, ownerId, name],
    );
    await runner.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, 'person', $2, to_tsvector('simple', $3), $4)`,
      [uuidv7(), entityId, name, ownerId],
    );
    await runner.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, embedding, user_id)
       VALUES ($1, 'person', $2, $3::vector, $4)`,
      [uuidv7(), entityId, EMBEDDING, ownerId],
    );
    await runner.query(
      `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('person', $1, 'empty')`,
      [entityId],
    );

    for (const [entityType, stage] of [
      ['person', PERSON_STAGES[0]],
      ['person', PERSON_STAGES[1]],
      // Neighbours that must survive: a type-agnostic stage, and a Person-only one
      // that is not an index stage.
      ['entity', 'clean.identifier_normalize'],
      ['Person', 'enrich.person_self_claim'],
    ]) {
      await runner.query(
        `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, attempts, user_id)
         VALUES ($1, $2, $3, 1, 'done', 1, $4)`,
        [entityType, entityId, stage, ownerId],
      );
    }

    return entityId;
  };

  const indexState = async (entityId: string): Promise<IndexState> => {
    const [row] = await runner.query(
      `SELECT (SELECT count(*) FROM ci_search.vectors     WHERE entity_id = $1 AND entity_type = 'person')::int AS vectors,
              (SELECT count(*) FROM ci_search.embeddings  WHERE entity_id = $1 AND entity_type = 'person')::int AS embeddings,
              (SELECT count(*) FROM ci_search.index_skips WHERE entity_id = $1 AND entity_type = 'person')::int AS index_skips,
              (SELECT count(*) FROM ci.pipeline_state
                WHERE entity_id = $1 AND stage = ANY($2::text[]))::int AS person_ledger,
              (SELECT count(*) FROM ci.pipeline_state
                WHERE entity_id = $1 AND NOT (stage = ANY($2::text[])))::int AS other_ledger`,
      [entityId, PERSON_STAGES],
    );

    return row;
  };

  const storedType = async (entityId: string): Promise<string> => {
    const [row] = await runner.query(`SELECT entity_type FROM ci.entities WHERE entity_id = $1`, [entityId]);

    return row.entity_type;
  };

  /**
   * The check an operator runs: person search rows whose entity is no longer a
   * Person. Scoped to one owner so another stack's data cannot trip it.
   */
  const orphanedPersonVectors = async (ownerId: string): Promise<number> => {
    const [row] = await runner.query(
      `SELECT count(*)::int AS n
         FROM ci_search.vectors v
         JOIN ci.entities e USING (entity_id)
        WHERE v.entity_type = 'person' AND e.entity_type <> 'Person' AND e.owner_user_id = $1`,
      [ownerId],
    );

    return row.n;
  };

  const upsert = (ownerId: string, node: Record<string, unknown>) =>
    listener.handleNodeUpserted({ ownerId, node } as never);

  beforeAll(async () => {
    const connection = resolveConnection(ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
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
      entities: [GraphNodeEntity, RelationshipEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'GraphEventListener.personRetype');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    alice = await newUser('GraphListener-personRetype-alice');
    bob = await newUser('GraphListener-personRetype-bob');

    service = new GraphUtilityService(
      runner.manager.getRepository(GraphNodeEntity),
      runner.manager.getRepository(RelationshipEntity),
      logger as never,
    );
    send = jest.fn(async () => ['job']);
    listener = new GraphEventListener(service, { send } as never, logger as never);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('control: the node write alone — all the listener used to do — leaves every person index row behind', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');

    await service.createOrUpdateNode(alice, { entityId: jo, entityType: 'Concept' });

    expect(await storedType(jo)).toBe('Concept');
    expect(await indexState(jo)).toEqual(INDEXED_AS_PERSON);
    // And the operator's check sees it: a person search row for a non-person.
    expect(await orphanedPersonVectors(alice)).toBe(1);
  });

  it('drops the vector, embedding, skip marker and both person ledger rows of a Person retyped to a Concept', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');
    expect(await indexState(jo)).toEqual(INDEXED_AS_PERSON);

    await upsert(alice, { entityId: jo, entityType: 'Concept' });

    expect(await storedType(jo)).toBe('Concept');
    expect(await indexState(jo)).toEqual(CLEANED);
    expect(await orphanedPersonVectors(alice)).toBe(0);
    // What the node became is still handed to its own search listener.
    expect(send).toHaveBeenCalledWith('concept.updated', { conceptId: jo });
  });

  it.each(['Location', 'Organization', 'PERSON'])(
    'drops the same five rows when the Person is retyped to %s',
    async (type) => {
      const jo = await indexedPerson(alice, 'Jo Park');

      await upsert(alice, { entityId: jo, entityType: type });

      expect(await storedType(jo)).toBe(type);
      expect(await indexState(jo)).toEqual(CLEANED);
    },
  );

  it("leaves the node's other ledger rows alone: they are not person-index state", async () => {
    const jo = await indexedPerson(alice, 'Jo Park');

    await upsert(alice, { entityId: jo, entityType: 'Concept' });

    const rows = await runner.query(
      `SELECT entity_type, stage FROM ci.pipeline_state WHERE entity_id = $1 ORDER BY stage`,
      [jo],
    );
    expect(rows).toEqual([
      { entity_type: 'entity', stage: 'clean.identifier_normalize' },
      { entity_type: 'Person', stage: 'enrich.person_self_claim' },
    ]);
  });

  it('leaves the rows of a Person that stays a Person, and of every other person, where they were', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');
    const sam = await indexedPerson(alice, 'Sam Lee');
    const bobs = await indexedPerson(bob, 'Bob Ng');

    await upsert(alice, { entityId: jo, entityType: 'Concept' });
    await upsert(alice, { entityId: sam, entityType: 'Person', name: 'Sam Lee-Park' });

    expect(await indexState(jo)).toEqual(CLEANED);
    expect(await indexState(sam)).toEqual(INDEXED_AS_PERSON);
    expect(await indexState(bobs)).toEqual(INDEXED_AS_PERSON);
  });

  it('does not touch rows indexed under the type the node became', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');
    await runner.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, 'concept', $2, to_tsvector('simple', 'Jo Park'), $3)`,
      [uuidv7(), jo, alice],
    );

    await upsert(alice, { entityId: jo, entityType: 'Concept' });

    const [row] = await runner.query(
      `SELECT count(*)::int AS n FROM ci_search.vectors WHERE entity_id = $1 AND entity_type = 'concept'`,
      [jo],
    );
    expect(row.n).toBe(1);
  });

  it('is idempotent: a second pass over the same write changes nothing and does not throw', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');

    await upsert(alice, { entityId: jo, entityType: 'Concept' });
    await upsert(alice, { entityId: jo, entityType: 'Concept' });

    expect(await indexState(jo)).toEqual(CLEANED);
  });

  it('finishes the cleanup on a retry after the first attempt failed once the write had committed', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');
    jest.spyOn(service, 'dropStalePersonIndex').mockRejectedValueOnce(new Error('connection reset'));

    await expect(upsert(alice, { entityId: jo, entityType: 'Concept' })).rejects.toThrow('connection reset');

    // The write landed and the cleanup did not: the retried job's input says
    // nothing about the type having just changed.
    expect(await storedType(jo)).toBe('Concept');
    expect(await indexState(jo)).toEqual(INDEXED_AS_PERSON);

    await upsert(alice, { entityId: jo, entityType: 'Concept' });

    expect(await indexState(jo)).toEqual(CLEANED);
    expect(await orphanedPersonVectors(alice)).toBe(0);
  });

  it('cleans up after a write that only renames a node an earlier write already retyped', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');
    await service.createOrUpdateNode(alice, { entityId: jo, entityType: 'Concept' });

    await upsert(alice, { entityId: jo, name: 'Jo' });

    expect(await indexState(jo)).toEqual(CLEANED);
  });

  it('never takes a live Person out of the index, even when asked to', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');

    const dropped = await service.dropStalePersonIndex(alice, jo);

    expect(dropped).toEqual({ vectors: 0, embeddings: 0, indexSkips: 0, ledger: 0 });
    expect(await indexState(jo)).toEqual(INDEXED_AS_PERSON);
  });

  it("will not touch another owner's entity", async () => {
    const jo = await indexedPerson(alice, 'Jo Park');
    await runner.query(`UPDATE ci.entities SET entity_type = 'Concept' WHERE entity_id = $1`, [jo]);

    const dropped = await service.dropStalePersonIndex(bob, jo);

    expect(dropped).toEqual({ vectors: 0, embeddings: 0, indexSkips: 0, ledger: 0 });
    expect(await indexState(jo)).toEqual(INDEXED_AS_PERSON);
  });

  it('reports what it removed', async () => {
    const jo = await indexedPerson(alice, 'Jo Park');
    await runner.query(`UPDATE ci.entities SET entity_type = 'Concept' WHERE entity_id = $1`, [jo]);

    expect(await service.dropStalePersonIndex(alice, jo)).toEqual({
      vectors: 1,
      embeddings: 1,
      indexSkips: 1,
      ledger: 2,
    });
  });

  it('does no cleanup for a node the write created', async () => {
    const drop = jest.spyOn(service, 'dropStalePersonIndex');

    await upsert(alice, { entityId: uuidv7(), entityType: 'Concept', name: 'Sourdough starter' });

    expect(drop).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('concept.created', { conceptId: expect.any(String) });
  });
});

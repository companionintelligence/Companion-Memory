import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity,
} from '@ci/domains/graph';
import {
  GRAPH_EDGE_BACKFILL_QUEUE,
  GraphEdgeBackfillRequestEvent,
  SEARCH_INDEX_BACKFILL_QUEUE,
  SearchIndexBackfillRequestEvent,
} from '@ci/domains/maintenance/events';
import { GraphDeltaWriter } from '@ci/domains/memory';

import { PushStage } from '../stages/PushStage';
import type { StageRunContext } from '../types';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PUSH LEDGER, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The destinations themselves are mocked here — what they do with a record is
 * their own domain's business, tested there. What is NOT mocked is the part this
 * stage owns and only a database can show:
 *
 *  - `push_status` moves per ROW, so one poisoned record sits at `failed` while
 *    its 499 neighbours land. A cursor would have stranded all of them;
 *  - `entity_mappings` remembers what each staged entity resolved to, and the
 *    participants of a message are read back through it — the join that turns a
 *    staged edge into a real sender;
 *  - a resumed push reads `push_status = 'pending'`, so it costs O(remaining)
 *    and does not re-send what already went.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/pushStage.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`the push stage (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());
  });

  afterAll(async () => {
    await teardown();
  });

  /** A stage wired to recording doubles for every destination. */
  function makeStage(
    overrides: {
      communicationCreate?: jest.Mock;
      contentCreate?: jest.Mock;
      graph?: GraphIngestService;
    } = {},
  ) {
    const sent: Array<{ destination: string; input: Record<string, unknown> }> = [];
    // Every destination takes an ARRAY and reports `inserted` per row — that is
    // the upserting path, and the flag is how the stage tells a row it WROTE
    // from one the destination already had. `inserted: false` is what a real
    // service returns when the provenance triple is already present.
    const record = (destination: string, inserted = true) =>
      jest.fn(async (_ctx: unknown, inputs: Array<Record<string, unknown>>) => {
        for (const input of inputs) {
          sent.push({ destination, input });
        }

        return inputs.map(() => ({ entity: { id: `${destination}-row` }, inserted }));
      });

    // The entity lane runs against the REAL GraphIngestService, not a double.
    //
    // It was a double once, and the double accepted a normalized handle in
    // `linkedId` — a `uuid` column — so every entity that had a handle failed
    // against the actual database and every entity without one was skipped.
    // Nothing resolved, and because `entity_mappings` stayed empty the
    // participant join silently produced nothing for any record. The mock
    // agreed with the code at every step.
    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };
    const graph =
      overrides.graph ??
      new GraphIngestService(
        harness.dataSource.getRepository(NodeEntity),
        harness.dataSource.getRepository(RelationshipEntity),
        new EntityIdentifierService(
          harness.dataSource.getRepository(EntityIdentifierEntity),
          logger as never,
        ),
        logger as never,
        // Real, for the same reason the ingest service is: `ci.graph_deltas` is
        // written by the application now (the triggers were dropped), so a
        // doubled writer would let the entity lane resolve rows while recording
        // nothing — and the delta is what the insight summaries read.
        new GraphDeltaWriter(harness.dataSource, logger as never),
      );

    const communications = { createManyDetailed: overrides.communicationCreate ?? record('communications') };
    const positions = { create: record('position') };
    const receipts = {
      upsertFromExtraction: jest.fn(async (_ctx: unknown, input: Record<string, unknown>) => {
        sent.push({ destination: 'receipts', input });

        return {
          receipt: { id: 'receipt-row' },
          lines: [],
          productsResolved: 0,
          identifiersPromoted: 0,
          mints: [],
        };
      }),
    };
    const observations = {
      createMany: jest.fn(async (_ctx: unknown, inputs: Array<Record<string, unknown>>) => {
        for (const input of inputs) {
          sent.push({ destination: 'observations', input });
        }

        return { written: [], protectedByConfirmation: 0, duplicatesInBatch: 0, rejectedUnarbitered: 0 };
      }),
    };
    const objectIdentifiers = { upsertForSubjects: jest.fn(async () => 0) };

    // The post-push kicks ride pg-boss to the maintenance domain's sweeps,
    // tested in their own specs; here they only need to record what was
    // requested. There is more than one of them and they fail independently, so
    // the parameters are spelled out rather than elided — a test that wants to
    // poison one kick has to be able to tell them apart.
    const signals = {
      send: jest.fn(async (_event: string, _payload: unknown, _options: unknown) => ['job-1']),
    };

    const stage = new PushStage(
      harness.dataSource,
      communications as never,
      { createManyDetailed: overrides.contentCreate ?? record('content') } as never,
      { createDetailed: record('events') } as never,
      { createManyDetailed: record('things') } as never,
      // The commerce plane. `upsertFromExtraction` is one call per receipt and
      // `createMany` reports batch totals, so neither returns the per-input
      // result shape `record()` builds — they get their own doubles.
      receipts as never,
      { createManyDetailed: record('product_models') } as never,
      observations as never,
      objectIdentifiers as never,
      // Positions carry no provenance triple, so this one never reports.
      positions as never,
      { createManyDetailed: record('browser_activity') } as never,
      graph as never,
      signals as never,
      logger as never,
    );

    return {
      stage,
      sent,
      graph,
      communications,
      positions,
      receipts,
      observations,
      objectIdentifiers,
      signals,
    };
  }

  /**
   * What the stage requested for ONE event, selected by name rather than by
   * position in the call log.
   *
   * The search assertion used to read `mock.calls[0]` behind a
   * `toHaveBeenCalledTimes(1)`, which quietly encoded "search is the only thing
   * a push kicks" into a test about what search is *asked for*. That stopped
   * being true when the graph-edge projection got its own sibling kick, and
   * this spec then failed for a reason it does not describe — while the
   * behaviour it names was working. Selecting by event id keeps each kick's
   * test about that kick and leaves the next sibling additive, without giving
   * up the assertion that matters: each event is requested exactly ONCE. The
   * sweeps are idempotent, but a duplicate request is a duplicate full pass.
   */
  function kicksFor<TPayload>(
    signals: { send: jest.Mock },
    event: string,
  ): Array<{ payload: TPayload; options: unknown }> {
    return signals.send.mock.calls
      .filter((call: unknown[]) => call[0] === event)
      .map((call: unknown[]) => ({ payload: call[1] as TPayload, options: call[2] }));
  }

  function contextFor(runId: string): StageRunContext {
    return {
      userId: harness.userId,
      runId,
      stageId: '44444444-4444-4444-8444-444444444444',
      scratchDir: '/var/tmp/ci-import/test',
      progress: async () => undefined,
    };
  }

  /** Stage one email with a sender and two recipients, the shape gmail emits. */
  async function stageEmailWithParticipants(): Promise<string> {
    const runId = await harness.startRun();
    const { dataSource, userId } = harness;

    const [item] = await dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
       VALUES ($1::uuid, $2::uuid, 'gmail', 'email', 'msg-1', now(), '{"Subject":"Hello"}'::jsonb)
       RETURNING id`,
      [runId, userId],
    );

    for (const [handle, relation] of [
      ['alice@example.com', 'from'],
      ['bob@example.com', 'to'],
      ['carol@example.com', 'cc'],
    ]) {
      const [entity] = await dataSource.query<Array<{ id: string }>>(
        `INSERT INTO ci_import.staged_entities
           (run_id, user_id, type, name, metadata, identity_key, data_source)
              VALUES ($1::uuid, $2::uuid, 'contact', $3, '{}'::jsonb, $3, 'gmail')
           RETURNING id`,
        [runId, userId, handle],
      );

      await dataSource.query(
        `INSERT INTO ci_import.staged_relationships (run_id, item_id, entity_id, relation, metadata)
              VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '{}'::jsonb)`,
        [runId, item.id, entity.id, relation],
      );
    }

    return runId;
  }

  it('resolves staged entities before the records that name them, and records the mapping', async () => {
    const runId = await stageEmailWithParticipants();
    const { stage } = makeStage();

    const outcome = await stage.run(contextFor(runId));

    expect(outcome.detail.entities).toMatchObject({ resolved: 3, skipped: 0, failed: 0 });

    const mappings = await harness.dataSource.query<Array<{ server_entity_id: string }>>(
      `SELECT m.server_entity_id
         FROM ci_import.entity_mappings m
         JOIN ci_import.staged_entities e ON e.id = m.staged_entity_id
        WHERE e.run_id = $1::uuid`,
      [runId],
    );

    expect(mappings).toHaveLength(3);
  });

  it('counts a row whose destinations all already had it as deduped, not as a write', async () => {
    // The reason the services report `inserted` at all. Every destination
    // upserts, so a collision is absorbed silently — a re-push used to count as
    // 10,808 writes and report `deduped: 0` on an archive that was mostly
    // repeats, and the destination breakdown claimed 7,339 content records
    // where 2,354 rows existed.
    const runId = await stageEmailWithParticipants();
    const { stage, sent } = makeStage({
      communicationCreate: jest.fn(async (_ctx: unknown, inputs: Array<Record<string, unknown>>) => {
        for (const input of inputs) {
          sent.push({ destination: 'communications', input });
        }

        return inputs.map(() => ({ entity: { id: 'communication-row' }, inserted: false }));
      }),
    });

    const outcome = await stage.run(contextFor(runId));

    expect(outcome.detail).toMatchObject({ pushed: 0, deduped: 1, failed: 0 });
    // The record was still SENT — it just wrote nothing, so it must not inflate
    // the destination breakdown.
    expect(sent.filter((entry) => entry.destination === 'communications')).toHaveLength(1);
    expect(outcome.detail.destinations).not.toHaveProperty('communications');
  });

  it('requests a search-index backfill scoped to what it wrote, plus person for the entity lane', async () => {
    const runId = await stageEmailWithParticipants();
    const { stage, signals } = makeStage();

    const outcome = await stage.run(contextFor(runId));

    const kicks = kicksFor<{ userId: string; entityTypes: string[]; requestedBy: string }>(
      signals,
      SearchIndexBackfillRequestEvent,
    );
    expect(kicks).toHaveLength(1);
    const [{ payload, options }] = kicks;
    expect(options).toEqual({ queue: SEARCH_INDEX_BACKFILL_QUEUE });
    const { userId, entityTypes, requestedBy } = payload;
    // One email pushed to communications + three contacts resolved: the kick
    // asks for exactly those types, never the server's full default sweep.
    expect(new Set(entityTypes)).toEqual(new Set(['communication', 'person']));
    expect(requestedBy).toBe(`import-run:${runId}`);
    // The pipeline sweeps the listener starts are user-scoped; the request
    // carries the import's owner.
    expect(userId).toBe(harness.userId);
    expect(outcome.detail.searchIndex).toMatchObject({
      requested: expect.arrayContaining(['communication', 'person']),
    });
  });

  it('requests a graph-edge projection for what it wrote, so pushed rows are reachable and not merely findable', async () => {
    // Searchable and reachable are different properties with different writers,
    // and for a long time a push kicked only the first: the QA corpus came out
    // fully searchable and 0.29% connected, so the graph view rendered a dust
    // cloud. `edgeProjectionSourcesFor` is unit-tested next door; what only a
    // real push can show is that this stage kicks it at all, scoped to the
    // destinations the push actually reached.
    const runId = await stageEmailWithParticipants();
    const { stage, signals } = makeStage();

    const outcome = await stage.run(contextFor(runId));

    const kicks = kicksFor<{ userId: string; sources: string[]; requestedBy: string }>(
      signals,
      GraphEdgeBackfillRequestEvent,
    );
    expect(kicks).toHaveLength(1);
    const [{ payload, options }] = kicks;
    // Its own queue, not the search one: an event id is a wire contract, and a
    // `search-index-backfill` carrying graph work lies to whoever greps for it.
    expect(options).toEqual({ queue: GRAPH_EDGE_BACKFILL_QUEUE });
    const { userId, sources, requestedBy } = payload;
    // The email landed in communications and nowhere else, so that is the whole
    // request — never every source the matrix knows, which would turn a narrow
    // import into a full-corpus pass.
    expect(sources).toEqual(['communications']);
    expect(requestedBy).toBe(`import-run:${runId}`);
    expect(userId).toBe(harness.userId);
    expect(outcome.detail.graphEdges).toMatchObject({ requested: ['communications'] });
  });

  it('reports a search-index request failure in detail without failing the push — the rows are already in ci.*', async () => {
    const runId = await stageEmailWithParticipants();
    const { stage, signals } = makeStage();
    // Poisoned by EVENT rather than by call order: `mockRejectedValueOnce`
    // fails whichever kick the stage happens to send first, which makes this
    // spec depend on that order instead of on the kick it names.
    signals.send.mockImplementation(async (event: string) => {
      if (event === SearchIndexBackfillRequestEvent) {
        throw new Error('pgboss down');
      }

      return ['job-1'];
    });

    const outcome = await stage.run(contextFor(runId));

    expect(outcome.partial).toBe(false);
    expect(outcome.detail.searchIndex).toMatchObject({ error: 'pgboss down' });
    // And the sibling is not collateral damage. They are two requests on two
    // queues answering two questions; a queue that dropped the search request
    // still gets asked for the edges.
    expect(outcome.detail.graphEdges).toMatchObject({ requested: ['communications'] });
    expect(outcome.detail.graphEdges).not.toHaveProperty('error');
  });

  it('reports a graph-edge request failure the same way, with the search kick unaffected', async () => {
    const runId = await stageEmailWithParticipants();
    const { stage, signals } = makeStage();
    signals.send.mockImplementation(async (event: string) => {
      if (event === GraphEdgeBackfillRequestEvent) {
        throw new Error('pgboss down');
      }

      return ['job-1'];
    });

    const outcome = await stage.run(contextFor(runId));

    // Same fail-soft policy as its sibling, and for the same reason: the rows
    // are already in `ci.*` and the sweep is idempotent, so a failure to enqueue
    // is reported in the detail — never retried, and never a failed push.
    expect(outcome.partial).toBe(false);
    expect(outcome.detail.graphEdges).toMatchObject({ error: 'pgboss down' });
    expect(outcome.detail.searchIndex).not.toHaveProperty('error');
  });

  it('counts entities in its own total, so Read and Save agree on one import', async () => {
    // A real Amazon archive read 10,890 and saved 10,808. Nothing was lost: the
    // parse stage counts items AND entities, while this stage's denominator was
    // items alone, so the two steps described the same import with different
    // numbers and the 82 missing rows read as a silent drop.
    const runId = await stageEmailWithParticipants();
    const { stage } = makeStage();

    const outcome = await stage.run(contextFor(runId));

    const [{ items }] = await harness.dataSource.query<Array<{ items: string }>>(
      `SELECT count(*) AS items FROM ci_import.staged_items WHERE run_id = $1::uuid`,
      [runId],
    );

    // One email, three contacts.
    expect(outcome.total).toBe(Number(items) + 3);
    expect(outcome.processed).toBe(outcome.total);
  });

  it('writes real ci.entities rows, with a linked id a uuid column accepts', async () => {
    // The bug in one test. `linked_id` is a uuid; the handle used to be written
    // into it directly, so this INSERT failed for every entity that had one.
    const runId = await stageEmailWithParticipants();
    const { stage } = makeStage();

    await stage.run(contextFor(runId));

    const rows = await harness.dataSource.query<Array<{ entity_type: string; linked_table: string }>>(
      `SELECT e.entity_type, e.linked_table
         FROM ci.entities e
         JOIN ci_import.entity_mappings m ON m.server_entity_id = e.entity_id
         JOIN ci_import.staged_entities s ON s.id = m.staged_entity_id
        WHERE s.run_id = $1::uuid`,
      [runId],
    );

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.entity_type === 'Person')).toBe(true);
    // Namespaced by the parser that produced them, per GraphIngestService.
    expect(rows.every((row) => row.linked_table === 'import:gmail')).toBe(true);
  });

  it('indexes each handle in ci.entity_identifiers, which is what links people later', async () => {
    // Without these rows a person imported from one export can never be matched
    // to the same person in another — the table was empty on a real import.
    const runId = await stageEmailWithParticipants();
    const { stage } = makeStage();

    await stage.run(contextFor(runId));

    const identifiers = await harness.dataSource.query<Array<{ value_normalized: string }>>(
      `SELECT i.value_normalized
         FROM ci.entity_identifiers i
         JOIN ci_import.entity_mappings m ON m.server_entity_id = i.entity_id
         JOIN ci_import.staged_entities s ON s.id = m.staged_entity_id
        WHERE s.run_id = $1::uuid AND i.kind = 'email'
        ORDER BY i.value_normalized`,
      [runId],
    );

    expect(identifiers.map((row) => row.value_normalized)).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('resolves the same handle to the same row on a re-import', async () => {
    // Idempotency is the reason the identity is a natural key rather than a
    // fresh uuid: a second import of the same archive must not double everyone.
    const { stage } = makeStage();

    const first = await stageEmailWithParticipants();
    await stage.run(contextFor(first));

    const second = await stageEmailWithParticipants();
    await stage.run(contextFor(second));

    const [{ count }] = await harness.dataSource.query<Array<{ count: string }>>(
      `SELECT count(DISTINCT m.server_entity_id) AS count
         FROM ci_import.entity_mappings m
         JOIN ci_import.staged_entities s ON s.id = m.staged_entity_id
        WHERE s.run_id IN ($1::uuid, $2::uuid)`,
      [first, second],
    );

    expect(Number(count)).toBe(3);
  });

  it('attaches the sender and recipients to the communication it pushes', async () => {
    const runId = await stageEmailWithParticipants();
    const { stage, sent } = makeStage();

    await stage.run(contextFor(runId));

    const communication = sent.find((entry) => entry.destination === 'communications');

    // Read back through the mapping table rather than from a mock's memory: the
    // participant ids are only correct if the join the stage itself uses agrees.
    const resolved = new Map(
      (
        await harness.dataSource.query<Array<{ identity_key: string; server_entity_id: string }>>(
          `SELECT s.identity_key, m.server_entity_id
             FROM ci_import.entity_mappings m
             JOIN ci_import.staged_entities s ON s.id = m.staged_entity_id
            WHERE s.run_id = $1::uuid`,
          [runId],
        )
      ).map((row) => [row.identity_key, row.server_entity_id]),
    );

    // The regression this closes: a full-mbox import once recorded 15,434 items
    // and ZERO relationships, so every message arrived with no sender at all.
    expect(communication?.input.from_entity_id).toBe(resolved.get('alice@example.com'));
    expect(communication?.input.to_entity_ids).toEqual([
      resolved.get('bob@example.com'),
      resolved.get('carol@example.com'),
    ]);
  });

  it('resolves a handle-less entity by name, without filing it as a contact', async () => {
    // Handle-less entities used to be skipped outright, on the grounds that a
    // null key would mint a duplicate every run. That cost a real Amazon import
    // all 69 of its artists and 12 of its genres. A name IS a stable key for the
    // things that have no handle by nature, so they resolve — as a Concept, not
    // as a person, which is the part that actually mattered.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_entities
         (run_id, user_id, type, name, metadata, identity_key, data_source)
            VALUES ($1::uuid, $2::uuid, 'album', 'European Vacation', '{}'::jsonb, NULL, 'google_photos')`,
      [runId, harness.userId],
    );

    const { stage } = makeStage();
    const outcome = await stage.run(contextFor(runId));

    expect(outcome.detail.entities).toMatchObject({ resolved: 1, skipped: 0, failed: 0 });

    const [row] = await harness.dataSource.query<Array<{ entity_type: string }>>(
      `SELECT e.entity_type
         FROM ci.entities e
         JOIN ci_import.entity_mappings m ON m.server_entity_id = e.entity_id
         JOIN ci_import.staged_entities s ON s.id = m.staged_entity_id
        WHERE s.run_id = $1::uuid`,
      [runId],
    );

    expect(row.entity_type).toBe('Concept');
  });

  it('skips only an entity with nothing at all to key on', async () => {
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, metadata, identity_key)
            VALUES ($1::uuid, $2::uuid, 'album', NULL, '{}'::jsonb, NULL)`,
      [runId, harness.userId],
    );

    const { stage } = makeStage();
    const outcome = await stage.run(contextFor(runId));

    expect(outcome.detail.entities).toMatchObject({ resolved: 0, skipped: 1 });
    // `skipped` is a decision, not an absence — a resumed push must not
    // reconsider it.
    const [row] = await harness.dataSource.query<Array<{ push_status: string }>>(
      `SELECT push_status FROM ci_import.staged_entities WHERE run_id = $1::uuid`,
      [runId],
    );

    expect(row.push_status).toBe('skipped');
    // Skipped, counted, NAMED — and not `partial`. Nothing about this row can
    // change on a retry or on a re-import of the same export: the record it was
    // built from carries no name and no handle. See the `partial` computation
    // in PushStage; the loss is reported instead of being made into a badge
    // that a corpus with one such row would wear forever.
    expect(outcome.partial).toBe(false);
    expect(outcome.detail.entities).toMatchObject({
      unresolved: 1,
      unresolvedDetail: {
        reason: 'entity_unresolved',
        message: 'no stable name or handle to resolve by',
        count: 1,
        // NULL data_source and empty metadata: the fallback that at least makes
        // the row itself reachable.
        examples: [expect.stringContaining('unknown: staged row ')],
      },
    });
  });

  it('says nothing about unresolved entities when there are none', async () => {
    // `unresolvedDetail` is absent, not an empty shell: every ordinary run
    // would otherwise carry a report of nothing having gone wrong.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, metadata, identity_key)
            VALUES ($1::uuid, $2::uuid, 'contact', 'Alice', '{}'::jsonb, 'alice@example.com')`,
      [runId, harness.userId],
    );

    const outcome = await makeStage().stage.run(contextFor(runId));

    expect(outcome.detail.entities).not.toHaveProperty('unresolvedDetail');
  });

  it('does not report partial for a bookkeeping-type entity, even though it is skipped', async () => {
    // `email_thread` is deliberately excluded from the graph (isGraphExcluded)
    // — gmail stages one per thread, so if this counted toward `partial` the
    // same way an unresolvable entity does, an ordinary Gmail import would
    // report `partial` on every single run. The regression this guards: the
    // two skip reasons used to be indistinguishable, and wiring `partial`
    // straight off `entities.skipped > 0` would have made that true.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, metadata, identity_key)
            VALUES ($1::uuid, $2::uuid, 'email_thread', NULL, '{}'::jsonb, NULL)`,
      [runId, harness.userId],
    );

    const { stage } = makeStage();
    const outcome = await stage.run(contextFor(runId));

    expect(outcome.detail.entities).toMatchObject({ resolved: 0, skipped: 1, unresolved: 0, failed: 0 });

    const [row] = await harness.dataSource.query<Array<{ push_status: string }>>(
      `SELECT push_status FROM ci_import.staged_entities WHERE run_id = $1::uuid`,
      [runId],
    );

    expect(row.push_status).toBe('skipped');
    expect(outcome.partial).toBe(false);
  });

  it('still reports an unresolvable entity, and its reason, across a resume', async () => {
    // A resumed push re-derives its counters from the ledger (`settledCounts`)
    // rather than the in-memory attempt, so the "genuinely unresolvable" signal
    // has to survive that round trip too — not just the first attempt. The
    // report is read from the same ledger for exactly this reason: the second
    // attempt has no rows of its own to count, and reporting the loss only on
    // the attempt that happened to see it first is how it went missing before.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, metadata, identity_key)
            VALUES ($1::uuid, $2::uuid, 'album', NULL, '{}'::jsonb, NULL)`,
      [runId, harness.userId],
    );

    const first = await makeStage().stage.run(contextFor(runId));

    expect(first.partial).toBe(false);

    const second = await makeStage().stage.run(contextFor(runId));

    expect(second.detail.entities).toMatchObject({
      resolved: 0,
      skipped: 1,
      unresolved: 1,
      failed: 0,
      unresolvedDetail: { reason: 'entity_unresolved', count: 1 },
    });
    expect(second.partial).toBe(false);
  });

  it('keeps a bookkeeping exclusion non-partial across a resume', async () => {
    // The other half of the resume regression: settledCounts must not mistake
    // an already-skipped bookkeeping row for an unresolved one either.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, metadata, identity_key)
            VALUES ($1::uuid, $2::uuid, 'email_thread', NULL, '{}'::jsonb, NULL)`,
      [runId, harness.userId],
    );

    const first = await makeStage().stage.run(contextFor(runId));

    expect(first.partial).toBe(false);

    const second = await makeStage().stage.run(contextFor(runId));

    expect(second.detail.entities).toMatchObject({ resolved: 0, skipped: 1, unresolved: 0, failed: 0 });
    expect(second.partial).toBe(false);
  });

  it('fails one poisoned row without stranding the rest', async () => {
    const runId = await harness.startRun();
    const { dataSource, userId } = harness;

    for (const hash of ['good-1', 'poison', 'good-2']) {
      await dataSource.query(
        `INSERT INTO ci_import.staged_items
           (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
         VALUES ($1::uuid, $2::uuid, 'gmail', 'email', $3, now(), '{}'::jsonb)`,
        [runId, userId, hash],
      );
    }

    const communicationCreate = jest.fn(async (_ctx: unknown, inputs: Array<{ source_id?: string }>) => {
      if (inputs.some((input) => input.source_id === 'poison')) {
        throw new Error('communications rejected this record');
      }

      return inputs.map(() => ({ entity: { id: 'communication-row' }, inserted: true }));
    });

    const { stage } = makeStage({ communicationCreate });
    const outcome = await stage.run(contextFor(runId));

    // All three rows were resolved, so the bar reaches its total; the breakdown
    // is what says two landed and one did not. Counting only successes made a
    // stage that examined everything report as half finished.
    expect(outcome.processed).toBe(3);
    expect(outcome.detail).toMatchObject({ pushed: 2, failed: 1 });
    // A partly-pushed run is not a failed one: two records are in ci.* and useful.
    expect(outcome.partial).toBe(true);

    const rows = await dataSource.query<
      Array<{ content_hash: string; push_status: string; push_error: string }>
    >(
      `SELECT content_hash, push_status, push_error FROM ci_import.staged_items
        WHERE run_id = $1::uuid ORDER BY content_hash`,
      [runId],
    );

    expect(rows.map((row) => [row.content_hash, row.push_status])).toEqual([
      ['good-1', 'pushed'],
      ['good-2', 'pushed'],
      ['poison', 'failed'],
    ]);
    expect(rows[2].push_error).toMatch(/rejected this record/);
  });

  /**
   * Out of disk is the one error the per-row quarantine gets wrong. Nothing
   * about the record caused it and nothing about the next one avoids it, so
   * marking it `failed` and carrying on wrote the same failure into every
   * remaining row — hammering a full database on the way — and then reported
   * `partial` over an import that had simply run out of room. The real incident
   * surfaced as an OCI error from the container runtime; the import itself said
   * nothing about disk at all.
   */
  it('aborts the whole stage on a full database instead of failing every remaining row', async () => {
    const runId = await harness.startRun();
    const { dataSource, userId } = harness;

    for (const hash of ['nospc-1', 'nospc-2', 'nospc-3']) {
      await dataSource.query(
        `INSERT INTO ci_import.staged_items
           (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
         VALUES ($1::uuid, $2::uuid, 'gmail', 'email', $3, now(), '{}'::jsonb)`,
        [runId, userId, hash],
      );
    }

    // Exactly what node-postgres hands back when Postgres cannot extend a file.
    const communicationCreate = jest.fn(async () => {
      throw Object.assign(new Error('could not extend file "base/16384/2619": No space left on device'), {
        code: '53100',
      });
    });

    const { stage } = makeStage({ communicationCreate });

    await expect(stage.run(contextFor(runId))).rejects.toThrow(/database volume/);

    const rows = await dataSource.query<Array<{ push_status: string }>>(
      `SELECT push_status FROM ci_import.staged_items WHERE run_id = $1::uuid`,
      [runId],
    );

    // NOT three `failed` rows with no route back. The stage stopped at the
    // first one, and everything it never reached is still `pending` — which is
    // exactly the state the push resumes from once space is freed.
    expect(rows.filter((row) => row.push_status === 'failed')).toHaveLength(0);
    expect(rows.filter((row) => row.push_status === 'pending')).toHaveLength(3);

    // One attempt, then stop — not one per remaining row.
    expect(communicationCreate).toHaveBeenCalledTimes(1);
  });

  it('reports both the database size and its remaining room on every push', async () => {
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
       VALUES ($1::uuid, $2::uuid, 'gmail', 'email', 'storage-1', now(), '{}'::jsonb)`,
      [runId, harness.userId],
    );

    const { stage } = makeStage();
    const outcome = await stage.run(contextFor(runId));

    // "How much room did the last import leave?" is the number that says
    // whether the next one fits, and nothing recorded it before.
    expect(outcome.detail.storage).toMatchObject({ databaseBytes: expect.any(Number) });
  });

  it('resumes over what is left rather than re-sending what already went', async () => {
    const runId = await stageEmailWithParticipants();
    const first = makeStage();

    const firstOutcome = await first.stage.run(contextFor(runId));

    expect(first.sent.length).toBeGreaterThan(0);

    // A second run of the same stage — what a redelivered job looks like. The
    // query IS the resume point, so there is nothing pending left to send. The
    // counters are seeded from the ledger, though, so the outcome still
    // describes the run — not an import that apparently vanished.
    const second = makeStage();
    const outcome = await second.stage.run(contextFor(runId));

    expect(second.sent).toHaveLength(0);
    expect(outcome.processed).toBe(firstOutcome.processed);
    expect(outcome.total).toBe(firstOutcome.total);
  });

  it("counts a dead attempt's settled rows when it resumes mid-run", async () => {
    // A push killed mid-run leaves the ledger half settled. The resumed attempt
    // sends only the remainder, but its numbers must not restart the arithmetic
    // against the remainder: a run killed at 50k/305k resumes at 50k/305k, not
    // 0/255k.
    const runId = await harness.startRun();

    for (const hash of ['settled-by-dead-attempt', 'left-1', 'left-2']) {
      await harness.dataSource.query(
        `INSERT INTO ci_import.staged_items
           (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
         VALUES ($1::uuid, $2::uuid, 'gmail', 'email', $3, now(), '{}'::jsonb)`,
        [runId, harness.userId, hash],
      );
    }

    await harness.dataSource.query(
      `UPDATE ci_import.staged_items
          SET push_status = 'pushed', pushed_at = now()
        WHERE run_id = $1::uuid AND content_hash = 'settled-by-dead-attempt'`,
      [runId],
    );

    const ticks: Array<{ processed: number; total?: number | null; phase?: string }> = [];
    const { stage, sent } = makeStage();
    const outcome = await stage.run({
      ...contextFor(runId),
      progress: async (update) => {
        ticks.push(update);
      },
    });

    expect(sent).toHaveLength(2);

    expect(outcome.processed).toBe(3);
    expect(outcome.total).toBe(3);
    expect(outcome.detail).toMatchObject({ pushed: 3, deduped: 0, failed: 0 });

    // The very first tick of the resumed attempt already stands on the dead
    // attempt's work — the bar never dips below where the run died.
    const firstPushing = ticks.find((tick) => tick.phase === 'pushing');

    expect(firstPushing).toMatchObject({ processed: 1, total: 3 });
  });

  it('sends every destination a batch, which is the path that upserts', async () => {
    // `create` with one row inserts and throws on a duplicate; only the batch
    // method is an upsert on the provenance triple. Two audiobook listens are
    // two events but ONE content row, because content is keyed on the work's
    // URI — so the single-row path raised
    // "duplicate key value violates content_source_triple_uniq" on the second.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
       VALUES ($1::uuid, $2::uuid, 'audible', 'listen', 'listen-1', now(), '{}'::jsonb)`,
      [runId, harness.userId],
    );

    const { stage, sent } = makeStage();

    await stage.run(contextFor(runId));

    // media.listen fans out to events and content; both must have been handed
    // an array, or the mock would not have recorded anything.
    expect(sent.map((entry) => entry.destination).sort()).toEqual(['content', 'events']);
  });

  it('counts a duplicate as deduped, not as a failure', async () => {
    // The record is in ci.* — it just arrived earlier. Reporting that as failure
    // makes a re-import look broken and marks rows for a retry that can never
    // succeed.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, metadata)
       VALUES ($1::uuid, $2::uuid, 'audible', 'email', 'dupe-1', now(), '{}'::jsonb)`,
      [runId, harness.userId],
    );

    const duplicate = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const { stage } = makeStage({
      communicationCreate: jest.fn(async () => {
        throw duplicate;
      }),
    });

    const outcome = await stage.run(contextFor(runId));

    expect(outcome.detail).toMatchObject({ pushed: 0, deduped: 1, failed: 0 });
    // A run that deduped everything still finished its work.
    expect(outcome.processed).toBe(outcome.total);

    const [row] = await harness.dataSource.query<Array<{ push_status: string; push_error: string | null }>>(
      `SELECT push_status, push_error FROM ci_import.staged_items WHERE run_id = $1::uuid`,
      [runId],
    );

    // `skipped`, so a resumed push does not reconsider it forever.
    expect(row.push_status).toBe('skipped');
    expect(row.push_error).toBeNull();
  });

  it('records which destinations a row reached', async () => {
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, latitude, longitude, metadata)
       VALUES ($1::uuid, $2::uuid, 'twitter', 'message', 'geo-1', now(), 37.79, -122.39, '{}'::jsonb)`,
      [runId, harness.userId],
    );

    const { stage } = makeStage();

    await stage.run(contextFor(runId));

    const [row] = await harness.dataSource.query<Array<{ pushed_ref: { destinations: string[] } }>>(
      `SELECT pushed_ref FROM ci_import.staged_items WHERE run_id = $1::uuid`,
      [runId],
    );

    // A geotagged message is both a communication and a GPS donor.
    expect(row.pushed_ref.destinations).toEqual(['communications', 'position']);
  });

  it('pushes positions without emitting position.created per point', async () => {
    // Every other destination's batch path already defers indexing to the
    // post-load machinery; PositionService defers only when ASKED
    // (emitCreated:false). Without it a Location History import emits one
    // event per GPS point — hundreds of thousands of warnings when nothing
    // listens on that queue.
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, latitude, longitude, metadata)
       VALUES ($1::uuid, $2::uuid, 'google_location', 'location', 'geo-quiet-1', now(), 37.79, -122.39, '{}'::jsonb)`,
      [runId, harness.userId],
    );

    const { stage, positions } = makeStage();

    await stage.run(contextFor(runId));

    expect(positions.create).toHaveBeenCalledTimes(1);

    // The mock's declared signature stops at the inputs array, so the options
    // argument is read past the tuple deliberately.
    const options = (positions.create.mock.calls[0] as unknown[])[2];

    expect(options).toEqual({ emitCreated: false });
  });
});

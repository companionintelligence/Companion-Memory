import { UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { DEAD_LETTER_QUEUE } from '../../constants';
import { JobCategoryMetricEntity } from '../../entities/JobCategoryMetricEntity';
import { JobMetricEntity } from '../../entities/JobMetricEntity';
import { PgBossArchiveEntity } from '../../entities/PgBossArchiveEntity';
import { PgBossJobEntity } from '../../entities/PgBossJobEntity';
import { JOB_CATEGORIES, UNCLASSIFIED_CATEGORY } from '../../taxonomy';
import { JobQueryService } from '../JobQueryService';

describe('JobQueryService — the auth guard (no database required)', () => {
  function makeService() {
    const noop = { createQueryBuilder: jest.fn() };

    return new JobQueryService(noop as never, noop as never, noop as never, noop as never);
  }

  it('list() refuses a request with no user context', async () => {
    const service = makeService();

    await expect(service.list({} as RequestContext, {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('clearTerminal() refuses a request with no user context', async () => {
    const service = makeService();

    await expect(service.clearTerminal({} as RequestContext, 'dead-letter')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('history() refuses a request with no user context', async () => {
    const service = makeService();

    await expect(service.history({} as RequestContext, {})).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/**
 * The category filter, without a database.
 *
 * A category is not a set of event names: `describeJob` resolves a row's
 * category from the (event, queue) PAIR, so the four events in
 * `JOB_TYPES_BY_QUEUE` belong to a different category on their own queue than
 * their base entry names. Selecting on the event alone made this endpoint
 * disagree with itself — `?category=search` returned rows it then labelled
 * `graph` and `pipeline`, and `?category=graph` could not find them at all.
 *
 * The integration suite below proves the SQL runs; this proves the SQL is
 * SHAPED right, and runs everywhere — CI provisions no Postgres, so everything
 * under `describeWithDatabase` is skipped there.
 */
describe('JobQueryService — the category filter (no database required)', () => {
  /** Run `applyFilters` against a mock and return the SQL it emitted. */
  function captureCategorySql(category: string): {
    clauses: string[];
    parameters: Record<string, unknown>;
  } {
    const clauses: string[] = [];
    const parameters: Record<string, unknown> = {};

    const record = (sql: unknown, params?: Record<string, unknown>) => {
      if (typeof sql === 'string') {
        clauses.push(sql);
      }

      Object.assign(parameters, params ?? {});
    };

    // Annotated: the mock returns itself, so inference would be circular.
    interface WhereMock {
      where: (sql: unknown, params?: Record<string, unknown>) => WhereMock;
      orWhere: (sql: unknown, params?: Record<string, unknown>) => WhereMock;
    }

    const builder: Record<string, unknown> = {};
    const inner: WhereMock = {
      where: jest.fn((sql: unknown, params?: Record<string, unknown>): WhereMock => {
        record(sql, params);

        return inner;
      }),
      orWhere: jest.fn((sql: unknown, params?: Record<string, unknown>): WhereMock => {
        record(sql, params);

        return inner;
      }),
    };

    Object.assign(builder, {
      andWhere: jest.fn((sql: unknown, params?: Record<string, unknown>) => {
        // The category branch passes a Brackets; run its factory to see inside.
        const factory = (sql as { whereFactory?: (qb: unknown) => void })?.whereFactory;

        if (typeof factory === 'function') {
          factory(inner);
        } else {
          record(sql, params);
        }

        return builder;
      }),
      where: jest.fn(() => builder),
      orWhere: jest.fn(() => builder),
    });

    const repo = { createQueryBuilder: jest.fn(() => builder) };
    const service = new JobQueryService(repo as never, repo as never, repo as never, repo as never);

    (
      service as unknown as {
        applyFilters: (qb: unknown, query: unknown, userId: string) => void;
      }
    ).applyFilters(builder, { category }, uuidv7());

    return { clauses, parameters };
  }

  it('subtracts the pairs a queue-scoped entry moves OUT of the category', () => {
    const { clauses, parameters } = captureCategorySql('search');
    const sql = clauses.join(' ');

    expect(sql).toContain("job.data->>'name' IN (:...categoryEvents)");
    expect(sql).toContain('NOT IN (:...excludedQueueKeys)');
    // The concatenation is what makes the pair addressable in SQL at all.
    expect(sql).toContain("job.data->>'name' || '::' || job.name");
    expect(parameters.excludedQueueKeys).toEqual(
      expect.arrayContaining([
        'communication.created::people-linking',
        'content.created::pipeline-index',
        'answer.created::default',
      ]),
    );
  });

  it('adds back the pairs a queue-scoped entry moves INTO the category', () => {
    const { clauses, parameters } = captureCategorySql('graph');

    expect(clauses.join(' ')).toContain('IN (:...includedQueueKeys)');
    expect(parameters.includedQueueKeys).toEqual(
      expect.arrayContaining(['communication.created::people-linking', 'answer.created::default']),
    );
  });

  it('still fails closed on an unknown category', () => {
    const { parameters } = captureCategorySql('not-a-real-category');

    // A typo returns an empty table, never the unfiltered one.
    expect(parameters.categoryEvents).toEqual(['__no-such-category__']);
  });

  it('can select the queue-scoped Ollama listener the Model chip now counts', () => {
    // Adding a JOB_TYPES_BY_QUEUE entry is only half the fix: the descriptor
    // makes the row SAY `llm`, and this is what makes the Model filter return
    // it. `browseractivity.created` fires once per page visit, so this is the
    // highest-frequency model call on the appliance.
    const { parameters } = captureCategorySql('llm');

    expect(parameters.includedQueueKeys).toEqual(
      expect.arrayContaining(['browseractivity.created::browser-activity-insight']),
    );
  });
});

/**
 * The chip's NUMBER and the table's TOTAL, which are computed by two different
 * pieces of code and have to agree.
 *
 * `facetCounts` folds rows in JS after a GROUP BY; `applyFilters` emits a SQL
 * predicate. They used to disagree on the events two listeners share on
 * different queues: the fold was keyed on the event alone, so every
 * `content.created` on `pipeline-index` was added to the Search index chip while
 * the Pipeline filter was what actually returned it. Both chips lied — one high,
 * one low.
 */
describe('JobQueryService.facetCounts — the fold behind the chips', () => {
  /** Drive facetCounts over canned grouped rows and return its two fold outputs. */
  async function foldOver(
    rows: Array<{ bucket: string; event: string | null; queue: string | null; count: number }>,
    query: Record<string, unknown> = {},
  ): Promise<{ stateCounts: Record<string, number>; categoryCounts: Record<string, number> }> {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;

    Object.assign(builder, {
      select: jest.fn(chain),
      addSelect: jest.fn(chain),
      setParameter: jest.fn(chain),
      groupBy: jest.fn(chain),
      andWhere: jest.fn(chain),
      where: jest.fn(chain),
      orWhere: jest.fn(chain),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });

    const repo = { createQueryBuilder: jest.fn(() => builder) };
    const service = new JobQueryService(repo as never, repo as never, repo as never, repo as never);

    return (
      service as unknown as {
        facetCounts: (
          q: unknown,
          u: string,
        ) => Promise<{ stateCounts: Record<string, number>; categoryCounts: Record<string, number> }>;
      }
    ).facetCounts(query, uuidv7());
  }

  it('counts a queue-scoped row under the chip that returns it, not the one its event names', async () => {
    const { categoryCounts } = await foldOver([
      { bucket: 'completed', event: 'content.created', queue: 'search-index', count: 2 },
      { bucket: 'completed', event: 'content.created', queue: 'pipeline-index', count: 7 },
      { bucket: 'completed', event: 'browseractivity.created', queue: 'browser-activity-insight', count: 4 },
    ]);

    expect(categoryCounts.pipeline).toBe(7);
    expect(categoryCounts.llm).toBe(4);
    // …and the chip whose event name they carry counts only its own rows.
    expect(categoryCounts.search).toBe(2);
  });

  it('counts a dead-lettered row by its event, because the filter cannot do better either', async () => {
    // pg-boss rewrote the queue column on the copy, so `content.created` can no
    // longer be known to have run on `pipeline-index`. The filter's
    // include/exclude lists hold no `::dead-letter` key, so `?category=search`
    // is what returns this row — and so `search` is what has to count it.
    const { categoryCounts } = await foldOver([
      { bucket: 'dead-letter', event: 'content.created', queue: DEAD_LETTER_QUEUE, count: 5 },
    ]);

    expect(categoryCounts).toEqual({ search: 5 });
  });

  it('files a fingerprinted event under the chip that can open it', async () => {
    // `describeJob` gives this row a readable label and guesses `search` from
    // its queue, but the guess is prose: `unclassified` is the only chip that
    // both counts it and returns it.
    const { categoryCounts } = await foldOver([
      { bucket: 'completed', event: 'zz.no-such-event', queue: 'search-index', count: 3 },
      { bucket: 'completed', event: null, queue: DEAD_LETTER_QUEUE, count: 1 },
    ]);

    expect(categoryCounts).toEqual({ unclassified: 4 });
  });

  it('re-applies the category filter to the state tabs, queue-aware', async () => {
    // `stateCounts` drops the state filter and keeps the category one, so the
    // tabs must resolve a row the same way the chips do or the two badge sets
    // describe different populations.
    const rows = [
      { bucket: 'completed', event: 'content.created', queue: 'pipeline-index', count: 7 },
      { bucket: 'failed', event: 'content.created', queue: 'pipeline-index', count: 2 },
      { bucket: 'completed', event: 'content.created', queue: 'search-index', count: 9 },
    ];

    const { stateCounts } = await foldOver(rows, { category: 'pipeline' });

    expect(stateCounts).toEqual({ completed: 7, failed: 2 });
  });
});

/**
 * `list()` / `history()` — real TypeORM QueryBuilder chains over pg-boss's own
 * tables plus `ci.job_metrics`, proved against real Postgres.
 *
 * `JobQueryService.stateCounts.spec.ts` already documents why a mocked
 * QueryBuilder cannot catch this class of bug: the ENUM-cast fix it guards
 * shipped past review specifically because nothing executed the SQL. `list()`
 * carries the same risk in its JSONB path filters (`data->>'name'`), its
 * `Brackets` OR-grouped search, and the `job.name != dead-letter` exclusion —
 * none of which a mock can validate either.
 *
 * Opt-in: set `EVENTS_TEST_DATABASE_URL` (or `DATABASE_URL` / `DATABASE_PASSWORD`,
 * as `yarn test` already does from the repo-root `.env`) to a database with
 * migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'EVENTS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[events/JobQueryService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`JobQueryService — against real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: JobQueryService;
  const CTX: RequestContext = { userId: uuidv7() } as RequestContext;

  // A run-unique marker folded into every seeded job's queue/name so this
  // suite's assertions never see another worker's (or a live appliance's) rows
  // in the same shared `pgboss.job` table.
  //
  // Deliberately NOT a uuid prefix. `search` also matches `job.id::text ILIKE`,
  // and uuidv7 is time-ordered — so a marker taken from the first 8 hex digits
  // of one uuid matches the id of every other uuid minted in the same window,
  // including this suite's own fixtures. That made the pagination assertions
  // fail intermittently against a row nobody searched for. The `zz` prefix
  // cannot appear in a uuid, so the term can only match what it was folded into.
  const marker = `zzjq-${uuidv7().slice(-8)}`;
  const searchTerm = `zzsearch-${marker}`;
  const otherUserId = uuidv7();
  // Two rows whose category comes from their QUEUE rather than their event
  // name. They carry real event/queue names because that pairing IS what is
  // under test — `JOB_TYPES_BY_QUEUE` is keyed on it — so they are tracked by
  // id and deleted by id.
  const stagedContentId = uuidv7();
  const linkedCommunicationId = uuidv7();
  const classifiedVisitId = uuidv7();
  const otherUserTerm = `zzowner-${marker}`;

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'EVENTS_TEST_DATABASE_URL' });

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
      entities: [PgBossJobEntity, PgBossArchiveEntity, JobMetricEntity, JobCategoryMetricEntity],
      synchronize: false,
    });

    await dataSource.initialize();

    // SHARED: this suite commits real pgboss.job / ci.job_metrics rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'JobQueryService');

    service = new JobQueryService(
      dataSource.getRepository(PgBossJobEntity),
      dataSource.getRepository(PgBossArchiveEntity),
      dataSource.getRepository(JobMetricEntity),
      dataSource.getRepository(JobCategoryMetricEntity),
    );

    // pgboss.job is partitioned by (name); 'default' and 'dead-letter' are both
    // pre-created partitions on a migrated database, so these are safe to use
    // without creating a new partition.
    // `userId` defaults to CTX's own id so every pre-existing seed (and the
    // assertions written against it) stays owned by the caller the other tests
    // already search as; pass an explicit id (or `null`) to seed a job owned by
    // someone else, or by no one.
    async function seedJob(overrides: {
      id?: string;
      queue?: string;
      eventName?: string;
      state?: string;
      createdOn: Date;
      startedOn?: Date | null;
      completedOn?: Date | null;
      output?: Record<string, unknown> | null;
      userId?: string | null;
    }) {
      const ownerId = overrides.userId === undefined ? CTX.userId : overrides.userId;
      const data: Record<string, unknown> = { name: overrides.eventName ?? `${marker}.plain` };

      if (ownerId != null) {
        data.userId = ownerId;
      }

      await dataSource.query(
        `INSERT INTO pgboss.job
           (id, name, data, state, retry_limit, retry_count, created_on, started_on, completed_on, output)
         VALUES ($1, $2, $3::jsonb, $4::pgboss.job_state, 2, 0, $5, $6, $7, $8::jsonb)`,
        [
          overrides.id ?? uuidv7(),
          overrides.queue ?? 'default',
          JSON.stringify(data),
          overrides.state ?? 'completed',
          overrides.createdOn,
          overrides.startedOn ?? null,
          overrides.completedOn ?? null,
          overrides.output ? JSON.stringify(overrides.output) : null,
        ],
      );
    }

    const base = new Date('2026-08-01T00:00:00.000Z');

    // Three plain, orderable rows for pagination.
    await seedJob({ eventName: `${marker}.a`, createdOn: new Date(base.getTime() + 1000) });
    await seedJob({ eventName: `${marker}.b`, createdOn: new Date(base.getTime() + 2000) });
    await seedJob({ eventName: `${marker}.c`, createdOn: new Date(base.getTime() + 3000) });

    // A taxonomy-mapped event (category 'search') vs. an unrelated one, to prove
    // the category filter resolves through JOB_TYPES rather than string-matching.
    await seedJob({ eventName: 'note.created', createdOn: new Date(base.getTime() + 4000) });
    await seedJob({ eventName: `${marker}.uncategorized`, createdOn: new Date(base.getTime() + 5000) });

    // A dead-lettered job: queue name IS the dead-letter queue, state is
    // whatever it failed at — the bucket comes from the QUEUE, not the state.
    await seedJob({
      queue: DEAD_LETTER_QUEUE,
      eventName: `${marker}.failed-job`,
      state: 'failed',
      createdOn: new Date(base.getTime() + 6000),
    });

    // A row findable ONLY through its failure message, to prove the search
    // Brackets actually reach output->>'message'.
    await seedJob({
      eventName: `${marker}.silent`,
      createdOn: new Date(base.getTime() + 7000),
      output: { message: `boom ${searchTerm} exploded` },
    });

    // `content.created` on `pipeline-index` is category `pipeline`, while the
    // same event on any other queue is `search`; `communication.created` on
    // `people-linking` is `graph`. Both are seeded so the filter can be shown
    // to agree with the label the same endpoint puts on them.
    await seedJob({
      id: stagedContentId,
      queue: 'pipeline-index',
      eventName: 'content.created',
      createdOn: new Date(base.getTime() + 8000),
    });
    await seedJob({
      id: linkedCommunicationId,
      queue: 'people-linking',
      eventName: 'communication.created',
      createdOn: new Date(base.getTime() + 9000),
    });
    // The per-visit Ollama classification, which shares `browseractivity.created`
    // with the search-index listener. Seeded so "what is queued against the
    // model?" can be shown to actually return it.
    await seedJob({
      id: classifiedVisitId,
      queue: 'browser-activity-insight',
      eventName: 'browseractivity.created',
      createdOn: new Date(base.getTime() + 10000),
    });

    // Owned by a DIFFERENT user, seeded before every other row (so it never
    // shifts the pagination test's ordering) — proves message search is
    // owner-scoped rather than a leak across the whole appliance.
    await seedJob({
      eventName: `${marker}.other-user-failure`,
      createdOn: new Date(base.getTime() - 1000),
      output: { message: `boom ${otherUserTerm} exploded` },
      userId: otherUserId,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DELETE FROM pgboss.job WHERE data->>'name' LIKE $1`, [`${marker}%`]);
      await dataSource.query(
        `DELETE FROM pgboss.job WHERE data->>'name' = 'note.created' AND created_on > $1`,
        [new Date('2026-08-01T00:00:00.000Z')],
      );
      await dataSource.query('DELETE FROM pgboss.job WHERE id = ANY($1::uuid[])', [
        [stagedContentId, linkedCommunicationId, classifiedVisitId],
      ]);
      await dataSource.query('DELETE FROM ci.job_metrics WHERE queue LIKE $1', [`${marker}%`]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('paginates newest-first (created_on DESC, id DESC tiebreak)', async () => {
    const page1 = await service.list(CTX, { search: marker, limit: 2, offset: 0 });
    const page2 = await service.list(CTX, { search: marker, limit: 2, offset: 2 });

    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].event).toBe(`${marker}.silent`); // most recently created
    expect(page1.items[1].event).toBe(`${marker}.failed-job`);
    expect(page2.items[0].event).toBe(`${marker}.uncategorized`);
    // No overlap between pages.
    const page1Ids = new Set(page1.items.map((i) => i.id));
    expect(page2.items.some((i) => page1Ids.has(i.id))).toBe(false);
  });

  it('resolves category through the JOB_TYPES taxonomy, not a literal string match', async () => {
    const result = await service.list(CTX, { category: 'search' });

    const events = result.items.map((i) => i.event);
    expect(events).toContain('note.created'); // mapped to category 'search'
    expect(events).not.toContain(`${marker}.uncategorized`); // not in JOB_TYPES at all
  });

  it('never returns a row this same response labels with a DIFFERENT category', async () => {
    // The invariant the old filter broke: it selected on the event name while
    // `toListItem` labelled through `describeJob`, which resolves the (event,
    // queue) pair. Asking for `search` returned rows labelled `graph`.
    //
    // Every bucket, not a chosen three — `unclassified` included, because a
    // fingerprinted row used to render a GUESSED category ("Search index") that
    // no filter could reproduce, and `maintenance` because that guess's default
    // landed there.
    for (const category of [...Object.values(JOB_CATEGORIES), UNCLASSIFIED_CATEGORY]) {
      const result = await service.list(CTX, { category, limit: 200 });
      const mislabelled = result.items
        .filter((i) => i.category !== category)
        .map((i) => `${i.event}::${i.queue} -> ${i.category}`);

      expect(mislabelled).toEqual([]);
    }
  });

  it("every category chip's number is the total of the table that chip opens", async () => {
    // The other half of the same promise, and the one the queue-aware filter
    // broke on its own: `facetCounts` folded on the event name while
    // `applyFilters` selected on the (event, queue) pair, so for the events two
    // listeners share the chip counted one population and clicking it returned
    // another. Asserted over the WHOLE table rather than the seeded rows: both
    // sides see the same population, so the equality holds whatever else is in
    // pgboss.job, and a row that falls out of every bucket shows up as a
    // mismatch in the totals below.
    const { categoryCounts } = await service.list(CTX, { limit: 1 });
    const buckets = [...Object.values(JOB_CATEGORIES), UNCLASSIFIED_CATEGORY];

    const disagreements: string[] = [];
    let summed = 0;

    for (const category of buckets) {
      const chip = categoryCounts[category] ?? 0;
      const { total } = await service.list(CTX, { category, limit: 1 });

      summed += chip;

      if (chip !== total) {
        disagreements.push(`${category}: chip ${chip}, table ${total}`);
      }
    }

    expect(disagreements).toEqual([]);

    // And no row falls between the buckets: the chips have to add up to the
    // unfiltered total, or the shortfall is unexplainable on screen.
    const { total: everything } = await service.list(CTX, { limit: 1 });

    expect(summed).toBe(everything);
  });

  it('files a queue-scoped job under the category its QUEUE names, not its event name', async () => {
    const pipeline = await service.list(CTX, { category: 'pipeline', queue: 'pipeline-index', limit: 200 });
    const asSearch = await service.list(CTX, { category: 'search', queue: 'pipeline-index', limit: 200 });

    expect(pipeline.items.map((i) => i.id)).toContain(stagedContentId);
    // …and is no longer reachable under the category its base entry names.
    expect(asSearch.items.map((i) => i.id)).not.toContain(stagedContentId);

    const graph = await service.list(CTX, { category: 'graph', queue: 'people-linking', limit: 200 });

    expect(graph.items.map((i) => i.id)).toContain(linkedCommunicationId);
  });

  it('returns the per-visit model call under Model, not under the search index', async () => {
    // `browseractivity.created` fires once per page visit and has TWO listeners:
    // the search-index write, and an Ollama classification on its own 1-slot
    // queue. Only the first was in the taxonomy, so an operator filtering by
    // Model to see what is queued against a saturated Ollama got nothing back.
    const model = await service.list(CTX, {
      category: 'llm',
      queue: 'browser-activity-insight',
      limit: 200,
    });
    const asSearch = await service.list(CTX, {
      category: 'search',
      queue: 'browser-activity-insight',
      limit: 200,
    });

    expect(model.items.map((i) => i.id)).toContain(classifiedVisitId);
    expect(asSearch.items.map((i) => i.id)).not.toContain(classifiedVisitId);
  });

  it('an unknown category matches nothing (fails closed, not open)', async () => {
    const result = await service.list(CTX, { category: 'not-a-real-category' });

    expect(result.items.filter((i) => i.event?.startsWith(marker))).toHaveLength(0);
  });

  it('buckets a dead-lettered job under the dead-letter QUEUE, independent of its failure state', async () => {
    const deadLetter = await service.list(CTX, { state: 'dead-letter', search: marker });
    const failedButNotDeadLettered = await service.list(CTX, { state: 'failed', search: marker });

    expect(deadLetter.items.map((i) => i.event)).toContain(`${marker}.failed-job`);
    expect(deadLetter.items.every((i) => i.deadLettered)).toBe(true);
    // The plain `state=failed` filter must EXCLUDE the dead-letter queue, per
    // `job.name != :deadLetter` in applyFilters — a dead-lettered job must not
    // double-count under both buckets.
    expect(failedButNotDeadLettered.items.map((i) => i.event)).not.toContain(`${marker}.failed-job`);
  });

  it('search matches the event name, the queue name, AND the failure output message', async () => {
    const byEventName = await service.list(CTX, { search: `${marker}.a` });
    expect(byEventName.items.map((i) => i.event)).toContain(`${marker}.a`);

    const byOutputMessage = await service.list(CTX, { search: searchTerm });
    expect(byOutputMessage.items.map((i) => i.event)).toContain(`${marker}.silent`);
  });

  it("search cannot surface another user's failure message (owner-scoped)", async () => {
    const otherCtx: RequestContext = { userId: otherUserId } as RequestContext;

    const asOwner = await service.list(otherCtx, { search: otherUserTerm });
    expect(asOwner.items.map((i) => i.event)).toContain(`${marker}.other-user-failure`);

    const asStranger = await service.list(CTX, { search: otherUserTerm });
    expect(asStranger.items.map((i) => i.event)).not.toContain(`${marker}.other-user-failure`);
    expect(asStranger.items).toHaveLength(0);
  });

  it('exact type filter narrows to one event, unlike the broader search', async () => {
    const result = await service.list(CTX, { type: `${marker}.b` });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].event).toBe(`${marker}.b`);
  });

  it('the stateCounts sidebar reflects the search-scoped rows, ignoring the state filter itself', async () => {
    const result = await service.list(CTX, { search: marker, state: 'completed' });

    // failed-job seeded under dead-letter, silent/a/b/c/uncategorized under completed.
    expect(result.stateCounts['dead-letter']).toBeGreaterThanOrEqual(1);
    expect(result.stateCounts['completed']).toBeGreaterThanOrEqual(5);
  });

  it('history() aggregates ci.job_metrics into buckets, scoped to the requested queue', async () => {
    const queue = `${marker}-metrics-queue`;
    const otherQueue = `${marker}-other-queue`;
    const now = new Date();

    for (const minutesAgo of [1, 3, 8]) {
      await dataSource.query(
        `INSERT INTO ci.job_metrics
           (sampled_at, queue, pending, active, retry, dead_lettered, completed, failed, avg_duration_ms, p95_duration_ms)
         VALUES ($1, $2, 1, 2, 0, 0, 3, 0, 500, 900)`,
        [new Date(now.getTime() - minutesAgo * 60_000), queue],
      );
    }

    // A sample for a DIFFERENT queue in the same window — must not leak into
    // this queue's aggregated points.
    await dataSource.query(
      `INSERT INTO ci.job_metrics
         (sampled_at, queue, pending, active, retry, dead_lettered, completed, failed, avg_duration_ms, p95_duration_ms)
       VALUES ($1, $2, 99, 99, 0, 0, 99, 0, 1, 1)`,
      [new Date(now.getTime() - 2 * 60_000), otherQueue],
    );

    const history = await service.history(CTX, { windowHours: 1, queue });

    // `queues` mirrors list()'s: every queue with a sample in the window (a
    // picker's worth of options), independent of the active `queue` filter —
    // it is `points` that must actually be scoped.
    expect(history.queues).toEqual(expect.arrayContaining([queue, otherQueue]));
    expect(history.points.length).toBeGreaterThan(0);
    const totalCompleted = history.points.reduce((sum, p) => sum + p.completed, 0);
    expect(totalCompleted).toBe(9); // 3 samples * completed=3, summed as a delta
  });
});

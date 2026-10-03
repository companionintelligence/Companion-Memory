import { DataSource } from 'typeorm';

import type { RequestContext, UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  GraphDeltaWriter,
  ItemBaseEntity,
  ItemEntity,
  ItemService,
  type ItemPosition,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import {
  DATASETS,
  DATASET_NAMES,
  INSTANT,
  PAGE_SIZES,
  expectedForwardWalk,
  idSequence,
  readWalk,
  walkForward,
  type DatasetName,
  type FetchPage,
  type SeededRow,
} from '../../../__tests__/support/subMillisecondRows';
import { GlobalUID } from '../../types/GlobalUID';
import { ItemSortOrder } from '../../types/ItemFilters';
import { encodeItemCursor } from '../../utils/itemCursor';
import { ItemResolver } from '../ItemResolver';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THINGS LIST OVER ITEMS THAT SHARE AN INSTANT, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ItemResolver.things.test.ts` holds the resolver to its contract with the service stubbed,
 * and `ItemService.findPage.spec.ts` holds the service's SQL to its shape with a recording
 * query builder. Neither can see what a seek DOES to rows whose `created_at` carries
 * MICROseconds, which is what this file is for.
 *
 * `ci.objects.created_at` is `timestamptz(6) DEFAULT now()`: a write-time column, and a bulk
 * import stamps every item of a batch with one `now()`. The things list is a keyset on
 * `(created_at, object_id)` and its cursor is held by the CLIENT: `encodeItemCursor` wrote
 * `createdAt.toISOString()` of a JavaScript `Date`, and the driver TRUNCATES to milliseconds
 * on the way in (`00:00:00.123456` is read as `.123`). So a cursor named the millisecond that
 * contains its row, not the row's instant, and
 * `created_at < :c OR (created_at = :c AND object_id < :id)` skipped every item of that
 * instant that sorted after the page boundary: `created_at = :c` matches no microsecond
 * value. Silently, and for ever: the next cursor was minted from the page that skipped them.
 *
 * Two datasets (see `subMillisecondRows.ts`), each owned by its own synthetic user:
 *
 *   ONE INSTANT       seven items stamped to the same MICROsecond, more than any page. Two
 *                     decoys share that instant and sit between them by id: another user's
 *                     item and a merge tombstone. Neither may be served, or disturb the walk.
 *   ONE MILLISECOND   six items in one millisecond at six different microseconds, seeded
 *                     latest first so their ids run AGAINST their times. The page is ordered
 *                     `(created_at, object_id)` at full precision, so the seek has to agree.
 *
 * Each is walked page by page at several page sizes, so the cursor lands on every position
 * in the cluster, and a walk must serve each item exactly once, in order, with an honest
 * `hasNextPage`. Three ways in:
 *
 *   - `ItemService.findPage`, passing back each page's `nextCursor`: what `ItemResolver`'s
 *     refinement path does between its 200-row chunks;
 *   - `ItemResolver.items`, passing back each page's `endCursor`: the cursor a client holds;
 *   - `ItemResolver.items` again, resuming from EVERY edge's cursor, not just the last: a
 *     client may hand back any of them.
 *
 * And the refinement path itself, over a cluster larger than one of its chunks.
 *
 * Then what the exact cursor buys, and what it must not break: every position is the row's
 * instant to the microsecond; a cursor outlives its own row (the position is in the cursor,
 * not looked up, so a row merged away or forgotten between two pages moves nothing); a cursor
 * minted before the change, which holds milliseconds only, still decodes and still resumes a
 * row that has no sub-millisecond part; and a time Postgres would refuse reads as no cursor
 * at all, not as a 500 from the database.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your
 * OWN, or run `make test-db ARGS=ItemResolver.things.subMillisecond`. Every fixture belongs to
 * a synthetic user and is deleted in `afterAll`.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graphql/ItemResolver.things.subMillisecond.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(180_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const signalling = { send: jest.fn(async () => []) } as unknown as EventService;

/** A decoy shares the cluster's instant but is not the list's to serve. */
type Decoy = 'foreign' | 'tombstone';

/** Seeded right after the item of that label, so each decoy's id falls inside the cluster. */
const DECOYS_AFTER: Record<string, Decoy> = { c1: 'foreign', c3: 'tombstone' };

/** A cluster that does not fit in one 200-row chunk of the refinement path's drain, with a neighbour each side. */
const CHUNKED = { newer: 5, clustered: 300, older: 5 };

describeWithDb(`The things list over items that share an instant (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let items: ItemService;
  let resolver: ItemResolver;

  const nextId = idSequence();
  const owners = {} as Record<DatasetName, string>;
  const synthetic: string[] = [];
  const seeded = new Map<DatasetName, SeededRow[]>();
  const decoyIds = new Map<Decoy, string>();
  let chunkedOwner = '';

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);
  const serviceContext = (userId: string) => ({ userId }) as UserServiceContext;
  /** A fresh object per call: `toServiceContext` memoises on the identity of the request context. */
  const request = (userId: string) => ({ userId }) as unknown as RequestContext;
  const rowsOf = (dataset: DatasetName): SeededRow[] => seeded.get(dataset) ?? [];

  /** The `ci.entities` base row and `ci.objects` detail row of one item, stamped to `at` to the microsecond. */
  async function insertItem(
    id: string,
    owner: string,
    at: string,
    options: { mergedInto?: string } = {},
  ): Promise<void> {
    const tombstone = options.mergedInto !== undefined;

    await query(
      `INSERT INTO ci.entities
         (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id, is_active, merged_into_entity_id)
       VALUES ($1, 'Item', $2, '{}'::jsonb, $3, 'objects', $1, $4, $5)`,
      [id, `item ${id}`, owner, !tombstone, options.mergedInto ?? null],
    );
    await query(
      `INSERT INTO ci.objects (object_id, user_id, created_at, updated_at, merged_into_object_id, lifecycle_state)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $4, $5)`,
      [id, owner, at, options.mergedInto ?? null, tombstone ? 'archived' : 'active'],
    );
  }

  /** `count` items of one owner stamped to one instant, in one statement per table. */
  async function insertBatch(owner: string, at: string, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, nextId);

    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       SELECT id, 'Item', 'item ' || id, '{}'::jsonb, $1, 'objects', id FROM unnest($2::uuid[]) AS id`,
      [owner, ids],
    );
    await query(
      `INSERT INTO ci.objects (object_id, user_id, created_at, updated_at)
       SELECT id, $1, $3::timestamptz, $3::timestamptz FROM unnest($2::uuid[]) AS id`,
      [owner, ids, at],
    );

    return ids;
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, ItemBaseEntity, ItemEntity],
      synchronize: false,
      // A session zone that is neither UTC nor a whole hour. The cursor's text is formatted in UTC by the
      // query itself, so it must come out the same whatever the session says.
      extra: { options: '-c search_path=ci,public -c timezone=Asia/Kolkata' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'graphql/ItemResolver.things.subMillisecond');

    const foreignOwner = await createSyntheticTestUser(query, 'ThingsSubMsForeign');

    chunkedOwner = await createSyntheticTestUser(query, 'ThingsSubMsChunked');
    synthetic.push(foreignOwner, chunkedOwner);

    for (const dataset of DATASET_NAMES) {
      owners[dataset] = await createSyntheticTestUser(query, `ThingsSubMs-${dataset.replace(' ', '-')}`);
      synthetic.push(owners[dataset]);
    }

    items = new ItemService(
      dataSource.getRepository(ItemEntity),
      dataSource.getRepository(ItemBaseEntity),
      logger(),
      signalling,
      new GraphDeltaWriter(dataSource, logger()),
    );
    // The things query reaches only the item service; the loaders and the other services serve the fields.
    resolver = new ItemResolver(
      undefined as never,
      items,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    for (const dataset of DATASET_NAMES) {
      const rows: SeededRow[] = [];

      // In array order, so the ids ascend with it.
      for (const spec of DATASETS[dataset]) {
        const row = { ...spec, id: nextId() };

        await insertItem(row.id, owners[dataset], row.at);
        rows.push(row);

        const decoy = dataset === 'one instant' ? DECOYS_AFTER[spec.label] : undefined;

        if (decoy != null) {
          const id = nextId();

          await insertItem(
            id,
            decoy === 'foreign' ? foreignOwner : owners[dataset],
            INSTANT,
            decoy === 'tombstone' ? { mergedInto: rows[0].id } : {},
          );
          decoyIds.set(decoy, id);
        }
      }

      seeded.set(dataset, rows);
    }

    await insertBatch(chunkedOwner, '2026-05-02T00:00:00.000000Z', CHUNKED.newer);
    await insertBatch(chunkedOwner, INSTANT, CHUNKED.clustered);
    await insertBatch(chunkedOwner, '2026-04-30T00:00:00.000000Z', CHUNKED.older);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      try {
        await query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [synthetic]);
        // A tombstone points at its survivor, so the pointers go before the rows do.
        await query(
          'UPDATE ci.objects SET merged_into_object_id = NULL, parent_object_id = NULL WHERE user_id = ANY($1::uuid[])',
          [synthetic],
        );
        await query('DELETE FROM ci.objects WHERE user_id = ANY($1::uuid[])', [synthetic]);
        await query(
          'UPDATE ci.entities SET merged_into_entity_id = NULL WHERE owner_user_id = ANY($1::uuid[])',
          [synthetic],
        );
        await query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [synthetic]);
        await query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [synthetic]);
      } finally {
        await schemaLock?.release();
        await dataSource.destroy();
      }
    }
  });

  // ── The three ways in ─────────────────────────────────────────────────────

  /** The service, handing each page's `nextCursor` to the next call: what the refinement path's drain does. */
  const serviceFetch =
    (dataset: DatasetName): FetchPage<ItemPosition> =>
    async (size, after) => {
      const page = await items.findPage(
        serviceContext(owners[dataset]),
        {},
        { limit: size, afterCreatedAt: after?.createdAt ?? null, afterId: after?.id ?? null },
      );

      return { ids: page.items.map((item) => item.id), hasNextPage: page.hasMore, next: page.nextCursor };
    };

  const idOf = (node: { id: string }): string => GlobalUID.parse('item', node.id);

  /** The query a client sends: `first` things, `after` the cursor of the last one it was given. */
  const wireFetch =
    (owner: string): FetchPage<string> =>
    async (size, after) => {
      const connection = await resolver.items(request(owner), {
        first: size,
        ...(after != null ? { after } : {}),
      });

      return {
        ids: connection.edges.map((edge) => idOf(edge.node)),
        hasNextPage: connection.pageInfo.hasNextPage,
        next: connection.pageInfo.endCursor ?? null,
      };
    };

  describe('the fixture', () => {
    it('keeps its microseconds, and the driver reads them back as milliseconds', async () => {
      const row = rowsOf('one instant').find((candidate) => candidate.label === 'c1')!;

      // A trigger that re-stamped the row would let every case below pass for the wrong reason.
      const [{ exact }] = (await query(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
           FROM ci.objects WHERE object_id = $1`,
        [row.id],
      )) as Array<{ exact: string }>;

      expect(exact).toBe(INSTANT);

      // ...and the read findPage's cursor was built from loses them, which is the whole flaw.
      const entity = await dataSource.getRepository(ItemEntity).findOneByOrFail({ id: row.id });

      expect(entity.createdAt.toISOString()).toBe('2026-05-01T00:00:00.123Z');
    });

    it('seeds the decoys at the cluster instant, outside the list', async () => {
      const [{ shared }] = (await query(
        `SELECT count(*)::int AS shared FROM ci.objects WHERE object_id = ANY($1::uuid[]) AND created_at = $2::timestamptz`,
        [[...decoyIds.values()], INSTANT],
      )) as Array<{ shared: number }>;

      expect(shared).toBe(2);
    });
  });

  describe.each(DATASET_NAMES)('walking the things list over %s', (dataset) => {
    describe('ItemService.findPage, passing back nextCursor', () => {
      it.each(PAGE_SIZES)('in pages of %i serves every item once, in order', async (size) => {
        const rows = rowsOf(dataset);
        const reading = readWalk(await walkForward(serviceFetch(dataset), size, rows.length), rows);

        expect({ repeated: reading.repeated, dropped: reading.dropped }).toEqual({
          repeated: [],
          dropped: [],
        });
        expect(reading.pages).toEqual(expectedForwardWalk(rows, size));
      });
    });

    describe('ItemResolver.items, passing back endCursor', () => {
      it.each(PAGE_SIZES)('in pages of %i serves every item once, in order', async (size) => {
        const rows = rowsOf(dataset);
        const reading = readWalk(await walkForward(wireFetch(owners[dataset]), size, rows.length), rows);

        expect({ repeated: reading.repeated, dropped: reading.dropped }).toEqual({
          repeated: [],
          dropped: [],
        });
        expect(reading.pages).toEqual(expectedForwardWalk(rows, size));
      });
    });

    describe('ItemResolver.items, resuming from every edge', () => {
      it('serves the next items after any one of them', async () => {
        const rows = rowsOf(dataset);
        const labelOf = new Map(rows.map((row) => [row.id, row.label]));
        const newestFirst = expectedForwardWalk(rows, rows.length)[0].labels;
        const everything = await resolver.items(request(owners[dataset]), { first: rows.length });

        expect(everything.edges.map((edge) => labelOf.get(idOf(edge.node)))).toEqual(newestFirst);

        const resumed: Record<string, string[]> = {};
        const wanted: Record<string, string[]> = {};

        for (const [at, edge] of everything.edges.entries()) {
          const label = labelOf.get(idOf(edge.node))!;
          const page = await resolver.items(request(owners[dataset]), { first: 3, after: edge.cursor });

          resumed[label] = page.edges.map((next) => labelOf.get(idOf(next.node))!);
          wanted[label] = newestFirst.slice(at + 1, at + 4);
        }

        expect(resumed).toEqual(wanted);
      });
    });
  });

  describe('the position a page reports', () => {
    it.each(DATASET_NAMES)("is each item's instant to the microsecond, over %s", async (dataset) => {
      const rows = rowsOf(dataset);
      const page = await items.findPage(serviceContext(owners[dataset]), {}, { limit: rows.length });
      const atOf = new Map(rows.map((row) => [row.id, row.at]));

      expect(page.positions).toEqual(
        page.items.map((item) => ({ createdAt: atOf.get(item.id), id: item.id })),
      );
      expect(page.nextCursor).toBeNull();
    });

    it('is the last item of a page that has another after it', async () => {
      const page = await items.findPage(serviceContext(owners['one instant']), {}, { limit: 3 });

      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toEqual(page.positions[2]);
    });
  });

  describe('a cursor', () => {
    it('outlives its own row: the position is in the cursor, not looked up', async () => {
      const owner = await createSyntheticTestUser(query, 'ThingsSubMsOutlives');

      synthetic.push(owner);

      const ids = await insertBatch(owner, INSTANT, 5);
      const newestFirst = [...ids].reverse();
      const firstPage = await resolver.items(request(owner), { first: 3 });

      expect(firstPage.edges.map((edge) => idOf(edge.node))).toEqual(newestFirst.slice(0, 3));

      // Forgotten between the two requests, as `memory.forget` or a merge would.
      await query('DELETE FROM ci.objects WHERE object_id = $1', [newestFirst[2]]);

      const secondPage = await resolver.items(request(owner), {
        first: 5,
        after: firstPage.pageInfo.endCursor ?? undefined,
      });

      expect(secondPage.edges.map((edge) => idOf(edge.node))).toEqual(newestFirst.slice(3));
    });

    it('minted before the change holds milliseconds, and still resumes a row that has no more', async () => {
      const rows = rowsOf('one instant');
      const next = rows.find((row) => row.label === 'n')!;
      const labelOf = new Map(rows.map((row) => [row.id, row.label]));

      // `n` is stamped 00:00:00.124000: its millisecond is its whole instant, so `toISOString()` lost nothing.
      expect(next.at).toBe('2026-05-01T00:00:00.124000Z');

      const legacy = encodeItemCursor({ createdAt: '2026-05-01T00:00:00.124Z', id: next.id });
      const page = await resolver.items(request(owners['one instant']), { first: 3, after: legacy });

      expect(page.edges.map((edge) => labelOf.get(idOf(edge.node)))).toEqual(['c7', 'c6', 'c5']);
    });

    it.each([
      ['a day that does not exist', '2026-02-30T00:00:00.000000Z'],
      ['a time that is not UTC', '2026-05-01T00:00:00.123456+05:30'],
      ['not a time at all', 'yesterday'],
    ])('naming %s reads as no cursor at all, not as an error', async (_what, createdAt) => {
      const rows = rowsOf('one instant');
      const labelOf = new Map(rows.map((row) => [row.id, row.label]));
      const stale = encodeItemCursor({ createdAt, id: rows[0].id });
      const page = await resolver.items(request(owners['one instant']), { first: 2, after: stale });

      expect(page.edges.map((edge) => labelOf.get(idOf(edge.node)))).toEqual(['w2', 'w1']);
    });
  });

  describe('the refinement path, which drains the keyset 200 items at a time', () => {
    const everything = CHUNKED.newer + CHUNKED.clustered + CHUNKED.older;

    it('sees every item of a cluster that does not fit in one chunk', async () => {
      // `OLDEST` is a refinement the keyset cannot serve, so the resolver drains a window of it
      // 200 rows at a time and orders that. The first chunk ends inside the cluster.
      const connection = await resolver.items(
        request(chunkedOwner),
        { first: 200 },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ItemSortOrder.OLDEST,
      );

      expect(connection.totalCount).toBe(everything);
    });

    it('serves each of them once when paged through', async () => {
      const served: string[] = [];
      let after: string | undefined;

      for (let guard = 0; guard < 5; guard++) {
        const connection = await resolver.items(
          request(chunkedOwner),
          { first: 200, ...(after != null ? { after } : {}) },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ItemSortOrder.OLDEST,
        );

        served.push(...connection.edges.map((edge) => idOf(edge.node)));

        if (!connection.pageInfo.hasNextPage) {
          break;
        }

        after = connection.pageInfo.endCursor ?? undefined;
      }

      expect(served).toHaveLength(everything);
      expect(new Set(served).size).toBe(everything);
    });
  });
});

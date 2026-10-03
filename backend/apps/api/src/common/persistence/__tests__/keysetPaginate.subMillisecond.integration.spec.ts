import { randomBytes } from 'node:crypto';

import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { BrowserActivityEntity, BrowserActivityService } from '@ci/domains/browser-activity';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  CalendarEventService,
  CommunicationBaseEntity,
  CommunicationEntity,
  CommunicationService,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../domains/__tests__/support/applianceUser';
import {
  databaseAvailability,
  dataSourceConnection,
} from '../../../domains/__tests__/support/databaseConnection';
import {
  HAPPENED,
  insertEvent,
  type EventLifecycle,
} from '../../../domains/__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../domains/__tests__/support/schemaLock';
import { keysetPaginate, type KeysetPageArgs } from '../keysetPaginate';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `keysetPaginate` OVER ROWS THAT SHARE AN INSTANT, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `keysetPaginate.integration.spec.ts` holds the paging contract for rows a
 * millisecond or more apart, and for a tie it can spell: two rows with the same
 * MILLISECOND. This file is the case that one cannot reach, rows whose ordering
 * column carries MICROseconds.
 *
 * Every column the call sites page on is `timestamptz(6)`. `keysetPaginate` finds
 * its cursor by id and reads that row's ordering column back as a JavaScript
 * `Date`, and the driver TRUNCATES to milliseconds on the way in
 * (`00:00:00.123456` is read as `.123`). So the cursor row sorts, to the seek that
 * follows it, BEFORE ITSELF:
 *
 *   - paging down seeks `col < :t OR (col = :t AND id < :id)`. `col = :t` matches
 *     no microsecond value, so every row of the cursor's instant that sorts after
 *     the page boundary is skipped, silently;
 *   - paging up seeks `col > :t OR (col = :t AND id > :id)`. `col > :t` matches
 *     the cursor's own millisecond, rows already served included: the page
 *     repeats, and a batch larger than a page repeats for ever.
 *
 * A write-time column makes this routine. `ci.content.created_at` is `now()`, and
 * a bulk import stamps its whole batch with one, so the Content list
 * (`contents(first, after)`) is the likely exposure. The other four sites page on
 * source-dated columns that rarely carry a sub-millisecond part, but nothing
 * stops one (an ICS or a Takeout event can arrive with microseconds).
 *
 * Two datasets, each owned by its own synthetic user and seeded into every table:
 *
 *   ONE INSTANT       seven rows stamped to the same MICROsecond (more than any
 *                     page below), with a neighbour on each side, among them the
 *                     very next millisecond. The batch import.
 *   ONE MILLISECOND   six rows in one millisecond at six different microseconds,
 *                     seeded latest first so their ids run AGAINST their times.
 *                     Rows like these come from separate transactions that
 *                     started in the same millisecond. The page is ordered
 *                     `(col, id)` at full precision in SQL, so the seek has to
 *                     agree with microseconds: a seek that treated the whole
 *                     millisecond as one instant would order them by id instead.
 *
 * Each is walked page by page in both directions at several page sizes, so the
 * cursor lands on every position in the cluster, and every walk must serve each
 * row exactly once, in order, with honest `hasNextPage` / `hasPreviousPage`.
 * Part A does that to `keysetPaginate` itself for all four entities that call
 * it, with the options their services pass. Part B does it to the five service
 * methods, so a caller cannot sidestep the fix.
 *
 * Opt-in like its neighbours: set `PERSISTENCE_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run
 * `make test-db ARGS=keysetPaginate.subMillisecond.integration`. Every fixture
 * belongs to a synthetic user and is deleted in `afterAll`.
 */
const DATABASE_ENV = {
  urlEnvVar: 'PERSISTENCE_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'PERSISTENCE_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[persistence/keysetPaginate.subMillisecond.integration] SKIPPED — ${availability.reason}`);
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

/** Keeps two runs of this file off each other's rows; the low digits carry the order. */
const RUN = randomBytes(4).toString('hex');
let counter = 0;
const nextId = () => `${RUN}-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

/** `2026-05-01T00:00:00.123456Z` -> `2026-05-01T00:00:00.123Z`: what the driver reads it back as. */
const toMilliseconds = (at: string) => at.replace(/(\.\d{3})\d*Z$/, '$1Z');

interface RowSpec {
  label: string;
  at: string;
}

interface SeedRow {
  id: string;
  at: string;
}

interface Seeded extends RowSpec {
  id: string;
}

const INSTANT = '2026-05-01T00:00:00.123456Z';

const ONE_INSTANT: RowSpec[] = [
  { label: 'o1', at: '2026-04-29T09:00:00.100000Z' },
  { label: 'o2', at: '2026-04-30T23:59:59.999000Z' },
  ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((label) => ({ label, at: INSTANT })),
  // The next millisecond: a seek that swallowed the cursor's whole millisecond would drop it.
  { label: 'n', at: '2026-05-01T00:00:00.124000Z' },
  { label: 'w1', at: '2026-05-03T08:00:00.000000Z' },
  { label: 'w2', at: '2026-05-13T20:00:00.500000Z' },
];

const ONE_MILLISECOND: RowSpec[] = [
  { label: 'o', at: '2026-04-30T12:00:00.000000Z' },
  // Seeded latest first: the ids ascend while the times descend.
  { label: 'm6', at: '2026-05-01T00:00:00.123600Z' },
  { label: 'm5', at: '2026-05-01T00:00:00.123500Z' },
  { label: 'm4', at: '2026-05-01T00:00:00.123400Z' },
  { label: 'm3', at: '2026-05-01T00:00:00.123300Z' },
  { label: 'm2', at: '2026-05-01T00:00:00.123200Z' },
  { label: 'm1', at: '2026-05-01T00:00:00.123100Z' },
  { label: 'w', at: '2026-05-02T12:00:00.000000Z' },
];

type DatasetName = 'one instant' | 'one millisecond';

const DATASETS: Record<DatasetName, RowSpec[]> = {
  'one instant': ONE_INSTANT,
  'one millisecond': ONE_MILLISECOND,
};

const DATASET_NAMES = Object.keys(DATASETS) as DatasetName[];

type Direction = 'forward' | 'backward';

/** What every walk reports about a page, whichever way it was fetched. */
interface PageOf {
  ids: string[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  totalCount: number;
}

type Fetch = (args: KeysetPageArgs) => Promise<PageOf>;

/** One entity `keysetPaginate` pages: how to put a row in, and the options its service passes. */
interface Kind {
  name: string;
  entity: EntityTarget<ObjectLiteral>;
  options: { alias: string; timeProp: string; userIdProp?: string };
  /** Where the ordering column lives, to read the fixture back exactly. */
  table: string;
  idColumn: string;
  timeColumn: string;
  seed(row: SeedRow, owner: string): Promise<void>;
}

/** Soft-deleted events, the other half of `CalendarEventService`: its `findDeletedPage`. */
const DELETED_EVENTS = 'soft-deleted events';

describeWithDb(
  `keysetPaginate over rows that share an instant, against Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let services: ReturnType<typeof buildServices>;

    const owners = {} as Record<DatasetName, string>;
    const deletedOwners = {} as Record<DatasetName, string>;
    const synthetic: string[] = [];
    const seeded = new Map<string, Seeded[]>();
    const labels = new Map<string, string>();

    const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);
    const ctx = (userId: string) => ({ userId }) as UserServiceContext;
    const keyOf = (group: string, dataset: DatasetName) => `${group}|${dataset}`;

    function buildServices(db: DataSource) {
      const deltaWriter = new GraphDeltaWriter(db, logger());

      return {
        events: new CalendarEventService(
          db.getRepository(EventEntity),
          db.getRepository(EventBaseEntity),
          signalling,
          db,
          deltaWriter,
        ),
        communications: new CommunicationService(
          db.getRepository(CommunicationEntity),
          signalling,
          logger(),
          db,
          deltaWriter,
        ),
        browserActivity: new BrowserActivityService(
          db.getRepository(BrowserActivityEntity),
          signalling,
          logger(),
          db,
        ),
        contents: new ContentService(
          db.getRepository(ContentEntity),
          db.getRepository(ContentBaseEntity),
          db.getRepository(EventEntity),
          signalling,
          deltaWriter,
        ),
      };
    }

    /** An event at `row.at`; `insertEvent` takes milliseconds, so the microseconds are written after. */
    async function seedEvent(row: SeedRow, owner: string, lifecycle: EventLifecycle): Promise<void> {
      await insertEvent(query, owner, {
        id: row.id,
        title: `event ${row.id}`,
        at: Date.parse(toMilliseconds(row.at)),
        lifecycle,
        point: null,
      });
      await query('UPDATE ci.events SET start_time = $2::timestamptz WHERE event_id = $1', [row.id, row.at]);
    }

    const kinds: Kind[] = [
      {
        name: 'content (created_at)',
        entity: ContentEntity,
        options: { alias: 'content', timeProp: 'createdAt' },
        table: 'ci.content',
        idColumn: 'id',
        timeColumn: 'created_at',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
           VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
            [row.id, `content ${row.id}`, owner],
          );
          await query(
            `INSERT INTO ci.content (id, type, user_id, created_at, updated_at)
           VALUES ($1, 'text', $2, $3::timestamptz, $3::timestamptz)`,
            [row.id, owner, row.at],
          );
        },
      },
      {
        name: 'communication (time)',
        entity: CommunicationEntity,
        options: { alias: 'communication', timeProp: 'time' },
        table: 'ci.communications',
        idColumn: 'id',
        timeColumn: '"time"',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
           VALUES ($1, 'Communication', $2, '{}'::jsonb, $3, 'communications', $1)`,
            [row.id, `message ${row.id}`, owner],
          );
          await query(
            `INSERT INTO ci.communications (id, "time", user_id, communication_type, direction, content)
           VALUES ($1, $2::timestamptz, $3, 'email', 'inbound', 'hello')`,
            [row.id, row.at, owner],
          );
        },
      },
      {
        name: 'browser activity (time)',
        entity: BrowserActivityEntity,
        // The one entity that names its owner column `user_id` rather than `userId`.
        options: { alias: 'browserActivity', timeProp: 'time', userIdProp: 'user_id' },
        table: 'ci.browser_activity',
        idColumn: 'id',
        timeColumn: '"time"',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.browser_activity (id, "time", url, user_id)
           VALUES ($1, $2::timestamptz, 'https://example.test/page', $3)`,
            [row.id, row.at, owner],
          );
        },
      },
      {
        name: 'event (start_time)',
        entity: EventEntity,
        options: { alias: 'event', timeProp: 'startTime' },
        table: 'ci.events',
        idColumn: 'event_id',
        timeColumn: 'start_time',
        seed: (row, owner) => seedEvent(row, owner, HAPPENED),
      },
    ];

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        ...dataSourceConnection(DATABASE_ENV),
        entities: [
          BaseEntity,
          EventEntity,
          EventBaseEntity,
          CommunicationEntity,
          CommunicationBaseEntity,
          ContentEntity,
          ContentBaseEntity,
          BrowserActivityEntity,
          UserEntity,
        ],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });
      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'persistence/keysetPaginate.subMillisecond');

      for (const dataset of DATASET_NAMES) {
        owners[dataset] = await createSyntheticTestUser(query, `KeysetSubMs-${dataset.replace(' ', '-')}`);
        deletedOwners[dataset] = await createSyntheticTestUser(
          query,
          `KeysetSubMsDeleted-${dataset.replace(' ', '-')}`,
        );
        synthetic.push(owners[dataset], deletedOwners[dataset]);
      }

      services = buildServices(dataSource);

      const seedDataset = async (
        group: string,
        dataset: DatasetName,
        seed: (row: SeedRow) => Promise<void>,
      ): Promise<void> => {
        const rows: Seeded[] = [];

        // In array order, so the ids ascend with it.
        for (const spec of DATASETS[dataset]) {
          const row = { ...spec, id: nextId() };

          await seed(row);
          labels.set(row.id, row.label);
          rows.push(row);
        }

        seeded.set(keyOf(group, dataset), rows);
      };

      for (const dataset of DATASET_NAMES) {
        for (const kind of kinds) {
          await seedDataset(kind.name, dataset, (row) => kind.seed(row, owners[dataset]));
        }

        await seedDataset(DELETED_EVENTS, dataset, (row) =>
          seedEvent(row, deletedOwners[dataset], { ...HAPPENED, isDeleted: true }),
        );
      }
    });

    async function wipe(): Promise<void> {
      await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [synthetic]);

      for (const table of ['ci.communications', 'ci.browser_activity', 'ci.content', 'ci.events']) {
        await query(`DELETE FROM ${table} WHERE user_id = ANY($1::uuid[])`, [synthetic]);
      }

      await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [synthetic]);
      await query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [synthetic]);
    }

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        try {
          await wipe();
          await query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [synthetic]);
        } finally {
          await schemaLock?.release();
          await dataSource.destroy();
        }
      }
    });

    // ── The walk, and what it must come out as ──────────────────────────────

    const label = (id: string) => labels.get(id) ?? id;

    /** Oldest first: by the instant the database stored, then by id. Both are fixed-width, so strings compare. */
    const ascending = (rows: Seeded[]): Seeded[] =>
      [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));

    interface ExpectedPage {
      labels: string[];
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    }

    /**
     * The pages a walk must return. Forward reads newest to oldest from the top; backward reads
     * oldest to newest from the bottom. Either way a page comes back newest first.
     */
    function expectedWalk(rows: Seeded[], direction: Direction, size: number): ExpectedPage[] {
      const oldestFirst = ascending(rows);
      const inReadingOrder = direction === 'forward' ? [...oldestFirst].reverse() : oldestFirst;
      const pages: ExpectedPage[] = [];

      for (let start = 0; start < inReadingOrder.length; start += size) {
        const chunk = inReadingOrder.slice(start, start + size);
        const isFirst = start === 0;
        const isLast = start + size >= inReadingOrder.length;
        const newestFirst = direction === 'forward' ? chunk : [...chunk].reverse();

        pages.push({
          labels: newestFirst.map((row) => row.label),
          hasNextPage: direction === 'forward' ? !isLast : !isFirst,
          hasPreviousPage: direction === 'forward' ? !isFirst : !isLast,
        });
      }

      return pages;
    }

    /**
     * Follow the connection the way a client does: `first` / `after` the last row, or `last` / `before`
     * the first. A seek that cannot get past a cluster re-serves it for ever, so the walk is bounded
     * a little above the longest correct one.
     */
    async function walk(fetch: Fetch, direction: Direction, size: number, rows: number): Promise<PageOf[]> {
      const pages: PageOf[] = [];
      let cursor: string | null = null;

      for (let guard = 0; guard < rows + 2; guard++) {
        const args: KeysetPageArgs =
          direction === 'forward'
            ? { first: size, ...(cursor == null ? {} : { afterId: cursor }) }
            : { last: size, ...(cursor == null ? {} : { beforeId: cursor }) };
        const page = await fetch(args);

        pages.push(page);

        const more = direction === 'forward' ? page.hasNextPage : page.hasPreviousPage;

        if (!more || page.ids.length === 0) {
          break;
        }

        cursor = direction === 'forward' ? page.ids[page.ids.length - 1] : page.ids[0];
      }

      return pages;
    }

    async function expectCompleteWalk(
      fetch: Fetch,
      direction: Direction,
      rows: Seeded[],
      size: number,
    ): Promise<void> {
      const pages = await walk(fetch, direction, size, rows.length);
      const served = pages.flatMap((page) => page.ids.map(label));
      const repeated = [...new Set(served.filter((name, at) => served.indexOf(name) !== at))];
      const dropped = rows.map((row) => row.label).filter((name) => !served.includes(name));

      // Named first, so a failure says WHAT went wrong before the diff says where.
      expect({ repeated, dropped }).toEqual({ repeated: [], dropped: [] });
      expect(
        pages.map((page) => ({
          labels: page.ids.map(label),
          hasNextPage: page.hasNextPage,
          hasPreviousPage: page.hasPreviousPage,
        })),
      ).toEqual(expectedWalk(rows, direction, size));
      expect(pages.every((page) => page.totalCount === rows.length)).toBe(true);
    }

    const directions: Direction[] = ['forward', 'backward'];
    const sizes = [1, 2, 3, 5];

    // ── Part A: keysetPaginate itself, for every entity that calls it ──────────

    describe('the fixture', () => {
      it.each(kinds.map((kind) => kind.name))(
        '%s keeps its microseconds, and the driver reads them back as milliseconds',
        async (name) => {
          const kind = kinds.find((candidate) => candidate.name === name)!;
          const row = seeded.get(keyOf(name, 'one instant'))!.find((candidate) => candidate.label === 'c1')!;

          // A BEFORE INSERT trigger that re-stamped the row would let every case below pass for the wrong reason.
          const [{ exact }] = (await query(
            `SELECT to_char(${kind.timeColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
             FROM ${kind.table} WHERE ${kind.idColumn} = $1`,
            [row.id],
          )) as Array<{ exact: string }>;

          expect(exact).toBe(INSTANT);

          // ...and the read keysetPaginate's cursor lookup used to make loses them, which is the whole flaw.
          const { alias, timeProp } = kind.options;
          const entity = await dataSource
            .getRepository(kind.entity)
            .createQueryBuilder(alias)
            .where(`${alias}.id = :id`, { id: row.id })
            .getOne();

          expect((entity as ObjectLiteral)[timeProp].toISOString()).toBe('2026-05-01T00:00:00.123Z');
        },
      );
    });

    describe.each(DATASET_NAMES)('keysetPaginate over %s', (dataset) => {
      describe.each(kinds.map((kind) => kind.name))('%s', (name) => {
        const kind = kinds.find((candidate) => candidate.name === name)!;
        const fetchPage: Fetch = async (args) => {
          const page = await keysetPaginate(dataSource.getRepository(kind.entity), args, {
            ...kind.options,
            userId: owners[dataset],
          });

          return { ...page, ids: page.entities.map((entity) => (entity as { id: string }).id) };
        };

        describe.each(directions)('%s', (direction) => {
          it.each(sizes)('in pages of %i serves every row once, in order', async (size) => {
            await expectCompleteWalk(fetchPage, direction, seeded.get(keyOf(name, dataset))!, size);
          });
        });
      });
    });

    // ── Part B: the five call sites, through their services ───────────────────

    interface Site {
      name: string;
      /** The seeded group whose rows this site reads. */
      group: string;
      owner: (dataset: DatasetName) => string;
      fetch: (owner: string, args: KeysetPageArgs) => Promise<{ entities: Array<{ id: string }> } & PageOf>;
    }

    const sites: Site[] = [
      {
        name: 'ContentService.findPage',
        group: 'content (created_at)',
        owner: (dataset) => owners[dataset],
        fetch: (owner, args) => services.contents.findPage(ctx(owner), args) as never,
      },
      {
        name: 'CommunicationService.findPage',
        group: 'communication (time)',
        owner: (dataset) => owners[dataset],
        fetch: (owner, args) => services.communications.findPage(ctx(owner), args) as never,
      },
      {
        name: 'BrowserActivityService.findPage',
        group: 'browser activity (time)',
        owner: (dataset) => owners[dataset],
        fetch: (owner, args) => services.browserActivity.findPage(ctx(owner), args) as never,
      },
      {
        name: 'CalendarEventService.findPage',
        group: 'event (start_time)',
        owner: (dataset) => owners[dataset],
        fetch: (owner, args) => services.events.findPage(ctx(owner), args) as never,
      },
      {
        name: 'CalendarEventService.findDeletedPage',
        group: DELETED_EVENTS,
        owner: (dataset) => deletedOwners[dataset],
        fetch: (owner, args) => services.events.findDeletedPage(ctx(owner), args) as never,
      },
    ];

    describe.each(DATASET_NAMES)('the call sites over %s', (dataset) => {
      describe.each(sites.map((site) => site.name))('%s', (name) => {
        const site = sites.find((candidate) => candidate.name === name)!;
        const fetchPage: Fetch = async (args) => {
          const page = await site.fetch(site.owner(dataset), args);

          return { ...page, ids: page.entities.map((entity) => entity.id) };
        };

        describe.each(directions)('%s', (direction) => {
          it('in pages of 3 serves every row once, in order', async () => {
            await expectCompleteWalk(fetchPage, direction, seeded.get(keyOf(site.group, dataset))!, 3);
          });
        });
      });
    });
  },
);

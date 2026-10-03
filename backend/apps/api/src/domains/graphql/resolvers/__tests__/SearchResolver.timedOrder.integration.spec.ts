import { randomBytes } from 'node:crypto';

import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';

import type { RequestContext, UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { BrowserActivityEntity, BrowserActivityService } from '@ci/domains/browser-activity';
import type { EventService } from '@ci/domains/events';
import { FileEntity, FileService } from '@ci/domains/files';
import { AnswerEntity, AnswerService, QuestionEntity } from '@ci/domains/intelligence';
import {
  BaseEntity,
  CalendarEventService,
  CommunicationBaseEntity,
  CommunicationEntity,
  CommunicationService,
  ConceptEntity,
  ConceptService,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  ItemBaseEntity,
  ItemEntity,
  ItemService,
  PersonEntity,
  PersonService,
  PlaceEntity,
  PlaceService,
  ProductModelEntity,
  ProductModelService,
  ReceiptEntity,
  ReceiptLineItemEntity,
  ReceiptService,
} from '@ci/domains/memory';
import { NoteEntity, NoteService } from '@ci/domains/notes';
import { FileChunkEntity, FileChunkService } from '@ci/domains/parsing';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { HAPPENED, insertEvent } from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GlobalUID } from '../../types/GlobalUID';
import type { SearchInput } from '../../types/SearchInput';
import { SearchResolver } from '../SearchResolver';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TIMED BROWSE PAGES IN EITHER DIRECTION. THE REAL SQL, IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEM-15: "Oldest first" opened in the middle of the range and then walked
 * backwards. `SearchResolver.timedOrder.spec.ts` holds the resolver to the
 * contract with the services stubbed; this file holds the SERVICES to it, in
 * Postgres, because the contract is mostly SQL: the direction of ORDER BY, the
 * direction of the seek, the direction of the id tiebreak, and what the seek
 * does with a timestamp the cursor cannot spell.
 *
 * That last one is why a stub cannot stand in. Every column the browse pages on
 * is `timestamptz(6)`: MICROseconds. The cursor's time is a JavaScript `Date`,
 * which is milliseconds, and the driver TRUNCATES on the way in
 * (`10:00:00.123456` is read as `.123`). So a row stamped `.123456` is, to the
 * seek that follows it, *later* than its own cursor. Every `now()`-stamped table
 * (notes, files, content, things, people, places, concepts, answers) carries
 * microseconds, and a bulk import stamps a whole batch with the SAME instant:
 *
 *   - paging DOWN used `time < cursor OR (time = cursor AND id < cursorId)`.
 *     `time = cursor` never matches a microsecond value, so a batch bigger than
 *     a page lost everything after the page boundary, silently;
 *   - the obvious ascending mirror, `time > cursor`, matches the cursor row's
 *     own millisecond: the page repeats, and a batch bigger than a page repeats
 *     for ever.
 *
 * So part A pages every fetcher through a cluster of five rows stamped to the
 * same MICROsecond, three rows (and then one row) at a time, so the cursor lands
 * inside the cluster, in both directions, with the cursor minted the way the
 * resolver mints it: the ordering column as the driver hands it back, plus the
 * row's id. Part B runs the resolver itself over the same SQL.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run
 * `make test-db ARGS=SearchResolver.timedOrder.integration`. Every fixture
 * belongs to a synthetic user and is deleted in `afterAll`.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graphql/SearchResolver.timedOrder.integration] SKIPPED — ${availability.reason}`);
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
/** Does `at` carry anything a millisecond cursor cannot spell? */
const hasSubMillisecond = (at: string) => /\.\d{3}0*[1-9]\d*Z$/.test(at);

/** The order the browse promises: the millisecond the cursor can spell, then the id. */
const byKey = (a: { id: string; at: string }, b: { id: string; at: string }) =>
  Date.parse(toMilliseconds(a.at)) - Date.parse(toMilliseconds(b.at)) || (a.id < b.id ? -1 : 1);

interface SeedRow {
  id: string;
  at: string;
}

type Direction = 'ASC' | 'DESC';

interface FetchOptions {
  limit: number;
  order: Direction;
  afterTime?: Date;
  afterId?: string;
}

/** One entity kind: how to put a row in, how to ask its service for a page, how to mint the cursor. */
interface Kind {
  name: string;
  type: IndexableEntity;
  /** Which synthetic user the fetch runs as (the appearance kinds need one of their own). */
  user: 'main' | 'appearance';
  /** Insert one row whose ordering column is `row.at` (microseconds allowed), owned by `owner`. */
  seed(row: SeedRow, owner: string): Promise<void>;
  fetch(options: FetchOptions): Promise<EntityIdentifier<IndexableEntity>[]>;
  /** The instant a cursor for this identifier is minted from. */
  timeOf(identifier: EntityIdentifier<IndexableEntity>): Promise<Date>;
}

/**
 * Ten rows per kind, across the month boundary. Five of them are one instant to the
 * MICROsecond; the row after them is the very next millisecond, which a seek that
 * treated the whole bucket as "the cursor" would swallow.
 */
const DATASET: Array<Omit<SeedRow, 'id'>> = [
  { at: '2026-04-29T09:00:00.100000Z' },
  { at: '2026-04-30T23:59:59.999000Z' },
  { at: '2026-05-01T00:00:00.123456Z' },
  { at: '2026-05-01T00:00:00.123456Z' },
  { at: '2026-05-01T00:00:00.123456Z' },
  { at: '2026-05-01T00:00:00.123456Z' },
  { at: '2026-05-01T00:00:00.123456Z' },
  { at: '2026-05-01T00:00:00.124000Z' },
  { at: '2026-05-03T08:00:00.000000Z' },
  { at: '2026-05-13T20:00:00.500000Z' },
];

const APPEARANCE_WINDOW = {
  startTime: new Date('2026-04-01T00:00:00.000Z'),
  endTime: new Date('2026-06-01T00:00:00.000Z'),
};

describeWithDb(`timed browse paging in both directions, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let mainUser: string;
  let appearanceUser: string;
  let sharedFileId: string;
  const synthetic: string[] = [];
  const questionIds: string[] = [];

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);
  const ctx = (user: 'main' | 'appearance') =>
    ({ userId: user === 'main' ? mainUser : appearanceUser }) as UserServiceContext;

  const repository = <T extends ObjectLiteral>(entity: EntityTarget<T>) => dataSource.getRepository(entity);

  let services: ReturnType<typeof buildServices>;

  function buildServices(db: DataSource) {
    const deltaWriter = new GraphDeltaWriter(db, logger());

    return {
      events: new CalendarEventService(
        repository(EventEntity),
        repository(EventBaseEntity),
        signalling,
        db,
        deltaWriter,
      ),
      communications: new CommunicationService(
        repository(CommunicationEntity),
        signalling,
        logger(),
        db,
        deltaWriter,
      ),
      browserActivity: new BrowserActivityService(
        repository(BrowserActivityEntity),
        signalling,
        logger(),
        db,
      ),
      files: new FileService(repository(FileEntity), signalling, logger()),
      fileChunks: new FileChunkService(repository(FileChunkEntity), logger()),
      notes: new NoteService(repository(NoteEntity), signalling, logger()),
      contents: new ContentService(
        repository(ContentEntity),
        repository(ContentBaseEntity),
        repository(EventEntity),
        signalling,
        deltaWriter,
      ),
      people: new PersonService(repository(PersonEntity), logger(), signalling),
      places: new PlaceService(repository(PlaceEntity), signalling, deltaWriter),
      concepts: new ConceptService(repository(ConceptEntity), logger(), signalling),
      items: new ItemService(
        repository(ItemEntity),
        repository(ItemBaseEntity),
        logger(),
        signalling,
        deltaWriter,
      ),
      products: new ProductModelService(repository(ProductModelEntity), {} as never, signalling, logger()),
      receipts: new ReceiptService(
        repository(ReceiptEntity),
        repository(ReceiptLineItemEntity),
        {} as never,
        {} as never,
        {} as never,
        signalling,
        logger(),
      ),
      answers: new AnswerService(repository(AnswerEntity), signalling, {} as never),
    };
  }

  /** The ordering column as the driver hands it back — the same `Date` the resolver mints a cursor from. */
  const readTime = async (table: string, idColumn: string, timeSql: string, id: string): Promise<Date> => {
    const rows = (await query(`SELECT ${timeSql} AS t FROM ${table} WHERE ${idColumn} = $1`, [id])) as Array<{
      t: Date;
    }>;

    return rows[0].t;
  };

  const column =
    (table: string, idColumn: string, timeSql: string) =>
    (identifier: EntityIdentifier<IndexableEntity>): Promise<Date> =>
      readTime(table, idColumn, timeSql, identifier.id);

  /** A graph kind: one `ci.entities` row, stamped. */
  const entityRow = (entityType: string) => async (row: SeedRow, owner: string) => {
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5::timestamptz)`,
      [row.id, entityType, `${entityType} ${row.id}`, owner, row.at],
    );
  };

  /** An event owned by `owner` at `at`; the microseconds are written after, as `insertEvent` takes milliseconds. */
  async function seedEvent(row: SeedRow, owner: string, title = `event ${row.id}`): Promise<void> {
    await insertEvent(query, owner, {
      id: row.id,
      title,
      at: Date.parse(toMilliseconds(row.at)),
      lifecycle: HAPPENED,
      point: null,
    });

    if (hasSubMillisecond(row.at)) {
      await query('UPDATE ci.events SET start_time = $2::timestamptz WHERE event_id = $1', [row.id, row.at]);
    }
  }

  /** An event linked to the entity by `linkColumn` — how a person or a place comes to "appear" in a window. */
  async function seedLinkedEvent(
    linkColumn: string,
    entityId: string,
    at: string,
    owner: string,
  ): Promise<void> {
    const event = { id: nextId(), at };

    await seedEvent(event, owner, `visit ${event.id}`);
    await query(`UPDATE ci.events SET ${linkColumn} = $2 WHERE event_id = $1`, [event.id, entityId]);
  }

  const orderBy = (field: string, order: Direction) => ({ [field]: order });

  function buildKinds(): Kind[] {
    return [
      {
        name: 'event',
        type: 'event',
        user: 'main',
        seed: (row, owner) => seedEvent(row, owner),
        fetch: ({ order, ...rest }) =>
          services.events.getEntitiesForEvents(ctx('main'), { ...rest, order: orderBy('startTime', order) }),
        timeOf: column('ci.events', 'event_id', 'start_time'),
      },
      {
        name: 'communication',
        type: 'communication',
        user: 'main',
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
        fetch: ({ order, ...rest }) =>
          services.communications.getEntitiesForCommunications(ctx('main'), {
            ...rest,
            order: orderBy('time', order),
          }),
        timeOf: column('ci.communications', 'id', '"time"'),
      },
      {
        name: 'browser-activity',
        type: 'browser-activity',
        user: 'main',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.browser_activity (id, "time", url, user_id)
             VALUES ($1, $2::timestamptz, 'https://example.test/page', $3)`,
            [row.id, row.at, owner],
          );
        },
        fetch: ({ order, ...rest }) =>
          services.browserActivity.getEntitiesForBrowserActivities(ctx('main'), {
            ...rest,
            order: orderBy('time', order),
          }),
        timeOf: column('ci.browser_activity', 'id', '"time"'),
      },
      {
        name: 'file',
        type: 'file',
        user: 'main',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.files (id, content_type, user_id, updated_at)
             VALUES ($1, 'image/jpeg', $2, $3::timestamptz)`,
            [row.id, owner, row.at],
          );
        },
        fetch: (options) => services.files.getEntitiesForFiles(ctx('main'), options),
        timeOf: column('ci.files', 'id', 'updated_at'),
      },
      {
        name: 'file-chunk',
        type: 'file-chunk',
        user: 'main',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.file_chunks
               (id, file_id, user_id, chunk_index, content, parser_name, parser_version, chunker_version, updated_at)
             VALUES ($1, $2, $3, $4, 'chunk', 'spec', '1', '1', $5::timestamptz)`,
            // Unique per file and parser version; the id's own low digits are unique per row.
            [row.id, sharedFileId, owner, Number.parseInt(row.id.slice(-12), 16), row.at],
          );
        },
        fetch: (options) => services.fileChunks.getEntitiesForFileChunks(ctx('main'), options),
        timeOf: column('ci.file_chunks', 'id', 'updated_at'),
      },
      {
        name: 'note',
        type: 'note',
        user: 'main',
        seed: async (row, owner) => {
          await query(`INSERT INTO ci.notes (id, user_id, updated_at) VALUES ($1, $2, $3::timestamptz)`, [
            row.id,
            owner,
            row.at,
          ]);
        },
        fetch: (options) => services.notes.getEntitiesForNotes(ctx('main'), options),
        timeOf: column('ci.notes', 'id', 'updated_at'),
      },
      {
        name: 'content',
        type: 'content',
        user: 'main',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
             VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
            [row.id, `content ${row.id}`, owner],
          );
          await query(
            `INSERT INTO ci.content (id, type, user_id, updated_at) VALUES ($1, 'text', $2, $3::timestamptz)`,
            [row.id, owner, row.at],
          );
        },
        fetch: (options) => services.contents.getEntitiesForContents(ctx('main'), options),
        timeOf: column('ci.content', 'id', 'updated_at'),
      },
      {
        name: 'person',
        type: 'person',
        user: 'main',
        seed: entityRow('Person'),
        fetch: (options) => services.people.getEntitiesForPeople(ctx('main'), options),
        timeOf: column('ci.entities', 'entity_id', 'updated_at'),
      },
      {
        name: 'person, by appearance in a date window',
        type: 'person',
        user: 'appearance',
        seed: async (row, owner) => {
          await entityRow('Person')(row, owner);
          await seedLinkedEvent('organizer_entity_id', row.id, row.at, owner);
        },
        fetch: (options) =>
          services.people.getEntitiesForPeople(ctx('appearance'), { ...options, ...APPEARANCE_WINDOW }),
        timeOf: async (identifier) => identifier.sortTime as Date,
      },
      {
        name: 'place',
        type: 'place',
        user: 'main',
        seed: entityRow('Location'),
        fetch: (options) => services.places.getEntitiesForPlaces(ctx('main'), options),
        timeOf: column('ci.entities', 'entity_id', 'updated_at'),
      },
      {
        name: 'place, by appearance in a date window',
        type: 'place',
        user: 'appearance',
        seed: async (row, owner) => {
          await entityRow('Location')(row, owner);
          await seedLinkedEvent('location_entity_id', row.id, row.at, owner);
        },
        fetch: (options) =>
          services.places.getEntitiesForPlaces(ctx('appearance'), { ...options, ...APPEARANCE_WINDOW }),
        timeOf: async (identifier) => identifier.sortTime as Date,
      },
      {
        name: 'concept',
        type: 'concept',
        user: 'main',
        seed: entityRow('Concept'),
        fetch: (options) => services.concepts.getEntitiesForConcepts(ctx('main'), options),
        timeOf: column('ci.entities', 'entity_id', 'updated_at'),
      },
      {
        name: 'item',
        type: 'item',
        user: 'main',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
             VALUES ($1, 'Item', $2, '{}'::jsonb, $3, 'objects', $1)`,
            [row.id, `item ${row.id}`, owner],
          );
          await query(
            `INSERT INTO ci.objects (object_id, user_id, updated_at) VALUES ($1, $2, $3::timestamptz)`,
            [row.id, owner, row.at],
          );
        },
        fetch: (options) => services.items.getEntitiesForItems(ctx('main'), options),
        timeOf: column('ci.objects', 'object_id', 'updated_at'),
      },
      {
        name: 'product',
        type: 'product',
        user: 'main',
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.product_models (product_id, user_id, title, updated_at)
             VALUES ($1, $2, $3, $4::timestamptz)`,
            [row.id, owner, `product ${row.id}`, row.at],
          );
        },
        fetch: (options) => services.products.getEntitiesForProducts(ctx('main'), options),
        timeOf: column('ci.product_models', 'product_id', 'updated_at'),
      },
      {
        name: 'receipt',
        type: 'receipt',
        user: 'main',
        // The purchase date is the ordering key; the row's write time is deliberately far from it.
        seed: async (row, owner) => {
          await query(
            `INSERT INTO ci.receipts (receipt_id, user_id, purchased_at, updated_at)
             VALUES ($1, $2, $3::timestamptz, '2020-01-01T00:00:00Z')`,
            [row.id, owner, row.at],
          );
        },
        fetch: (options) => services.receipts.getEntitiesForReceipts(ctx('main'), options),
        timeOf: column('ci.receipts', 'receipt_id', 'COALESCE(purchased_at, updated_at)'),
      },
      {
        name: 'answer',
        type: 'answer',
        user: 'main',
        seed: async (row, owner) => {
          const [{ question_id }] = (await query(
            `INSERT INTO ci.questions (question_text) VALUES ('timed order spec') RETURNING question_id`,
          )) as Array<{ question_id: string }>;

          questionIds.push(question_id);

          await query(
            `INSERT INTO ci.answers (answer_id, question_id, user_id, answer_text, answered_at)
             VALUES ($1, $2, $3, 'yes', $4::timestamptz)`,
            [row.id, question_id, owner, row.at],
          );
        },
        fetch: (options) => services.answers.getEntitiesForAnswers(ctx('main'), options),
        timeOf: column('ci.answers', 'answer_id', 'answered_at'),
      },
    ];
  }

  // Built here, not in beforeAll, so the cases below can be generated from the names. The closures
  // read `services` and the user ids when they RUN, by which time beforeAll has set them.
  const kinds = buildKinds();
  const kindOf = (type: IndexableEntity) => kinds.find((kind) => kind.type === type && kind.user === 'main')!;
  const seeded = new Map<string, SeedRow[]>();

  const ownerOf = (kind: Kind) => (kind.user === 'main' ? mainUser : appearanceUser);

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
        ItemEntity,
        ItemBaseEntity,
        PersonEntity,
        PlaceEntity,
        ConceptEntity,
        ProductModelEntity,
        ReceiptEntity,
        ReceiptLineItemEntity,
        FileEntity,
        FileChunkEntity,
        NoteEntity,
        AnswerEntity,
        QuestionEntity,
        BrowserActivityEntity,
        UserEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'graphql/SearchResolver.timedOrder.integration');

    mainUser = await createSyntheticTestUser(query, 'TimedOrderMain');
    appearanceUser = await createSyntheticTestUser(query, 'TimedOrderAppearance');
    synthetic.push(mainUser, appearanceUser);

    services = buildServices(dataSource);

    // The parent every chunk hangs from. The OTHER user owns it: it is an original file, so the
    // `file` fetcher would otherwise return it as an eleventh row of the main user's.
    sharedFileId = nextId();
    await query(
      `INSERT INTO ci.files (id, content_type, user_id, updated_at)
       VALUES ($1, 'application/pdf', $2, '2020-01-01T00:00:00Z')`,
      [sharedFileId, appearanceUser],
    );

    for (const kind of kinds) {
      const rows = DATASET.map((row) => ({ ...row, id: nextId() }));

      for (const row of rows) {
        await kind.seed(row, ownerOf(kind));
      }

      seeded.set(kind.name, rows);
    }
  });

  async function wipe(): Promise<void> {
    await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [synthetic]);
    await query('DELETE FROM ci.answers WHERE user_id = ANY($1::uuid[])', [synthetic]);

    if (questionIds.length > 0) {
      await query('DELETE FROM ci.questions WHERE question_id = ANY($1::uuid[])', [questionIds]);
    }

    for (const table of [
      'ci.file_chunks',
      'ci.files',
      'ci.notes',
      'ci.browser_activity',
      'ci.communications',
      'ci.content',
      'ci.events',
      'ci.receipts',
      'ci.product_models',
      'ci.objects',
    ]) {
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

  // ── Part A: every fetcher, both directions, through a microsecond cluster ──

  async function walkKind(kind: Kind, order: Direction, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: { afterTime: Date; afterId: string } | undefined;

    // Ten rows is at most eleven fetches at limit 1. A seek that cannot get past the cluster would
    // loop for ever, so the walk is bounded and the comparison below reports what it saw.
    for (let guard = 0; guard < 25; guard++) {
      const page = await kind.fetch({ limit, order, ...cursor });

      if (page.length === 0) {
        break;
      }

      seen.push(...page.map((identifier) => identifier.id));

      const last = page[page.length - 1];

      cursor = { afterTime: await kind.timeOf(last), afterId: last.id };
    }

    return seen;
  }

  it('seeds every kind, with its microseconds intact', async () => {
    for (const kind of kinds) {
      expect(seeded.get(kind.name)).toHaveLength(DATASET.length);
    }

    // The fixture only proves anything if the database kept the microseconds: a BEFORE INSERT
    // trigger that re-stamped the row would let every case below pass for the wrong reason.
    const [{ exact }] = (await query(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS exact
         FROM ci.notes WHERE id = $1`,
      [seeded.get('note')![2].id],
    )) as Array<{ exact: string }>;

    expect(exact).toBe('2026-05-01T00:00:00.123456');

    // ...and that the driver truncates, which is what makes the cursor lossy in the first place.
    const stored = await kindOf('note').timeOf({ id: seeded.get('note')![2].id, type: 'note' });

    expect(stored.toISOString()).toBe('2026-05-01T00:00:00.123Z');
  });

  describe.each(['ASC', 'DESC'] as const)('%s', (order) => {
    it.each(kinds.map((kind) => kind.name))(
      `pages %s ${order === 'ASC' ? 'oldest to newest' : 'newest to oldest'} through five rows of one microsecond`,
      async (name) => {
        const kind = kinds.find((candidate) => candidate.name === name)!;
        const expected = [...seeded.get(name)!].sort(byKey).map((row) => row.id);

        if (order === 'DESC') {
          expected.reverse();
        }

        // limit 3 puts the cursor inside the cluster, on its second row...
        expect(await walkKind(kind, order, 3)).toEqual(expected);

        // ...and one row at a time makes every row of the cluster a page boundary.
        expect(await walkKind(kind, order, 1)).toEqual(expected);
      },
    );
  });

  // ── Part B: the resolver over the same SQL ─────────────────────────────────

  describe('through SearchResolver', () => {
    const WINDOW = { startTime: '2026-04-29T00:00:00.000Z', endTime: '2026-05-13T23:59:59.999Z' };
    const CLUSTER_AT = '2026-05-01T12:00:00.123456Z';
    const TIE_AT = '2026-05-06T07:00:00.000000Z';

    /** The types the unfiltered browse merges that this part seeds, and where each one's time lives. */
    const BROWSED: Record<string, { table: string; idColumn: string; timeSql: string; field: string }> = {
      event: { table: 'ci.events', idColumn: 'event_id', timeSql: 'start_time', field: 'startTime' },
      communication: { table: 'ci.communications', idColumn: 'id', timeSql: '"time"', field: 'time' },
      'browser-activity': { table: 'ci.browser_activity', idColumn: 'id', timeSql: '"time"', field: 'time' },
      note: { table: 'ci.notes', idColumn: 'id', timeSql: 'updated_at', field: 'updatedAt' },
      content: { table: 'ci.content', idColumn: 'id', timeSql: 'updated_at', field: 'updatedAt' },
      file: { table: 'ci.files', idColumn: 'id', timeSql: 'updated_at', field: 'updatedAt' },
    };

    interface Browsed {
      id: string;
      type: IndexableEntity;
      at: string;
    }

    /** Everything this part seeds for its own synthetic user. */
    const browsed: Browsed[] = [];
    let browseUser: string;
    let resolver: SearchResolver;

    async function seedBrowse(type: IndexableEntity, at: string): Promise<void> {
      const row = { id: nextId(), at };

      await kindOf(type).seed(row, browseUser);
      browsed.push({ ...row, type });
    }

    /** What EntityResolutionService hands back, reduced to the one field the browse orders by. */
    const entityResolutionService = {
      resolve: jest.fn(async (_context: unknown, identifiers: EntityIdentifier<IndexableEntity>[]) => {
        const resolved = new Map<string, unknown>();

        for (const [type, source] of Object.entries(BROWSED)) {
          const ids = identifiers.filter((identifier) => identifier.type === type).map(({ id }) => id);

          if (ids.length === 0) {
            continue;
          }

          const rows = (await query(
            `SELECT ${source.idColumn} AS id, ${source.timeSql} AS t FROM ${source.table}
              WHERE ${source.idColumn} = ANY($1::uuid[])`,
            [ids],
          )) as Array<{ id: string; t: Date }>;

          for (const row of rows) {
            resolved.set(`${type}:${row.id}`, {
              type,
              id: row.id,
              entity: { id: row.id, [source.field]: row.t, tags: [] },
            });
          }
        }

        return resolved;
      }),
    };

    const empty = (fetch: string) => ({
      [fetch]: jest.fn(async () => []),
      [fetch.replace('getEntitiesFor', 'countEntitiesFor')]: jest.fn(async () => 0),
    });

    const ascending = () => [...browsed].sort(byKey).map((item) => `${item.type}:${item.id}`);
    const context = () => ({ userId: browseUser }) as RequestContext;

    // This part has a user of its own, so Part A's rows never join its ground truth. It borrows only
    // the kinds' `seed`; the pages come from the resolver, called as that user.
    beforeAll(async () => {
      browseUser = await createSyntheticTestUser(query, 'TimedOrderBrowse');
      synthetic.push(browseUser);

      // A dominant type: more events in range than a page's per-type window (first * 4),
      // so the old newest-first fetch had a real tail to cut off.
      for (let index = 0; index < 130; index++) {
        const at = new Date(Date.parse(WINDOW.startTime) + Math.floor(index * 2.65 * 3_600_000) + index);

        await seedBrowse('event', at.toISOString());
      }

      for (const type of ['communication', 'browser-activity', 'note', 'content', 'file'] as const) {
        for (let index = 0; index < 6; index++) {
          const hours = (index * 53 + type.length * 17) % 340;
          const at = new Date(Date.parse(WINDOW.startTime) + hours * 3_600_000 + index * 7);

          await seedBrowse(type, at.toISOString());
        }
      }

      // One instant shared by every type, ids against the type order: the tiebreak, across tables.
      for (const type of Object.keys(BROWSED).reverse() as IndexableEntity[]) {
        await seedBrowse(type, TIE_AT);
      }

      // A bulk-import batch: thirty notes stamped by one `now()`, to the microsecond.
      for (let index = 0; index < 30; index++) {
        await seedBrowse('note', CLUSTER_AT);
      }

      await seedBrowse('note', '2026-04-30T23:59:59.999000Z');
      await seedBrowse('event', '2026-05-01T00:00:00.000000Z');

      // The same services the cases above exercised, scoped by the context the resolver is called with.
      resolver = new SearchResolver(
        services.browserActivity,
        services.communications,
        empty('getEntitiesForConcepts') as never,
        services.contents,
        entityResolutionService as never,
        services.events,
        services.files,
        empty('getEntitiesForFileChunks') as never,
        empty('getEntitiesForItems') as never,
        services.notes,
        empty('getEntitiesForPeople') as never,
        empty('getEntitiesForPlaces') as never,
        empty('getEntitiesForProducts') as never,
        empty('getEntitiesForReceipts') as never,
        empty('getEntitiesForAnswers') as never,
        {} as never,
        {
          authorize: jest.fn().mockResolvedValue({ grantId: 'grant-test', ceiling: undefined }),
          recordRead: jest.fn().mockResolvedValue(undefined),
        } as never,
        { search: jest.fn(async () => []) } as never,
        { getEntitiesForTags: jest.fn(async () => []), searchByLabel: jest.fn(async () => []) } as never,
        { isFeatureEnabled: jest.fn(async () => false) } as never,
      );
    });

    async function walk(input: Partial<SearchInput>) {
      const ids: string[] = [];
      const pages: Array<Awaited<ReturnType<SearchResolver['search']>>> = [];
      let after: string | null | undefined;

      for (let guard = 0; guard < 120; guard++) {
        const page = await resolver.search(context(), {
          ...input,
          ...(after ? { after } : {}),
        } as SearchInput);

        pages.push(page);
        ids.push(
          ...page.edges.map((edge) => {
            const { type, id } = GlobalUID.decode((edge.node as { id: string }).id);

            return `${type}:${id}`;
          }),
        );

        if (!page.pageInfo.hasNextPage) {
          break;
        }

        after = page.pageInfo.endCursor;
      }

      return { ids, pages };
    }

    it('seeded a dominant type, a cross-type tie and a batch', () => {
      expect(browsed.filter((item) => item.type === 'event').length).toBeGreaterThan(30 * 4);
      expect(browsed.filter((item) => item.at === TIE_AT)).toHaveLength(Object.keys(BROWSED).length);
      expect(browsed.filter((item) => item.at === CLUSTER_AT)).toHaveLength(30);
    });

    it.each([30, 7])('pages oldest first with first=%i: whole, in order, once each', async (first) => {
      const { ids, pages } = await walk({ ...WINDOW, first, sortBy: 'time', sortOrder: 'asc' });

      expect(ids).toEqual(ascending());
      expect(pages.length).toBeGreaterThanOrEqual(3);
    });

    it('pages oldest first through a thirty-row microsecond batch with a page of five', async () => {
      const { ids, pages } = await walk({ ...WINDOW, first: 5, sortBy: 'time', sortOrder: 'asc' });

      expect(ids).toEqual(ascending());
      // Thirty notes of one instant cannot fit in a page: the cursor has to land inside the batch.
      expect(pages.length).toBeGreaterThan(30 / 5);
    });

    it.each([30, 5])(
      'still pages newest first with first=%i, including the microsecond batch',
      async (first) => {
        const { ids } = await walk({ ...WINDOW, first, sortBy: 'time', sortOrder: 'desc' });

        expect(ids).toEqual(ascending().reverse());
      },
    );

    it('reports one totalCount, equal to the rows that exist, whichever way and whichever page', async () => {
      for (const sortOrder of ['asc', 'desc']) {
        const { pages } = await walk({ ...WINDOW, first: 30, sortBy: 'time', sortOrder });

        expect(new Set(pages.map((page) => page.totalCount))).toEqual(new Set([browsed.length]));
      }
    });

    it('opens on the first row of the range', async () => {
      const page = await resolver.search(context(), {
        ...WINDOW,
        first: 30,
        sortBy: 'time',
        sortOrder: 'asc',
      } as SearchInput);

      const first = GlobalUID.decode((page.edges[0].node as { id: string }).id);

      expect(`${first.type}:${first.id}`).toBe(ascending()[0]);
    });

    it('stays correct with no date window', async () => {
      const { ids } = await walk({ first: 30, sortBy: 'time', sortOrder: 'asc' });

      expect(ids).toEqual(ascending());
    });
  });
});

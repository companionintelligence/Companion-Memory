import { DataSource, type QueryRunner } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import {
  BaseEntity,
  GraphDeltaWriter,
  PersonEntity,
  PersonMergeService,
  PersonService,
} from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { EntityIdentifierEntity } from '../entities/EntityIdentifierEntity';
import { NodeEntity } from '../entities/NodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';
import { mergedPropertiesSql, mergeIngestedProperties, unionKeysFor } from '../utils/ingestedProperties';

import { EntityIdentifierService } from './EntityIdentifierService';
import { type GraphEntityInputDto, GraphIngestService } from './GraphIngestService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN IMPORT MUST NOT UNDO A MERGE. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The report (2026-09-29): `GraphIngestService` refreshed an existing entity
 * with `DO UPDATE SET ... properties = EXCLUDED.properties` whenever ANYTHING
 * differed from the stored row. A merge target's properties always differ from
 * its own card — PersonMergeService's fold put its duplicates' numbers there —
 * so the next import of that card replaced them wholesale, and the merged-in
 * numbers vanished. So did every other writer's keys (`is_self`, a person
 * edit's structured names, planner settings), and the importer's missing
 * description blanked any description on the row.
 *
 * What this suite pins, with the real services on real rows:
 *
 *  1. The reported loss, end to end: import, merge with PersonMergeService,
 *     import the survivor's card again — the merged-in numbers stay, and an
 *     unchanged card does not even rewrite the row.
 *  2. Other writers' keys and the row's description survive a re-import that
 *     changes something of its own; a key the card itself sends is still the
 *     card's.
 *  3. A parser's `accumulate` declaration is honoured across imports.
 *  4. The SQL merge and its TS definition (`utils/ingestedProperties.ts`) agree.
 *  5. The merge is atomic: a merge that COMMITS while the import's upsert
 *     waits on its row lock is merged into, not overwritten. This one runs on
 *     committed rows over separate connections, and deletes what it made.
 *
 * Everything else happens in one transaction, rolled back in `afterAll`.
 * Opt-in like its neighbours — set `MEMORY_TEST_DATABASE_URL` (or
 * `DATABASE_URL`) to a migrated database of your OWN: a private `ci/database`
 * container with `yarn workspace @ci/be-api migrate` run against it. Host port
 * 5432 usually belongs to another worktree's stack.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:…@127.0.0.1:<port>/companion \
 *     yarn workspace @ci/be-api jest GraphIngestService.propertyMerge.integration
 *
 * Every person, number and address here is invented: 555-01XX under real area
 * codes, `.example` domains.
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graph/GraphIngestService.propertyMerge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = () =>
  ({ setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as never;

/** The vCard parser's `accumulate` declaration (vcard.ts ACCUMULATED_KEYS), as the staged row carries it. */
const VCARD_ACCUMULATE = [
  'Names',
  'Emails',
  'Phones',
  'URLs',
  'Organizations',
  'JobTitles',
  'Addresses',
  'Notes',
  'Nicknames',
  'Categories',
  'SocialProfiles',
  'Files',
];

/** A contact card keyed on its phone, in the shape the import's `toGraphEntity` hands over. */
function vcard(handle: string, name: string, metadata: Record<string, unknown> = {}): GraphEntityInputDto {
  return {
    key: `contact:${handle}`,
    entityType: 'Person',
    name,
    sourceSystem: 'vcard',
    properties: {
      Source: 'vCard',
      Names: [name],
      Files: ['Contacts.vcf'],
      ...metadata,
      phone: handle,
      phones: [handle],
      names: [name],
    },
    accumulate: VCARD_ACCUMULATE,
  };
}

function connect(max: number): DataSource {
  const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

  if (connection == null) {
    throw new Error('databaseAvailability passed but no connection resolved');
  }

  return new DataSource({
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
    entities: [BaseEntity, PersonEntity, NodeEntity, RelationshipEntity, EntityIdentifierEntity],
    synchronize: false,
    logging: false,
    extra: { max },
  });
}

interface StoredRow {
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  /** Moves on every UPDATE, so an unmoved one proves the row was not rewritten. */
  ctid: string;
}

describeWithDb(`re-importing an entity merges into what is stored (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let ctx: UserServiceContext;
  let graph: GraphIngestService;
  let merges: PersonMergeService;

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  async function ingest(...entities: GraphEntityInputDto[]): Promise<Map<string, string>> {
    const result = await graph.ingest(ctx, { entities, relationships: [] });

    expect(result.errors).toEqual([]);

    return new Map(result.entities.map((entity) => [entity.key, entity.entityId]));
  }

  async function row(entityId: string): Promise<StoredRow> {
    const [found] = await q<StoredRow[]>(
      `SELECT name, description, properties, ctid::text AS ctid FROM ci.entities WHERE entity_id = $1`,
      [entityId],
    );

    return found;
  }

  beforeAll(async () => {
    dataSource = connect(2);
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ctx = {
      userId: await createSyntheticTestUser((sql, params) => q(sql, params), 'PropertyMerge'),
    } as never;

    // The delta writer takes a DataSource and only ever calls `query` on it
    // (GraphIngestService passes no manager). Pointed at the transaction, its
    // rows land — and roll back — with everything else.
    const inTransaction = {
      query: (sql: string, params?: unknown[]) => runner.query(sql, params),
    } as unknown as DataSource;
    const deltas = new GraphDeltaWriter(inTransaction, logger());

    graph = new GraphIngestService(
      runner.manager.getRepository(NodeEntity),
      runner.manager.getRepository(RelationshipEntity),
      new EntityIdentifierService(runner.manager.getRepository(EntityIdentifierEntity), logger()),
      logger(),
      deltas,
    );
    // The real merge. Its own transaction nests as a savepoint on this runner.
    merges = new PersonMergeService(
      runner.manager.getRepository(PersonEntity),
      logger(),
      { send: jest.fn() } as never,
      deltas,
    );
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe('a merge target’s own card, imported again', () => {
    // Ada's work card lists her office line. Her mobile only ever reached the
    // appliance as a chat participant, which minted a stub of its own; the
    // user merged that stub into her card.
    const card = vcard('2125550118', 'Ada Quill', {
      Emails: ['ada@quill-legal.example'],
      Phones: ['(212) 555-0118'],
    });
    const stub: GraphEntityInputDto = {
      key: 'contact:2125550144',
      entityType: 'Person',
      name: 'Ada Q',
      sourceSystem: 'imessage',
      properties: {
        Phones: ['+1 212-555-0144'],
        phone: '2125550144',
        phones: ['2125550144'],
        names: ['Ada Q'],
      },
    };
    let ada: string;
    let adaStub: string;

    beforeAll(async () => {
      const ids = await ingest(card, stub);

      ada = ids.get(card.key)!;
      adaStub = ids.get(stub.key)!;

      await merges.mergePeople(ctx, [adaStub], ada);
    });

    it('holds both numbers once the stub is merged in', async () => {
      expect((await row(ada)).properties).toMatchObject({
        phones: ['2125550118', '2125550144'],
        Phones: ['(212) 555-0118', '+1 212-555-0144'],
        names: ['Ada Quill', 'Ada Q'],
      });
    });

    it('keeps them when the card is imported again — and does not rewrite the row to do it', async () => {
      const before = await row(ada);

      await ingest(card);

      const after = await row(ada);

      expect(after.properties).toEqual(before.properties);
      // Comparing bags called every merge target stale on every import.
      expect(after.ctid).toBe(before.ctid);
    });

    it('merges what a changed card adds into what the merge left', async () => {
      await ingest(
        vcard('2125550118', 'Ada Quill', {
          Emails: ['ada@quill-legal.example'],
          Phones: ['(212) 555-0118', '(212) 555-0199'],
        }),
      );

      expect((await row(ada)).properties).toMatchObject({
        phones: ['2125550118', '2125550144'],
        Phones: ['(212) 555-0118', '+1 212-555-0144', '(212) 555-0199'],
        names: ['Ada Quill', 'Ada Q'],
        Emails: ['ada@quill-legal.example'],
      });
    });

    it('records in the graph delta what the row now holds, not what the card sent', async () => {
      const updates = await q<Array<{ now: Record<string, unknown> }>>(
        `SELECT changed_fields -> 'properties' -> 'new' AS now
           FROM ci.graph_deltas
          WHERE entity_id = $1 AND change_source = 'GraphIngestService.upsertEntities' AND change_type = 'updated'`,
        [ada],
      );

      // One: the unchanged re-import wrote nothing, so it recorded nothing.
      expect(updates).toHaveLength(1);
      expect(updates[0].now.phones).toEqual(['2125550118', '2125550144']);
    });

    it('drops a re-import of the merged-away stub rather than reviving it', async () => {
      const before = await row(ada);
      const ids = await ingest({ ...stub, properties: { ...stub.properties, names: ['Ada Q', 'A. Quill'] } });

      // The key resolves THROUGH the tombstone to the survivor…
      expect(ids.get(stub.key)).toBe(ada);
      // …and neither row is written (entity-merge.md §2.1a).
      expect((await row(ada)).ctid).toBe(before.ctid);

      const [tombstone] = await q<Array<Record<string, unknown>>>(
        `SELECT is_active, merged_into_entity_id, properties FROM ci.entities WHERE entity_id = $1`,
        [adaStub],
      );

      expect(tombstone).toMatchObject({ is_active: false, merged_into_entity_id: ada });
      expect((tombstone.properties as Record<string, unknown>).names).toEqual(['Ada Q']);
    });
  });

  describe('what other writers put on an imported person', () => {
    const card = vcard('2025550142', 'Dana Marsh', {
      Phones: ['(202) 555-0142'],
      Organizations: ['Marsh & Co'],
      avatar_url: 'https://photos.example/dana-1.jpg',
    });
    let dana: string;

    beforeAll(async () => {
      dana = (await ingest(card)).get(card.key)!;

      // markSelfEntity's statement.
      await q(
        `UPDATE ci.entities
            SET is_self = TRUE,
                properties = COALESCE(properties, '{}'::jsonb) || jsonb_build_object('is_self', TRUE)
          WHERE entity_id = $1`,
        [dana],
      );
      // updatePerson → PersonService.patch: structured names, pronouns, an avatar.
      await q(
        `UPDATE ci.entities
            SET properties = properties || $2::jsonb, first_name = 'Dana', last_name = 'Marsh'
          WHERE entity_id = $1`,
        [
          dana,
          JSON.stringify({
            first_name: 'Dana',
            last_name: 'Marsh',
            pronouns: 'she/her',
            avatar_url: 'https://photos.example/chosen.jpg',
          }),
        ],
      );
      // A planner leaf, as PersonService.patchPropertyLeaves writes one.
      await q(
        `UPDATE ci.entities SET properties = jsonb_set(properties, '{planner}', '{"trust_mode": "ask"}', true)
          WHERE entity_id = $1`,
        [dana],
      );
      // A description, as a merge's fallback or a person edit writes one.
      await q(`UPDATE ci.entities SET description = 'Met at the harbor conference' WHERE entity_id = $1`, [
        dana,
      ]);
    });

    it('keeps all of it through a re-import that changes something of its own', async () => {
      await ingest(
        vcard('2025550142', 'Dana Marsh', {
          Phones: ['(202) 555-0142'],
          Organizations: ['Harbor Trust'],
        }),
      );

      const now = await row(dana);

      // The importer sends no description; that is not a request to erase one.
      expect(now.description).toBe('Met at the harbor conference');
      expect(now.properties).toMatchObject({
        is_self: true,
        first_name: 'Dana',
        last_name: 'Marsh',
        pronouns: 'she/her',
        planner: { trust_mode: 'ask' },
        // The card stopped sending its photo: absent is not a deletion either.
        avatar_url: 'https://photos.example/chosen.jpg',
        // Declared accumulating, so the second export ADDS its employer.
        Organizations: ['Marsh & Co', 'Harbor Trust'],
      });
    });

    it('still gives the card its latest word on a key the card itself sends', async () => {
      // No per-key provenance yet (entity-merge.md §5.1), so a card that sends
      // a photo wins over the one chosen in the editor. Pinned so a change to
      // that rule is a decision, not an accident.
      await ingest(
        vcard('2025550142', 'Dana Marsh', {
          Phones: ['(202) 555-0142'],
          avatar_url: 'https://photos.example/dana-2.jpg',
        }),
      );

      expect((await row(dana)).properties).toMatchObject({
        avatar_url: 'https://photos.example/dana-2.jpg',
        first_name: 'Dana',
        is_self: true,
      });
    });
  });

  describe('what a person set by hand in Edit Person', () => {
    const card = (extra: Record<string, unknown> = {}) =>
      vcard('2125550177', 'Ola Brandt', {
        Phones: ['(212) 555-0177'],
        nickname: 'Oli',
        website: 'https://ola.example',
        ...extra,
      });
    let ola: string;
    let people: PersonService;

    beforeAll(async () => {
      ola = (await ingest(card())).get(card().key)!;
      people = new PersonService(runner.manager.getRepository(PersonEntity), logger(), {
        send: jest.fn(),
      } as never);

      // The form sends every field back: job_title is unchanged (absent, sent
      // empty), so it is not claimed; the nickname is changed and the website
      // cleared, and both are.
      await people.patch(
        ctx,
        ola,
        {
          name: 'Ola B. Brandt',
          propertiesPatch: { nickname: 'Olly', website: null, job_title: null },
        },
        { handEdit: true },
      );
    });

    it('lists the keys the edit changed or cleared, not the ones it sent back unchanged', async () => {
      expect((await row(ola)).properties.user_edited_keys).toEqual(['name', 'nickname', 'website']);
    });

    it('keeps them, and the hand-set name, through a re-import of the same card', async () => {
      await ingest(card({ job_title: 'Pilot', Phones: ['(212) 555-0178'] }));

      const now = await row(ola);

      expect(now.name).toBe('Ola B. Brandt');
      expect(now.properties).toMatchObject({
        nickname: 'Olly',
        website: null,
        // Not set by hand, so still the card's latest word.
        job_title: 'Pilot',
        // A set key only grows, hand edit or not.
        Phones: ['(212) 555-0177', '(212) 555-0178'],
        user_edited_keys: ['name', 'nickname', 'website'],
      });
    });

    it('keeps them through a sync that writes the whole bag back (PersonService.update)', async () => {
      const current = (await row(ola)).properties;

      await people.update(ctx, ola, {
        name: 'Ola Brandt',
        properties: { ...current, nickname: 'From a sync', job_title: 'Navigator' },
      });

      const now = await row(ola);

      expect(now.name).toBe('Ola B. Brandt');
      expect(now.properties).toMatchObject({ nickname: 'Olly', job_title: 'Navigator' });
      expect(now.properties.user_edited_keys).toEqual(['name', 'nickname', 'website']);
    });
  });

  describe('a null name says nothing', () => {
    it('keeps the name a merge supplied to a row its source could not name', async () => {
      // A contact list row with an unusable name and no handle reaches the
      // graph nameless (toGraphEntity). Merging a named duplicate into it
      // gives it that name — which its next import used to blank again.
      const nameless: GraphEntityInputDto = {
        key: 'contact:missed call from',
        entityType: 'Person',
        name: null,
        sourceSystem: 'contactlist',
        properties: { Source: 'Contact list' },
      };
      const named = vcard('3035550163', 'Eli Stone');
      const ids = await ingest(nameless, named);
      const target = ids.get(nameless.key)!;

      await merges.mergePeople(ctx, [ids.get(named.key)!], target);
      await ingest({ ...nameless, properties: { Source: 'Contact list', File: 'contacts-2.csv' } });

      expect(await row(target)).toMatchObject({
        name: 'Eli Stone',
        properties: { Source: 'Contact list', File: 'contacts-2.csv', phones: ['3035550163'] },
      });
    });
  });

  describe('the keys a parser declared as accumulating', () => {
    function dish(orders: Array<Record<string, unknown>>, tags: string[]): GraphEntityInputDto {
      return {
        key: 'food:croissant',
        entityType: 'Concept',
        name: 'Croissant',
        sourceSystem: 'uber',
        properties: { Orders: orders, Tags: tags },
        accumulate: ['Orders'],
      };
    }

    it('unions a later export’s values into an earlier one’s, and replaces an undeclared array', async () => {
      const croissant = (await ingest(dish([{ date: '2022-12-16', price: 4.5 }], ['breakfast']))).get(
        'food:croissant',
      )!;

      // A later export covering a later window: its order is added to the
      // first export's, not swapped for it.
      await ingest(dish([{ date: '2022-12-17', price: 4.75 }], ['pastry']));

      const expected = {
        Orders: [
          { date: '2022-12-16', price: 4.5 },
          { date: '2022-12-17', price: 4.75 },
        ],
        Tags: ['pastry'],
      };
      const grown = await row(croissant);

      expect(grown.properties).toEqual(expected);

      // The first window exported again, its keys in another order: already
      // held, so nothing is added and the row is not rewritten.
      await ingest(dish([{ price: 4.5, date: '2022-12-16' }], ['pastry']));

      expect(await row(croissant)).toEqual({ ...grown, properties: expected });
    });
  });

  describe('the SQL merge and its TS definition', () => {
    const cases: Array<[string, unknown, unknown, string[] | undefined]> = [
      [
        'keeps keys the source does not send',
        { is_self: true, first_name: 'Ada' },
        { Source: 'vCard' },
        undefined,
      ],
      ['takes a scalar the source sends', { Source: 'vCard' }, { Source: 'vCard 4', n: 2 }, undefined],
      ['skips JSON null', { avatar_url: 'a', phones: ['1'] }, { avatar_url: null, phones: null }, undefined],
      ['unions an identity list in order', { phones: ['1', '2'] }, { phones: ['3', '1', '3'] }, undefined],
      ['cannot remove a member', { phones: ['1', '2'] }, { phones: ['2'] }, undefined],
      [
        'reads a lone value as a list',
        { Phones: '(212) 555-0110' },
        { Phones: ['(212) 555-0110', 'x'] },
        undefined,
      ],
      ['wraps a lone incoming value', { phones: ['1'] }, { phones: '2' }, undefined],
      ['drops null and empty members', { phones: ['1', ''] }, { phones: [null, '', '2', ' '] }, undefined],
      ['keeps falsy members that are values', { Counts: [0] }, { Counts: [false, 0, 1] }, ['Counts']],
      ['writes an empty list for an empty set', {}, { phones: [] }, undefined],
      [
        'compares objects by content and strings apart from numbers',
        { Orders: [{ price: 4.5, date: 'd1' }], prices: ['10.19', 3] },
        { Orders: [{ date: 'd1', price: 4.5 }, { nested: { b: 1, a: [2, 1] } }], prices: [10.19, '3', 3] },
        ['Orders', 'prices'],
      ],
      [
        'replaces an undeclared array',
        { coords: [1, 2], URLs: ['a'] },
        { coords: [3, 4], URLs: ['b'] },
        ['URLs'],
      ],
      [
        'replaces an object-valued scalar whole',
        { planner: { a: 1, b: 2 } },
        { planner: { a: 3 } },
        undefined,
      ],
      ['treats a non-object stored bag as empty', ['x'], { a: 1 }, undefined],
      ['treats a non-object incoming bag as empty', { a: 1 }, ['y'], undefined],
      ['treats SQL NULL as empty', null, { a: 1 }, undefined],
      ['treats JSON null as empty', 'json-null', { a: 1 }, undefined],
      ['keeps unicode as it is', { names: ['Zoë Ångström'] }, { names: ['Zoë Ångström', '李雷'] }, undefined],
      [
        'keeps a hand-set value and a hand clear, still unions a set key',
        {
          nickname: 'Olly',
          website: null,
          phones: ['1'],
          user_edited_keys: ['nickname', 'website', 'phones'],
        },
        { nickname: 'Oli', website: 'https://ola.example', job_title: 'Pilot', phones: ['2'] },
        undefined,
      ],
      [
        'never takes the hand-set list from a source',
        { user_edited_keys: ['nickname'] },
        { user_edited_keys: [], nickname: 'Oli' },
        undefined,
      ],
      [
        'ignores a hand-set list that is not a list',
        { user_edited_keys: 'nickname' },
        { nickname: 'Oli' },
        undefined,
      ],
      [
        'ignores non-string members of the hand-set list',
        { user_edited_keys: [1, null] },
        { a: 1 },
        undefined,
      ],
    ];

    it.each(cases)('agree: %s', async (_label, stored, incoming, accumulate) => {
      const keys = unionKeysFor(accumulate);
      // `null` binds SQL NULL; the 'json-null' marker binds the jsonb value null.
      const bound = stored === null ? null : JSON.stringify(stored === 'json-null' ? null : stored);
      const [{ merged }] = await q<Array<{ merged: unknown }>>(
        `SELECT ${mergedPropertiesSql('$1::jsonb', '$2::jsonb', '$3::text[]')} AS merged`,
        [bound, JSON.stringify(incoming), keys],
      );

      expect(merged).toEqual(
        mergeIngestedProperties(
          (stored === 'json-null' ? null : stored) as Record<string, unknown> | null,
          incoming as Record<string, unknown> | null,
          keys,
        ),
      );
    });
  });
});

describeWithDb(`a merge that commits while the import waits (${availability.target})`, () => {
  // Committed rows over separate connections — the one thing a single
  // rolled-back transaction cannot show. Everything made here is deleted in
  // afterAll.
  let dataSource: DataSource;
  let userId: string;
  let graph: GraphIngestService;

  beforeAll(async () => {
    dataSource = connect(4);
    await dataSource.initialize();

    userId = await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params),
      'PropertyMergeRace',
    );
    graph = new GraphIngestService(
      dataSource.getRepository(NodeEntity),
      dataSource.getRepository(RelationshipEntity),
      new EntityIdentifierService(dataSource.getRepository(EntityIdentifierEntity), logger()),
      logger(),
      { record: jest.fn(), recordMany: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (userId != null) {
        await dataSource.query(`DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1`, [userId]);
        await dataSource.query(`DELETE FROM ci.entities WHERE owner_user_id = $1`, [userId]);
        await dataSource.query(`DELETE FROM ci.users WHERE id = $1`, [userId]);
      }

      await dataSource.destroy();
    }
  });

  /**
   * Until a backend is blocked BY THE MERGE's backend — the upsert, queued on
   * its row lock. Asked of `pg_blocking_pids` rather than "anyone waiting on a
   * lock", which another suite sharing the database could satisfy.
   */
  async function untilBlockedBy(mergerPid: number): Promise<void> {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const [{ waiting }] = await dataSource.query<Array<{ waiting: number }>>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
        [mergerPid],
      );

      if (waiting > 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error('the upsert never waited on the merge’s row lock');
  }

  it('merges into the row as the merge committed it, not as the import read it', async () => {
    const ctx = { userId } as never;
    const card = vcard('3125550160', 'Fay Oduya', { Phones: ['(312) 555-0160'] });
    const first = await graph.ingest(ctx, { entities: [card], relationships: [] });
    const fay = first.entities[0].entityId;

    const merger = dataSource.createQueryRunner();
    await merger.connect();
    const [{ pid: mergerPid }] = (await merger.query(`SELECT pg_backend_pid() AS pid`)) as Array<{
      pid: number;
    }>;
    await merger.startTransaction();

    try {
      // A merge's fold, holding the row: a duplicate's number arriving.
      await merger.query(
        `UPDATE ci.entities
            SET properties = properties || '{"phones": ["3125550160", "3125550177"]}'::jsonb
          WHERE entity_id = $1`,
        [fay],
      );

      // The card is imported again meanwhile, with a number of its own. It
      // reads the row as it stood BEFORE the merge, decides it has something
      // to add, and its upsert queues behind the merge's row lock.
      const reimport = graph.ingest(ctx, {
        entities: [vcard('3125550160', 'Fay Oduya', { Phones: ['(312) 555-0160', '(312) 555-0188'] })],
        relationships: [],
      });

      await untilBlockedBy(mergerPid);
      await merger.commitTransaction();

      expect((await reimport).errors).toEqual([]);
    } finally {
      if (merger.isTransactionActive) {
        await merger.rollbackTransaction();
      }

      await merger.release();
    }

    const [after] = await dataSource.query<Array<{ properties: Record<string, unknown> }>>(
      `SELECT properties FROM ci.entities WHERE entity_id = $1`,
      [fay],
    );

    // Replacing — or merging what the import READ — would have lost 3125550177.
    expect(after.properties.phones).toEqual(['3125550160', '3125550177']);
    expect(after.properties.Phones).toEqual(['(312) 555-0160', '(312) 555-0188']);
  });
});

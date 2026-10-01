import { DataSource } from 'typeorm';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { HBPE_LINKS } from '../purgeTeardown';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PURGES KNOW EVERY TABLE THAT CAN STOP A NODE BEING DELETED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deleting an event or a content item cascades from its `ci.entities` row to its
 * detail row (`ci.events`, `ci.content`). A table that references the detail row
 * with no `ON DELETE` action makes that delete fail for every row it has a row
 * for, which is how `archive_and_delete` came to fail for the 98% of events HBPE
 * had clustered, and then for every clustered content item. `clearHbpeLinks`
 * clears each such table first, and builds its statements from
 * {@link HBPE_LINKS}, so a table that is listed IS cleared.
 *
 * Nothing but the live catalog says which tables those are, and a migration that
 * adds a new one has no reason to look in `purgeTeardown.ts`. So this compares the
 * two. A table in the catalog and not in the list is a delete that fails on a real
 * appliance the first time it meets a row in it. A table in the list and not in
 * the catalog is a delete that has been dead code since the constraint changed.
 *
 * Items and communications have no purge of their own. They go through the generic
 * node delete, which fails the same way on the same kind of table, so the guard
 * covers their detail tables too and names, one by one, what it has accepted: the
 * only foreign keys that refuse such a delete today.
 *
 * The same goes for `ci.entities` itself. A foreign key onto the base row with no
 * `ON DELETE` action refuses the delete of every node it holds, whatever its type,
 * and the tables that have one hold other kinds of node.
 *
 * What it does not see: a column that holds a node's id and has no foreign key. A
 * purge does not fail on those, it leaves them pointing at nothing. They are the
 * `deleteBareReferences` list, which has no catalog to be held against.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/purgeTeardown.catalog] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** The detail tables a purge, or the generic delete of the node they belong to, cascades into. */
const DETAIL_TABLES = ['ci.events', 'ci.content', 'ci.objects', 'ci.communications'];

/**
 * Foreign keys onto a detail table that no purge clears, and why that is right. Each is named
 * exactly: a second foreign key from the same table is a new decision, not this one.
 */
const ACCEPTED_ON_DETAIL_TABLES: Record<string, string> = {
  'ci.objects <- ci.objects.parent_object_id':
    'An item that is another item’s parent is refused, as it is by `ItemService.remove`. The tool reports it as CONSTRAINT_VIOLATION, and the delete changes nothing.',
};

/**
 * Foreign keys onto `ci.entities` with no `ON DELETE` action, and which kind of node each can hold.
 * None can hold an event, a content item, an item or a communication.
 */
const ACCEPTED_ON_ENTITIES: Record<string, string> = {
  'ci.entities <- ci.users.entity_id': 'the user’s own Person node',
  'ci.entities <- ci.product_models.product_entity_id': 'a catalog model’s Product node',
};

/** A foreign key as the catalog names it: what it references, from where, and from which column. */
const keyOf = (referenced: string, referencing: string, column: string): string =>
  `${referenced} <- ${referencing}.${column}`;

/**
 * What is wrong, if anything, between the foreign keys the catalog has and what the purges know.
 * Every list is empty when they agree.
 */
function compareWithCatalog(catalog: string[], cleared: string[], accepted: string[]) {
  return {
    // Add each of these to HBPE_LINKS, and it is cleared; or, if it is right that it refuses, to the
    // accepted list here, with the reason.
    blockingAndNotHandled: catalog.filter((key) => !cleared.includes(key) && !accepted.includes(key)).sort(),
    // The constraint has changed: remove the entry from HBPE_LINKS.
    clearedAndNoLongerBlocking: cleared.filter((key) => !catalog.includes(key)).sort(),
    // The constraint has changed: remove the entry from the accepted list here.
    acceptedAndNoLongerBlocking: accepted.filter((key) => !catalog.includes(key)).sort(),
  };
}

const NOTHING_WRONG = {
  blockingAndNotHandled: [],
  clearedAndNoLongerBlocking: [],
  acceptedAndNoLongerBlocking: [],
};

describe('comparing the purges with the catalog', () => {
  const cleared = HBPE_LINKS.map((link) => keyOf(link.references, link.table, link.column));
  const catalog = [...cleared, ...Object.keys(ACCEPTED_ON_DETAIL_TABLES)];

  it('is quiet when every foreign key is cleared or accepted', () => {
    expect(compareWithCatalog(catalog, cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES))).toEqual(
      NOTHING_WRONG,
    );
  });

  it('names a new foreign key onto ci.content that nothing clears', () => {
    const added = keyOf('ci.content', 'hbpe.some_new_table', 'content_id');

    expect(compareWithCatalog([...catalog, added], cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES))).toEqual({
      ...NOTHING_WRONG,
      blockingAndNotHandled: [added],
    });
  });

  it('does not take a table cleared for one parent as cleared for another', () => {
    // `hbpe.content_context` is cleared for content. The same table referencing events is a new
    // foreign key, and the purge of an event does not clear it.
    const added = keyOf('ci.events', 'hbpe.content_context', 'content_id');

    expect(compareWithCatalog([...catalog, added], cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES))).toEqual({
      ...NOTHING_WRONG,
      blockingAndNotHandled: [added],
    });
  });

  it('names a second foreign key from a table that has an accepted one', () => {
    const added = keyOf('ci.objects', 'ci.objects', 'merged_into_object_id');

    expect(compareWithCatalog([...catalog, added], cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES))).toEqual({
      ...NOTHING_WRONG,
      blockingAndNotHandled: [added],
    });
  });

  it('names a cleared table whose constraint has gone', () => {
    const [gone, ...stillThere] = cleared;

    expect(compareWithCatalog(stillThere, cleared, [])).toEqual({
      ...NOTHING_WRONG,
      clearedAndNoLongerBlocking: [gone],
    });
  });

  it('names an accepted foreign key that has gone', () => {
    expect(compareWithCatalog(cleared, cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES))).toEqual({
      ...NOTHING_WRONG,
      acceptedAndNoLongerBlocking: Object.keys(ACCEPTED_ON_DETAIL_TABLES),
    });
  });
});

describeWithDb(`the tables that can block a node delete (${availability.target})`, () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      synchronize: false,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /** Every foreign key onto these tables that has no `ON DELETE` action, as `referenced <- table.column`. */
  async function blockersOnto(tables: string[]): Promise<string[]> {
    const rows: Array<{ referenced: string; referencing: string; column: string }> = await dataSource.query(
      `SELECT c.confrelid::regclass::text AS referenced,
              c.conrelid::regclass::text AS referencing,
              (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k (attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "column"
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = ANY ($1::text[]::regclass[])
          AND c.confdeltype IN ('a', 'r')
        ORDER BY 1, 2, 3`,
      [tables],
    );

    return rows.map((row) => keyOf(row.referenced, row.referencing, row.column));
  }

  it('onto an event, content, an item or a communication are exactly the ones the purges clear or accept', async () => {
    const cleared = HBPE_LINKS.map((link) => keyOf(link.references, link.table, link.column));

    // Precondition: the catalog has the tables this is about. A guard that read nothing would pass.
    expect(cleared.length).toBeGreaterThan(0);

    expect(
      compareWithCatalog(await blockersOnto(DETAIL_TABLES), cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES)),
    ).toEqual(NOTHING_WRONG);
  });

  it('onto ci.entities are exactly the ones that hold other kinds of node', async () => {
    const accepted = Object.keys(ACCEPTED_ON_ENTITIES);

    expect(compareWithCatalog(await blockersOnto(['ci.entities']), [], accepted)).toEqual(NOTHING_WRONG);
  });
});

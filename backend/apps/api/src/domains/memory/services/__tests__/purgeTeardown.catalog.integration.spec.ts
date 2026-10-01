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
 * Items and communications have purges of their own (`ItemService.purge`,
 * `CommunicationService.purge`), and the same hazard: a foreign key onto
 * `ci.objects` or `ci.communications` with no `ON DELETE` action refuses the delete
 * of every row it holds. So the guard covers their detail tables too, and names,
 * one by one, what it has accepted: the only foreign keys that refuse such a delete
 * today. A key that is `ON DELETE SET NULL` never refuses, so it is not seen here:
 * what each of those does to an item is decided, and tested, in `itemPurge.ts`.
 *
 * The same goes for `ci.entities` itself. A foreign key onto the base row with no
 * `ON DELETE` action refuses the delete of every node it holds, whatever its type,
 * and the tables that have one hold other kinds of node.
 *
 * A person, a place and a concept ARE `ci.entities` rows, with no detail table behind
 * them, so the keys onto `ci.entities` are the whole of what the schema decides about
 * what points at one. `PersonService.purge`, `PlaceService.purge` and
 * `ConceptService.purge` lean on all three kinds of key, so all three are named here:
 * the ones that refuse (the user's own Person, which the purge keeps refusing), the
 * ones that set themselves to NULL (an event's place, a receipt's merchant, a place's
 * children: each decided, below, as either "the record stays" or "the purge handles
 * it"), and the ones that cascade (the detail rows of an event, a message, content and
 * an item, and the retype proposals about a node). A new key of any of the three kinds
 * is a decision somebody has to make about people, places and concepts, and it fails
 * here by name until they have.
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

/**
 * The tables a purge, or the generic delete of the node they belong to, deletes a row from, and that a
 * foreign key could stop it deleting.
 *
 * `ci.files` is the odd one out: it is not the detail table of a node, because a `File` node is joined to
 * its row by a plain `linked_id` column and deleting the node never cascades into it. It is here because
 * `FileService.purge` deletes the row, so a foreign key onto it with no `ON DELETE` action would refuse that
 * delete after the stored objects had already gone: the worst place for a delete to fail.
 */
const DETAIL_TABLES = ['ci.events', 'ci.content', 'ci.objects', 'ci.communications', 'ci.files'];

/**
 * Foreign keys onto a detail table that no purge clears, and why that is right. Each is named
 * exactly: a second foreign key from the same table is a new decision, not this one.
 */
const ACCEPTED_ON_DETAIL_TABLES: Record<string, string> = {
  'ci.objects <- ci.objects.parent_object_id':
    'A DECISION, not an oversight: the purge refuses an item that is another item’s parent when a child would be left behind, as `ItemService.remove` does, and was told to. The tool reports CONSTRAINT_VIOLATION and nothing changes, and naming the parts in the same call is what lets the kit go. Detaching the parts instead would make this key one the purge clears, not one it accepts.',
};

/**
 * Foreign keys onto `ci.entities` with no `ON DELETE` action, and which kind of node each can hold.
 * None can hold an event, a content item, an item or a communication.
 */
const ACCEPTED_ON_ENTITIES: Record<string, string> = {
  'ci.entities <- ci.users.entity_id':
    'the user’s own Person node. `PersonService.purge` keeps refusing it: the database raises this key, the transaction rolls back, and the tool reports a CONSTRAINT_VIOLATION that retrying will not change (PersonService.purge.integration.test.ts pins it)',
  'ci.entities <- ci.product_models.product_entity_id':
    'a catalog model’s Product node, which none of the purges takes',
};

/**
 * Foreign keys onto `ci.entities` that set themselves to NULL when the node goes, and what each means for a
 * person, a place or a concept that is purged. The schema has already decided every one: a purge that leaves
 * the key alone is deciding the same thing, so each says which.
 */
const DECIDED_SET_NULL_ON_ENTITIES: Record<string, string> = {
  'ci.entities <- ci.entities.merged_into_entity_id':
    'HANDLED. A merge tombstone points at its survivor, and deleting the survivor would turn each tombstone into an archived node with the name, emails and numbers it had. The purge takes the survivor’s tombstones with it, in the same transaction.',
  'ci.entities <- ci.entities.parent_place_id':
    'HANDLED. Nulling a child’s parent can collide with entities_admin_place_uniq and make the place undeletable, so the purge grafts the children onto the nearest ancestor that stays, as PlaceService.remove does.',
  'ci.entities <- ci.events.location_entity_id':
    'THE RECORD STAYS. The event is its own record, and the place is derived from its coordinates and name, which a purge does not touch.',
  'ci.entities <- ci.object_observations.place_entity_id': 'THE RECORD STAYS. A sighting is its own record.',
  'ci.entities <- ci.objects.acquired_from_entity_id': 'THE RECORD STAYS. An item is its own record.',
  'ci.entities <- ci.objects.last_seen_place_entity_id': 'THE RECORD STAYS. An item is its own record.',
  // `position` is a reserved word, so the catalog spells it quoted.
  'ci.entities <- ci."position".location_entity_id': 'THE RECORD STAYS. A position fix is its own record.',
  'ci.entities <- ci."position".reference_entity_id': 'THE RECORD STAYS. A position fix is its own record.',
  'ci.entities <- ci.receipts.merchant_entity_id': 'THE RECORD STAYS. A receipt is its own record.',
  'ci.entities <- ci.receipts.place_entity_id': 'THE RECORD STAYS. A receipt is its own record.',
};

/**
 * Foreign keys onto `ci.entities` that CASCADE, and why deleting a node should take the row with it. A new one
 * would delete user data whenever any node is deleted, so it is named before it can.
 */
const CASCADES_FROM_ENTITIES: Record<string, string> = {
  'ci.entities <- ci.communications.id, entity_type': 'the detail row of a Communication node',
  'ci.entities <- ci.content.id, entity_type': 'the detail row of a Content node',
  'ci.entities <- ci.events.event_id, entity_type': 'the detail row of an Event node',
  'ci.entities <- ci.objects.object_id, entity_type': 'the detail row of an Item node',
  'ci.entities <- ci.entity_type_proposals.entity_id':
    'a proposal to retype a node means nothing once the node is gone',
};

/**
 * Every foreign key onto `ci.files`, and what it does when the file goes, which is what `FileService.purge`
 * relies on or accepts. None of them refuses the delete, so `ACCEPTED_ON_DETAIL_TABLES` never sees them;
 * they are pinned here instead, so that a new one, or one whose action changes, is a decision somebody takes
 * and not a surprise in a delete on a real appliance. A new table that cascades from `ci.files` would have
 * the purge delete its rows silently, and one that sets null would have it rewrite them.
 */
const FILE_FOREIGN_KEYS: Record<string, { action: string; reason: string }> = {
  'ci.files <- ci.file_chunks.file_id': {
    action: 'CASCADE',
    reason:
      'the text extracted from the file, and its chunks. Relied on: the purge deletes nothing of them itself, and they are the file’s content, so they must go with it.',
  },
  'ci.files <- ci.files.parent_id': {
    action: 'CASCADE',
    reason:
      'the variants of a file (previews, thumbnails, playback copies). Relied on, but the purge also walks and locks them itself to reach their objects, which a cascade cannot do.',
  },
  'ci.files <- ci.message_files.file_id': {
    action: 'CASCADE',
    reason:
      'a chat message’s attachment link. Relied on: the message keeps its text and loses the attachment, which is what forgetting the file means for it.',
  },
  'ci.files <- ci.unfurls.poster_file_id': {
    action: 'SET NULL',
    reason:
      'a link preview’s poster image. Accepted: the preview is its own record and stays, without its poster.',
  },
};

/** What `pg_constraint.confdeltype` calls each action. */
const DELETE_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/**
 * What is wrong, if anything, between the foreign keys the catalog has onto a table and the ones that were
 * decided. Every list is empty when they agree.
 */
function compareActions(catalog: Record<string, string>, decided: Record<string, string>) {
  return {
    // A new foreign key. Decide what forgetting a file does to it, and pin it.
    addedAndNotDecided: Object.keys(catalog)
      .filter((key) => !(key in decided))
      .sort(),
    // The constraint has gone: remove the entry.
    decidedAndGone: Object.keys(decided)
      .filter((key) => !(key in catalog))
      .sort(),
    // The action changed under a decision that was taken about the old one.
    actionChanged: Object.keys(decided)
      .filter((key) => key in catalog && catalog[key] !== decided[key])
      .sort()
      .map((key) => `${key}: decided ${decided[key]}, now ${catalog[key]}`),
  };
}

const NO_ACTION_DRIFT = { addedAndNotDecided: [], decidedAndGone: [], actionChanged: [] };

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

  it('names a new foreign key onto ci.entities that sets itself to NULL and nobody has decided', () => {
    const added = keyOf('ci.entities', 'ci.some_new_table', 'place_entity_id');
    const decided = Object.keys(DECIDED_SET_NULL_ON_ENTITIES);

    expect(compareWithCatalog([...decided, added], [], decided)).toEqual({
      ...NOTHING_WRONG,
      blockingAndNotHandled: [added],
    });
  });

  it('gives every decision a reason that says whether the purge handles it or the record stays', () => {
    for (const [key, reason] of Object.entries(DECIDED_SET_NULL_ON_ENTITIES)) {
      expect({ key, decided: /^(HANDLED|THE RECORD STAYS)\./.test(reason) }).toEqual({ key, decided: true });
    }
  });

  it('names an accepted foreign key that has gone', () => {
    expect(compareWithCatalog(cleared, cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES))).toEqual({
      ...NOTHING_WRONG,
      acceptedAndNoLongerBlocking: Object.keys(ACCEPTED_ON_DETAIL_TABLES),
    });
  });
});

/** What was decided for each foreign key onto `ci.files`, without the reasons. */
const DECIDED_FILE_ACTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(FILE_FOREIGN_KEYS).map(([key, { action }]) => [key, action]),
);

describe('comparing the file foreign keys with the catalog', () => {
  it('guards ci.files like every other table a purge deletes from', () => {
    // A foreign key onto it with no `ON DELETE` action refuses the file purge's last delete, after the objects
    // are gone. Without the table in the list the live comparison below never looks at it.
    expect(DETAIL_TABLES).toContain('ci.files');
  });

  it('is quiet when the catalog is what was decided', () => {
    expect(compareActions(DECIDED_FILE_ACTIONS, DECIDED_FILE_ACTIONS)).toEqual(NO_ACTION_DRIFT);
  });

  it('names a new foreign key onto ci.files that nobody has decided on', () => {
    const added = keyOf('ci.files', 'ci.some_new_table', 'file_id');

    expect(compareActions({ ...DECIDED_FILE_ACTIONS, [added]: 'CASCADE' }, DECIDED_FILE_ACTIONS)).toEqual({
      ...NO_ACTION_DRIFT,
      addedAndNotDecided: [added],
    });
  });

  it('names a decided foreign key that has gone', () => {
    const [gone, ...stillThere] = Object.keys(DECIDED_FILE_ACTIONS);
    const catalog = Object.fromEntries(stillThere.map((key) => [key, DECIDED_FILE_ACTIONS[key]]));

    expect(compareActions(catalog, DECIDED_FILE_ACTIONS)).toEqual({
      ...NO_ACTION_DRIFT,
      decidedAndGone: [gone],
    });
  });

  it('names a foreign key whose action changed under the decision that was taken about it', () => {
    const key = 'ci.files <- ci.file_chunks.file_id';

    expect(compareActions({ ...DECIDED_FILE_ACTIONS, [key]: 'NO ACTION' }, DECIDED_FILE_ACTIONS)).toEqual({
      ...NO_ACTION_DRIFT,
      actionChanged: [`${key}: decided CASCADE, now NO ACTION`],
    });
  });

  it('gives a reason for every decision, so that a later reader knows what it was', () => {
    for (const [key, { reason }] of Object.entries(FILE_FOREIGN_KEYS)) {
      expect({ key, reason: reason.length > 20 }).toEqual({ key, reason: true });
    }
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

  /**
   * Every foreign key onto these tables whose `ON DELETE` action is one of `actions` (pg_constraint's letters:
   * `a` no action, `r` restrict, `n` set null, `c` cascade), as `referenced <- table.column`. The no-action and
   * restrict keys are the ones that refuse a delete, which is what a purge has to clear or accept.
   */
  async function keysOnto(tables: string[], actions: string[] = ['a', 'r']): Promise<string[]> {
    const rows: Array<{ referenced: string; referencing: string; column: string }> = await dataSource.query(
      `SELECT c.confrelid::regclass::text AS referenced,
              c.conrelid::regclass::text AS referencing,
              (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k (attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "column"
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = ANY ($1::text[]::regclass[])
          AND c.confdeltype = ANY ($2::"char"[])
          -- A hypertable's chunks carry a copy of its keys, and only once it has data in them: the table is
          -- the key, not the chunk, or the guard would change with the rows the database happens to hold.
          AND NOT EXISTS (
            SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
             WHERE r.oid = c.conrelid AND n.nspname = '_timescaledb_internal')
        ORDER BY 1, 2, 3`,
      [tables, actions],
    );

    return rows.map((row) => keyOf(row.referenced, row.referencing, row.column));
  }

  /** Every foreign key onto `table`, whatever it does on delete, as `referenced <- table.column` and the action. */
  async function foreignKeysOnto(table: string): Promise<Record<string, string>> {
    const rows: Array<{ referenced: string; referencing: string; column: string; action: string }> =
      await dataSource.query(
        `SELECT c.confrelid::regclass::text AS referenced,
                c.conrelid::regclass::text AS referencing,
                (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                   FROM unnest(c.conkey) WITH ORDINALITY AS k (attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "column",
                c.confdeltype::text AS action
           FROM pg_constraint c
          WHERE c.contype = 'f'
            AND c.confrelid = $1::text::regclass
          ORDER BY 1, 2, 3`,
        [table],
      );

    return Object.fromEntries(
      rows.map((row) => [
        keyOf(row.referenced, row.referencing, row.column),
        DELETE_ACTIONS[row.action] ?? row.action,
      ]),
    );
  }

  it('onto ci.files are exactly the ones whose action the file purge relies on or accepts', async () => {
    const catalog = await foreignKeysOnto('ci.files');

    // Precondition: the catalog has the table this is about. A guard that read nothing would pass.
    expect(Object.keys(catalog).length).toBeGreaterThan(0);

    expect(compareActions(catalog, DECIDED_FILE_ACTIONS)).toEqual(NO_ACTION_DRIFT);
  });

  it('onto an event, content, an item, a communication or a stored file are exactly the ones the purges clear or accept', async () => {
    const cleared = HBPE_LINKS.map((link) => keyOf(link.references, link.table, link.column));

    // Precondition: the catalog has the tables this is about. A guard that read nothing would pass.
    expect(cleared.length).toBeGreaterThan(0);

    expect(
      compareWithCatalog(await keysOnto(DETAIL_TABLES), cleared, Object.keys(ACCEPTED_ON_DETAIL_TABLES)),
    ).toEqual(NOTHING_WRONG);
  });

  it('onto ci.entities are exactly the ones that hold other kinds of node', async () => {
    const accepted = Object.keys(ACCEPTED_ON_ENTITIES);

    expect(compareWithCatalog(await keysOnto(['ci.entities']), [], accepted)).toEqual(NOTHING_WRONG);
  });

  it('onto ci.entities that set themselves to NULL are exactly the ones somebody has decided', async () => {
    const decided = Object.keys(DECIDED_SET_NULL_ON_ENTITIES);

    // Precondition: the catalog has some. A guard that read nothing would pass.
    expect((await keysOnto(['ci.entities'], ['n'])).length).toBeGreaterThan(0);
    expect(compareWithCatalog(await keysOnto(['ci.entities'], ['n']), [], decided)).toEqual(NOTHING_WRONG);
  });

  it('onto ci.entities that cascade are exactly the ones somebody has decided', async () => {
    const decided = Object.keys(CASCADES_FROM_ENTITIES);

    expect((await keysOnto(['ci.entities'], ['c'])).length).toBeGreaterThan(0);
    expect(compareWithCatalog(await keysOnto(['ci.entities'], ['c']), [], decided)).toEqual(NOTHING_WRONG);
  });
});

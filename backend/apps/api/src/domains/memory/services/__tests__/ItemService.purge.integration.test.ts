import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { ItemRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { ItemBaseEntity } from '../../entities/ItemBaseEntity';
import { ItemEntity } from '../../entities/ItemEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { ItemService } from '../ItemService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PURGED ITEM LEAVES NOTHING BEHIND. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` deleted an `Item` node by deleting its
 * `ci.entities` row and trusting the foreign keys. Only an item that is another
 * item's parent was refused. Everything else went through and left rows that name
 * the item by id with no foreign key to say so, and turned the rows that name it
 * WITH one into something nobody had decided on: a merge survivor's tombstones
 * came back as archived items, because their pointer is `ON DELETE SET NULL`.
 *
 * `ItemService.purge` is the teardown that replaces it for `memory.forget`. Each
 * case here seeds a doomed item and a CONTROL one with a row in every table the
 * purge is meant to clean, and checks that every one of those rows is gone for the
 * first, and that the second did not move. The footprint is asserted non-zero
 * before the purge, in every table, so the test cannot pass because a fixture
 * quietly wrote nothing.
 *
 * Two decisions were put to the user and are pinned here: an item that is another
 * item's parent is REFUSED, and the duplicates that were merged into an item go
 * WITH it.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ItemService.purge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/**
 * Polls until `probe` finds something. For waiting on Postgres to show a state, where a fixed sleep is
 * either too short under load or a slow test everywhere else.
 */
async function until<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = await probe();

    if (found !== null) {
      return found;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One item, and a sibling that lists it as related. */
interface Aggregate {
  itemId: string;
  /** The serial number the unit was recognised by. */
  serial: string;
}

/** Every place a row can point at an item, with how to count them. A probe takes its id as `$1`. */
const FOOTPRINT: Array<[label: string, sql: string]> = [
  ['ci.entities (Item)', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
  ['ci.objects', `SELECT count(*) FROM ci.objects WHERE object_id = $1`],
  [
    'ci.relationships',
    `SELECT count(*) FROM ci.relationships WHERE from_entity_id = $1 OR to_entity_id = $1`,
  ],
  [
    'ci.graph_deltas (of its edges)',
    `SELECT count(*) FROM ci.graph_deltas
      WHERE node_type = 'relationship' AND (from_entity_id = $1 OR to_entity_id = $1)`,
  ],
  [
    'ci.record_sources',
    `SELECT count(*) FROM ci.record_sources WHERE record_table = 'objects' AND record_id = $1`,
  ],
  [
    'ci.object_identifiers',
    `SELECT count(*) FROM ci.object_identifiers WHERE subject_type = 'object_instance' AND subject_id = $1`,
  ],
  [
    'ci.entity_merges',
    `SELECT count(*) FROM ci.entity_merges WHERE source_entity_id = $1 OR target_entity_id = $1`,
  ],
  [
    'ci.merge_candidates',
    `SELECT count(*) FROM ci.merge_candidates WHERE entity_id_a = $1 OR entity_id_b = $1`,
  ],
  [
    'ci.entity_merge_blocks',
    `SELECT count(*) FROM ci.entity_merge_blocks WHERE entity_id_a = $1 OR entity_id_b = $1`,
  ],
  [
    'ci.objects.related_object_ids (of other items)',
    `SELECT count(*) FROM ci.objects WHERE related_object_ids @> ARRAY[$1]::uuid[]`,
  ],
  ['ci.pipeline_state', `SELECT count(*) FROM ci.pipeline_state WHERE entity_id = $1`],
  ['ci.pipeline_dead_letters', `SELECT count(*) FROM ci.pipeline_dead_letters WHERE entity_id = $1`],
  ['ci.graph_deltas', `SELECT count(*) FROM ci.graph_deltas WHERE entity_id = $1`],
  ['ci_search.entity_tag', `SELECT count(*) FROM ci_search.entity_tag WHERE entity_id = $1`],
  ['ci_search.entity_categories', `SELECT count(*) FROM ci_search.entity_categories WHERE entity_id = $1`],
  ['ci_search.vectors', `SELECT count(*) FROM ci_search.vectors WHERE entity_id = $1`],
  ['ci_search.embeddings', `SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1`],
  ['ci_search.index_skips', `SELECT count(*) FROM ci_search.index_skips WHERE entity_id = $1`],
];

describeWithDb(`ItemService.purge against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let items: ItemService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;

  const published: Array<{ name: string; payload: unknown }> = [];

  /** Every id a case seeded, for the tables that carry no owner to wipe by. */
  let seeded: string[] = [];

  const signalling = {
    send: jest.fn(async (name: string, payload: unknown) => {
      published.push({ name, payload });

      return [];
    }),
  } as unknown as EventService;

  const announced = (): string[] =>
    published
      .filter((event) => event.name === ItemRemovedEvent)
      .map((event) => (event.payload as { itemId: string }).itemId)
      .sort();

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, ItemBaseEntity, ItemEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ItemService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ItemPurge', userId);
    }

    items = new ItemService(
      dataSource.getRepository(ItemEntity),
      dataSource.getRepository(ItemBaseEntity),
      logger(),
      signalling,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [users]);
    await dataSource.query(
      `DELETE FROM ci_search.entity_tag WHERE tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
      [users],
    );
    await dataSource.query(
      `DELETE FROM ci_search.entity_categories WHERE category_tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
      [users],
    );
    await dataSource.query('DELETE FROM ci_search.tags WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.index_skips WHERE entity_id = ANY($1::uuid[])', [seeded]);
    await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [seeded]);
    await dataSource.query('DELETE FROM ci.pipeline_dead_letters WHERE entity_id = ANY($1::uuid[])', [
      seeded,
    ]);
    await dataSource.query('DELETE FROM ci.object_identifiers WHERE owner_user_id = ANY($1::uuid[])', [
      users,
    ]);
    await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.merge_candidates WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entity_merge_blocks WHERE owner_user_id = ANY($1::uuid[])', [
      users,
    ]);
    await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.receipt_line_items WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.receipts WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [users]);
    // Children before parents: `parent_object_id` has no ON DELETE action.
    await dataSource.query(
      'UPDATE ci.objects SET parent_object_id = NULL, merged_into_object_id = NULL WHERE user_id = ANY($1::uuid[])',
      [users],
    );
    await dataSource.query('DELETE FROM ci.objects WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [seeded]);
    seeded = [];
  }

  beforeEach(() => {
    published.length = 0;
  });

  afterEach(wipe);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  async function node(entityType: string, name: string, forUser = ownerId): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [id, entityType, name, forUser],
    );
    seeded.push(id);

    return id;
  }

  /** An edge, and the delta that recorded its creation, which names its two endpoints. */
  async function edge(from: string, to: string, type: string): Promise<void> {
    const [{ relationship_id: relationshipId }] = await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING relationship_id`,
      [from, to, type, ownerId],
    );

    await dataSource.query(
      `INSERT INTO ci.graph_deltas
         (node_type, relationship_id, relationship_type, from_entity_id, to_entity_id, change_type, changed_fields, owner_user_id)
       VALUES ('relationship', $1, $2, $3, $4, 'created', '{}'::jsonb, $5)`,
      [relationshipId, type, from, to, ownerId],
    );
  }

  /**
   * The `ci.entities` base row and `ci.objects` detail row of one item, and nothing else. A tombstone
   * is one that lost a merge: hidden, folded into `mergedInto`, and still carrying the data it had.
   */
  async function bareItem(
    title: string,
    forUser: string,
    extra: { parent?: string; mergedInto?: string; lifecycle?: string; related?: string[] } = {},
  ): Promise<string> {
    const id = uuidv7();
    const tombstone = extra.mergedInto !== undefined;

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.entities
         (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id, is_active, merged_into_entity_id)
       VALUES ($1, 'Item', $2, '{}'::jsonb, $3, 'objects', $1, $4, $5)`,
      [id, title, forUser, !tombstone, extra.mergedInto ?? null],
    );
    await dataSource.query(
      `INSERT INTO ci.objects
         (object_id, user_id, parent_object_id, merged_into_object_id, lifecycle_state, brand, related_object_ids)
       VALUES ($1, $2, $3, $4, $5, 'Bosch', $6)`,
      [
        id,
        forUser,
        extra.parent ?? null,
        extra.mergedInto ?? null,
        extra.lifecycle ?? (tombstone ? 'archived' : 'active'),
        extra.related ?? null,
      ],
    );

    return id;
  }

  /**
   * An item the way the importer writes it, and then everything the appliance hangs off one: edges in
   * both directions, each with its delta, a ledger entry, the serial number it was recognised by, merge
   * bookkeeping, another item that lists it as related, pipeline bookkeeping, a delta that carries the
   * title, tags and categories, and search rows.
   */
  async function kettle(
    title: string,
    forUser = ownerId,
    extra: { mergedInto?: string } = {},
  ): Promise<Aggregate> {
    const itemId = await bareItem(title, forUser, extra);

    // Graph edges, in both directions, each with the delta that recorded it.
    const owner_ = await node('Person', `${title} owner`, forUser);
    const place = await node('Location', `${title} shelf`, forUser);

    await edge(owner_, itemId, 'OWNS');
    await edge(itemId, place, 'STORED_AT');

    // The provenance ledger.
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, 'objects', $2, 'ci.import', 'item_purge_spec', $3)`,
      [forUser, itemId, `objects-${itemId}`],
    );

    // The identifier the unit was recognised by. The unique index is over the identifier, not the subject.
    const serial = `SN-${itemId}`;

    await dataSource.query(
      `INSERT INTO ci.object_identifiers (owner_user_id, subject_type, subject_id, namespace, value_normalized)
       VALUES ($1, 'object_instance', $2, 'serial', $3)`,
      [forUser, itemId, serial],
    );

    // Merge bookkeeping: the audit row of a merge into it, a pending pair, and a "never merge these".
    const gone = uuidv7();
    const other = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
       VALUES ($1, $2, $3, 'ObjectInstance', jsonb_build_object('source', jsonb_build_object('brand', 'Bosch')))`,
      [forUser, gone, itemId],
    );

    // A tombstone also has the audit row of the merge that folded IT away: it is the source, and the row keeps
    // a snapshot of the tombstone's own data. It names the survivor as its target, so a survivor's purge finds
    // it by the survivor, and a purge of the tombstone alone can only find it by the tombstone.
    if (extra.mergedInto !== undefined) {
      await dataSource.query(
        `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
         VALUES ($1, $2, $3, 'ObjectInstance', jsonb_build_object('source', jsonb_build_object('brand', 'Bosch', 'purchase_price', 49.99)))`,
        [forUser, itemId, extra.mergedInto],
      );
    }

    await dataSource.query(
      `INSERT INTO ci.merge_candidates (owner_user_id, entity_type, entity_id_a, entity_id_b, score, detected_by, detector_version)
       VALUES ($1, 'ObjectInstance', LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 0.9, 'item_purge_spec', 1)`,
      [forUser, itemId, other],
    );
    await dataSource.query(
      `INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b)
       VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))`,
      [forUser, itemId, other],
    );

    // Another item that lists it as related, and one more that lists something else too.
    await bareItem(`${title} accessory`, forUser, { related: [itemId, uuidv7()] });

    // Pipeline bookkeeping.
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('item', $1, 'item_purge_spec.stage', 'done', $2)`,
      [itemId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'item.created', 'item', $1, '{}'::jsonb, 'boom', $2)`,
      [itemId, forUser],
    );

    // The graph delta the item's creation would have written, and the title in it.
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Item', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [itemId, title, forUser],
    );

    // Tags and categories, which live in the search schema and have no foreign key to the item.
    const [{ id: tag }] = await dataSource.query(
      `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`item-purge-spec-${itemId}`, forUser],
    );

    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('item', $1, $2)`,
      [itemId, tag],
    );
    await dataSource.query(
      `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
       VALUES ('item', $1, $2, 0)`,
      [itemId, tag],
    );
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'item', $1, to_tsvector('simple', $2), $3)`,
      [itemId, title, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'item', $1, $2)`,
      [itemId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('item', $1, 'item_purge_spec')`,
      [itemId],
    );

    return { itemId, serial };
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  async function footprint(aggregate: Aggregate): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [label, sql] of FOOTPRINT) {
      const [{ count }] = await dataSource.query(sql, [aggregate.itemId]);

      counts[label] = Number(count);
    }

    return counts;
  }

  /** What `footprint` reads when every row is gone. */
  const EMPTY = Object.fromEntries(FOOTPRINT.map(([label]) => [label, 0]));

  function expectEveryTableTouched(counts: Record<string, number>): void {
    for (const [label, count] of Object.entries(counts)) {
      // A fixture that wrote nothing here would let the purge "clean" an empty table.
      expect({ label, count: count > 0 }).toEqual({ label, count: true });
    }
  }

  async function exists(id: string): Promise<{ node: boolean; detail: boolean }> {
    const [{ node: nodeRows }] = await dataSource.query(
      'SELECT count(*) AS node FROM ci.entities WHERE entity_id = $1',
      [id],
    );
    const [{ detail: detailRows }] = await dataSource.query(
      'SELECT count(*) AS detail FROM ci.objects WHERE object_id = $1',
      [id],
    );

    return { node: Number(nodeRows) > 0, detail: Number(detailRows) > 0 };
  }

  const GONE = { node: false, detail: false };
  const THERE = { node: true, detail: true };

  async function relatedOf(id: string): Promise<string[] | null> {
    const [row] = await dataSource.query('SELECT related_object_ids FROM ci.objects WHERE object_id = $1', [
      id,
    ]);

    return row.related_object_ids;
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes the item, its node and every row that points at it, and nothing else', async () => {
    const doomed = await kettle('Bosch kettle');
    const control = await kettle('Dualit toaster');

    const doomedBefore = await footprint(doomed);
    const controlBefore = await footprint(control);

    expectEveryTableTouched(doomedBefore);
    expectEveryTableTouched(controlBefore);

    const purged = await items.purge(owner, [doomed.itemId]);

    expect(purged).toEqual({ itemIds: [doomed.itemId], duplicateIds: [] });
    expect(await footprint(doomed)).toEqual(EMPTY);
    // The control item is exactly as it was, row for row.
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('frees the serial number the unit was recognised by, which its claim kept holding', async () => {
    const doomed = await kettle('Bosch kettle');
    const claim = (subject: string) =>
      dataSource.query(
        `INSERT INTO ci.object_identifiers (owner_user_id, subject_type, subject_id, namespace, value_normalized)
         VALUES ($1, 'object_instance', $2, 'serial', $3)`,
        [ownerId, subject, doomed.serial],
      );

    // The unique index is over the identifier and not the subject: while the claim stands, nobody else can take it.
    await expect(claim(uuidv7())).rejects.toThrow(/object_identifiers_claim_uniq/);

    await items.purge(owner, [doomed.itemId]);

    // A second kettle with the same serial can now be recognised.
    await expect(claim(uuidv7())).resolves.toBeDefined();
  });

  it('takes the item out of other items’ related lists, and nobody else’s', async () => {
    const doomed = await kettle('Bosch kettle');
    const control = await kettle('Dualit toaster');

    const accessoryOf = async (aggregate: Aggregate): Promise<string> => {
      const [row] = await dataSource.query(
        `SELECT object_id FROM ci.objects WHERE related_object_ids @> ARRAY[$1]::uuid[]`,
        [aggregate.itemId],
      );

      return row.object_id;
    };

    const doomedAccessory = await accessoryOf(doomed);
    const controlAccessory = await accessoryOf(control);
    const controlList = await relatedOf(controlAccessory);

    // Precondition: each accessory lists its own item and one other id.
    expect(await relatedOf(doomedAccessory)).toHaveLength(2);

    await items.purge(owner, [doomed.itemId]);

    const left = await relatedOf(doomedAccessory);

    expect(left).toHaveLength(1);
    expect(left).not.toContain(doomed.itemId);
    expect(await relatedOf(controlAccessory)).toEqual(controlList);
    // The accessory is an item in its own right: it is still there.
    expect(await exists(doomedAccessory)).toEqual(THERE);
  });

  it('purges several in one call, once each, and leaves the rest', async () => {
    const first = await kettle('Bosch kettle');
    const second = await kettle('Moka pot');
    const control = await kettle('Dualit toaster');
    const controlBefore = await footprint(control);

    const purged = await items.purge(owner, [first.itemId, second.itemId, first.itemId]);

    expect(purged.itemIds.sort()).toEqual([first.itemId, second.itemId].sort());
    expect(purged.duplicateIds).toEqual([]);
    expect(await footprint(first)).toEqual(EMPTY);
    expect(await footprint(second)).toEqual(EMPTY);
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('removes an item nothing has processed yet, and an item that was archived earlier', async () => {
    const bare = await bareItem('Unprocessed', ownerId);
    const archived = await bareItem('Old toaster', ownerId, { lifecycle: 'archived' });

    await dataSource.query('UPDATE ci.entities SET is_active = false WHERE entity_id = $1', [archived]);

    expect(await exists(bare)).toEqual(THERE);
    expect(await exists(archived)).toEqual(THERE);

    expect((await items.purge(owner, [bare, archived])).itemIds.sort()).toEqual([bare, archived].sort());
    expect(await exists(bare)).toEqual(GONE);
    expect(await exists(archived)).toEqual(GONE);
  });

  it('leaves the records that merely mention the item, which have a foreign key that sets itself to NULL', async () => {
    const doomed = await kettle('Bosch kettle');

    const [{ observation_id: observationId }] = await dataSource.query(
      `INSERT INTO ci.object_observations (user_id, observed_at, label, resolved_object_id)
       VALUES ($1, now(), 'a kettle', $2) RETURNING observation_id`,
      [ownerId, doomed.itemId],
    );
    const [{ receipt_id: receiptId }] = await dataSource.query(
      `INSERT INTO ci.receipts (user_id) VALUES ($1) RETURNING receipt_id`,
      [ownerId],
    );
    const [{ line_item_id: lineItemId }] = await dataSource.query(
      `INSERT INTO ci.receipt_line_items (receipt_id, user_id, line_number, description, minted_object_id)
       VALUES ($1, $2, 1, 'Kettle', $3) RETURNING line_item_id`,
      [receiptId, ownerId, doomed.itemId],
    );

    await items.purge(owner, [doomed.itemId]);

    // Both records are still there, in their own right, and no longer name an item that is not.
    expect(
      await dataSource.query(
        'SELECT resolved_object_id FROM ci.object_observations WHERE observation_id = $1',
        [observationId],
      ),
    ).toEqual([{ resolved_object_id: null }]);
    expect(
      await dataSource.query('SELECT minted_object_id FROM ci.receipt_line_items WHERE line_item_id = $1', [
        lineItemId,
      ]),
    ).toEqual([{ minted_object_id: null }]);
  });

  describe('an item that is another item’s parent', () => {
    it('is refused when a child would be left behind, and nothing changes', async () => {
      const kit = await kettle('Tool kit');
      const part = await bareItem('Screwdriver', ownerId, { parent: kit.itemId });
      const kitBefore = await footprint(kit);

      published.length = 0;

      await expect(items.purge(owner, [kit.itemId])).rejects.toThrow(/objects_parent_object_id_fkey/);

      // Every delete that ran before the one that failed was rolled back with it.
      expect(await footprint(kit)).toEqual(kitBefore);
      expect(await exists(part)).toEqual(THERE);
      expect(published).toEqual([]);
    });

    it('goes when its children are named in the same call, whichever is listed first', async () => {
      const kit = await bareItem('Tool kit', ownerId);
      const part = await bareItem('Screwdriver', ownerId, { parent: kit });
      const bit = await bareItem('Drill bit', ownerId, { parent: part });

      // A three-level chain: the kit holds the screwdriver, which holds the bit.
      const purged = await items.purge(owner, [bit, kit, part]);

      expect(purged.itemIds.sort()).toEqual([kit, part, bit].sort());
      expect(await exists(kit)).toEqual(GONE);
      expect(await exists(part)).toEqual(GONE);
      expect(await exists(bit)).toEqual(GONE);
    });

    it('lets the kit go once its parts have, in a later call', async () => {
      const kit = await bareItem('Tool kit', ownerId);
      const part = await bareItem('Screwdriver', ownerId, { parent: kit });

      await expect(items.purge(owner, [kit])).rejects.toThrow(/objects_parent_object_id_fkey/);
      expect((await items.purge(owner, [part])).itemIds).toEqual([part]);
      expect((await items.purge(owner, [kit])).itemIds).toEqual([kit]);
    });
  });

  describe('the duplicates that were merged into an item', () => {
    /** A survivor and two tombstones folded into it, each with the rows a merge and the pipeline leave. */
    async function mergedFamily() {
      const survivor = await kettle('Bosch kettle');
      const first = await kettle('Bosch kettle (duplicate)', ownerId, { mergedInto: survivor.itemId });
      const second = await kettle('Bosch kettle (another)', ownerId, { mergedInto: survivor.itemId });

      return { survivor, first, second };
    }

    it('go with it, in the same transaction, with everything that names them', async () => {
      const { survivor, first, second } = await mergedFamily();
      const control = await mergedFamily();
      const controlBefore = await Promise.all(
        [control.survivor, control.first, control.second].map((aggregate) => footprint(aggregate)),
      );

      for (const aggregate of [survivor, first, second]) {
        expectEveryTableTouched(await footprint(aggregate));
      }

      const purged = await items.purge(owner, [survivor.itemId]);

      // The one that was asked for, and the two that nobody saw.
      expect(purged.itemIds).toEqual([survivor.itemId]);
      expect(purged.duplicateIds.sort()).toEqual([first.itemId, second.itemId].sort());

      for (const aggregate of [survivor, first, second]) {
        expect(await footprint(aggregate)).toEqual(EMPTY);
      }

      // Another survivor's family is untouched, row for row.
      expect(
        await Promise.all(
          [control.survivor, control.first, control.second].map((aggregate) => footprint(aggregate)),
        ),
      ).toEqual(controlBefore);
    });

    it('would otherwise come back as archived items, which is what deleting the survivor alone does', async () => {
      // The control for the case above: the same family, deleted the way the generic path deletes a node.
      const { survivor, first } = await mergedFamily();

      expect((await exists(first.itemId)).detail).toBe(true);

      await dataSource.query(`DELETE FROM ci.entities WHERE entity_id = $1`, [survivor.itemId]);

      // The tombstone survives, with its brand, and `ON DELETE SET NULL` has made it a live row again.
      expect(
        await dataSource.query('SELECT merged_into_object_id, brand FROM ci.objects WHERE object_id = $1', [
          first.itemId,
        ]),
      ).toEqual([{ merged_into_object_id: null, brand: 'Bosch' }]);
    });

    it('go with a survivor however long the chain of merges that led to it', async () => {
      // A legacy chain: the second tombstone points at the first, which points at the survivor.
      const survivor = await bareItem('Survivor', ownerId);
      const middle = await bareItem('Middle', ownerId, { mergedInto: survivor });
      const last = await bareItem('Last', ownerId, { mergedInto: middle });

      const purged = await items.purge(owner, [survivor]);

      expect(purged.duplicateIds.sort()).toEqual([middle, last].sort());
      expect(await exists(last)).toEqual(GONE);
    });

    it('does not take the survivor when a duplicate is asked for by name, which goes alone', async () => {
      const { survivor, first, second } = await mergedFamily();
      const survivorBefore = await footprint(survivor);

      // The merge audit row of the one that went names the survivor as its target. It goes with the duplicate.
      const purged = await items.purge(owner, [first.itemId]);

      expect(purged).toEqual({ itemIds: [first.itemId], duplicateIds: [] });
      expect(await footprint(first)).toEqual(EMPTY);
      expect((await exists(second.itemId)).detail).toBe(true);
      expect(await exists(survivor.itemId)).toEqual(THERE);

      // The survivor's own rows are as they were, except the one audit row that was about the duplicate that
      // went: it names the survivor as its target and the duplicate as its source, and keeps the duplicate's
      // brand and price, so it goes with the duplicate and with nothing else.
      expect(await footprint(survivor)).toEqual({
        ...survivorBefore,
        'ci.entity_merges': survivorBefore['ci.entity_merges'] - 1,
      });
    });

    it('are not reported as unasked-for when they were asked for with their survivor', async () => {
      const { survivor, first, second } = await mergedFamily();

      const purged = await items.purge(owner, [survivor.itemId, first.itemId]);

      // The duplicate that was named is an item that was asked for. Only the one nobody named is a duplicate.
      expect(purged.itemIds.sort()).toEqual([survivor.itemId, first.itemId].sort());
      expect(purged.duplicateIds).toEqual([second.itemId]);
    });

    it('refuse the purge when one of them is another item’s parent and the child is left behind', async () => {
      const { survivor, first } = await mergedFamily();
      const part = await bareItem('Screwdriver', ownerId, { parent: first.itemId });
      const survivorBefore = await footprint(survivor);

      published.length = 0;

      await expect(items.purge(owner, [survivor.itemId])).rejects.toThrow(/objects_parent_object_id_fkey/);

      expect(await footprint(survivor)).toEqual(survivorBefore);
      expect(await exists(first.itemId)).toEqual(THERE);
      expect(await exists(part)).toEqual(THERE);
      expect(published).toEqual([]);
    });
  });

  it('announces each removal, the duplicates too, after it has committed, and nothing for the ids it did not take', async () => {
    const survivor = await kettle('Bosch kettle');
    const duplicate = await kettle('Bosch kettle (duplicate)', ownerId, { mergedInto: survivor.itemId });
    const missing = uuidv7();

    published.length = 0;

    await items.purge(owner, [survivor.itemId, missing]);

    expect(announced()).toEqual([survivor.itemId, duplicate.itemId].sort());
  });

  it('announces a removal only once it has committed, so a listener that looks finds the row gone', async () => {
    const doomed = await kettle('Bosch kettle');
    const found: number[] = [];

    (signalling.send as jest.Mock).mockImplementationOnce(async (name: string, payload: unknown) => {
      // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
      const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.objects WHERE object_id = $1', [
        doomed.itemId,
      ]);

      found.push(Number(count));
      published.push({ name, payload });

      return [];
    });

    await items.purge(owner, [doomed.itemId]);

    // Precondition: the listener was asked, and asked once.
    expect(announced()).toEqual([doomed.itemId]);
    expect(found).toEqual([0]);
  });

  it('leaves somebody else’s item alone, and ignores ids that do not exist', async () => {
    const theirs = await kettle('Their kettle', strangerId);
    const theirsBefore = await footprint(theirs);

    published.length = 0;

    const purged = await items.purge(owner, [theirs.itemId, uuidv7()]);

    expect(purged).toEqual({ itemIds: [], duplicateIds: [] });
    expect(await footprint(theirs)).toEqual(theirsBefore);
    expect(published).toEqual([]);

    // And in the other direction: the stranger can purge their own.
    expect((await items.purge(stranger, [theirs.itemId])).itemIds).toEqual([theirs.itemId]);
    expect(await footprint(theirs)).toEqual(EMPTY);
  });

  it('leaves an Item node with no ci.objects row behind it, for the generic delete', async () => {
    // Graph ingest writes these. There is no detail row to cascade.
    const graphOnly = await node('Item', 'Imported without a detail row');

    published.length = 0;

    expect(await items.purge(owner, [graphOnly])).toEqual({ itemIds: [], duplicateIds: [] });
    expect((await exists(graphOnly)).node).toBe(true);
    expect(published).toEqual([]);
  });

  it('does nothing for an empty request', async () => {
    expect(await items.purge(owner, [])).toEqual({ itemIds: [], duplicateIds: [] });
    expect(published).toEqual([]);
  });

  it('waits for a merge that is folding another item into it, and takes that duplicate too', async () => {
    const survivor = await kettle('Bosch kettle');
    const latecomer = await kettle('Bosch kettle (about to be merged)');
    const merge = dataSource.createQueryRunner();

    await merge.connect();
    await merge.startTransaction();

    let purging: Promise<unknown> | undefined;

    try {
      const [{ pid }] = await merge.query('SELECT pg_backend_pid() AS pid');

      // What `ObjectMergeService` does: lock the target and the source, then tombstone the source.
      // Uncommitted, so the purge cannot see the new tombstone until the merge commits.
      await merge.query('SELECT object_id FROM ci.objects WHERE object_id = ANY($1::uuid[]) FOR UPDATE', [
        [survivor.itemId, latecomer.itemId],
      ]);
      await merge.query(
        `UPDATE ci.objects SET merged_into_object_id = $2, lifecycle_state = 'archived' WHERE object_id = $1`,
        [latecomer.itemId, survivor.itemId],
      );

      purging = items.purge(owner, [survivor.itemId]);

      // Ask Postgres who is waiting on that connection, rather than sleeping, and WHERE: the purge has to
      // be held at the statement that locks the item, before it has looked for duplicates or deleted anything.
      // Held at the delete instead, it would have missed the tombstone this merge is about to commit, and
      // deleting the survivor would have turned it back into an archived item.
      const blocked = await until(async () => {
        const rows: Array<{ query: string }> = await dataSource.query(
          'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        );

        return rows.length > 0 ? rows : null;
      }, 'the purge to block on the merge connection');

      expect(blocked).toHaveLength(1);
      expect(blocked[0].query).toMatch(/\bFOR UPDATE\b/);

      await merge.commitTransaction();
    } catch (error) {
      await merge.rollbackTransaction().catch(() => undefined);
      // Let a purge that was released by the rollback finish, so it cannot run into the next test's clean-up.
      await purging?.catch(() => undefined);

      throw error;
    } finally {
      await merge.release();
    }

    // Having waited, the purge saw the duplicate the merge committed, and took it.
    expect(await purging).toEqual({ itemIds: [survivor.itemId], duplicateIds: [latecomer.itemId] });
    expect(await footprint(latecomer)).toEqual(EMPTY);
    expect(await footprint(survivor)).toEqual(EMPTY);
  });

  it('is all or nothing when something it does not know about blocks the delete', async () => {
    const doomed = await kettle('Bosch kettle');
    const doomedBefore = await footprint(doomed);

    // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing
    // it at the item's node stands in for a table this teardown has never heard of.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomed.itemId, strangerId]);

    published.length = 0;

    await expect(items.purge(owner, [doomed.itemId])).rejects.toThrow(/foreign key/i);

    // Every delete that ran before the one that failed was rolled back with it.
    expect(await footprint(doomed)).toEqual(doomedBefore);
    expect(published).toEqual([]);
  });
});

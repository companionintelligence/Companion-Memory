import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { ConceptRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import {
  BARE_FOOTPRINT,
  emptyFootprint,
  insertNode,
  readFootprint,
  seedBareFootprint,
  wipeGraphEntities,
} from '../../../__tests__/support/graphEntityFootprint';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { ConceptEntity } from '../../entities/ConceptEntity';
import { ConceptService } from '../ConceptService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PURGED CONCEPT LEAVES NOTHING BEHIND. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` deleted a concept by deleting its `ci.entities` row and its
 * edges, and nothing else. A concept is the plain case: nothing points at one but the rows every graph
 * entity is named by, which have no foreign key to say so. They stayed: the pipeline state and dead
 * letters, the tags and categories, the search rows, the deltas, which carry its name, its merge
 * bookkeeping, the names it was known by in the identifier index, and the staged import entity it came
 * from.
 *
 * Each case seeds a doomed concept and a CONTROL one with a row in every one of those tables, asserts
 * every one is non-zero before the purge, and checks that the doomed concept reads zero everywhere
 * afterwards and the control concept has not moved.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ConceptService.purge.integration] SKIPPED — ${availability.reason}`);
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

interface Aggregate {
  conceptId: string;
  name: string;
}

describeWithDb(`ConceptService.purge against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let concepts: ConceptService;

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
      .filter((event) => event.name === ConceptRemovedEvent)
      .map((event) => (event.payload as { conceptId: string }).conceptId)
      .sort();

  const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
  const track = (id: string) => seeded.push(id);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, ConceptEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ConceptService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ConceptPurge', userId);
    }

    concepts = new ConceptService(dataSource.getRepository(ConceptEntity), logger(), signalling);
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await wipeGraphEntities(query, users, seeded);
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

  async function concept(name: string, forUser = ownerId, entityType = 'Concept'): Promise<Aggregate> {
    const conceptId = await insertNode(query, track, { entityType, name, ownerId: forUser });

    await seedBareFootprint(query, track, {
      entityId: conceptId,
      entityType,
      searchType: 'concept',
      name,
      ownerId: forUser,
    });

    return { conceptId, name };
  }

  const footprint = (aggregate: Aggregate) => readFootprint(query, BARE_FOOTPRINT, aggregate.conceptId);

  /** What `footprint` reads when every row is gone. */
  const EMPTY = emptyFootprint(BARE_FOOTPRINT);

  function expectEveryTableTouched(counts: Record<string, number>): void {
    for (const [label, count] of Object.entries(counts)) {
      // A fixture that wrote nothing here would let the purge "clean" an empty table.
      expect({ label, count: count > 0 }).toEqual({ label, count: true });
    }
  }

  async function nodeExists(id: string): Promise<boolean> {
    const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [id]);

    return Number(count) > 0;
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes the concept, its node and every row that points at it, and nothing else', async () => {
    const doomed = await concept('Pottery');
    const control = await concept('Sourdough');

    const doomedBefore = await footprint(doomed);
    const controlBefore = await footprint(control);

    expectEveryTableTouched(doomedBefore);
    expectEveryTableTouched(controlBefore);

    const purged = await concepts.purge(owner, [doomed.conceptId]);

    expect(purged).toEqual({ conceptIds: [doomed.conceptId], duplicateIds: [] });
    expect(await footprint(doomed)).toEqual(EMPTY);
    // The control concept is exactly as it was, row for row.
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('frees the name it was known by, which its identifier kept holding', async () => {
    const doomed = await concept('Pottery');
    const claim = () =>
      dataSource.query(
        `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized) VALUES ($1, $2, 'name', $3)`,
        [uuidv7(), ownerId, `name-${doomed.conceptId}`],
      );

    // The unique index is over (owner, kind, value) and not over the concept: while the row stands, nothing else
    // can be known by that name.
    await expect(claim()).rejects.toThrow(/entity_identifiers_owner_kind_value_uniq/);

    await concepts.purge(owner, [doomed.conceptId]);

    await expect(claim()).resolves.toBeDefined();
  });

  it('turns the claims that resolved to it back into unresolved observations, and takes the verdict about them', async () => {
    const doomed = await concept('Pottery');
    const control = await concept('Sourdough');

    await concepts.purge(owner, [doomed.conceptId]);

    const claimOf = (name: string) =>
      dataSource.query(
        `SELECT entity_id, confidence, method, disposition, disposed_at
           FROM ci.identifier_claims WHERE owner_user_id = $1 AND value_normalized = $2`,
        [ownerId, name],
      );

    // The observation was made about a message that stays, so the row stays; what is gone is who it resolved to,
    // and the human's ruling on that.
    expect(await claimOf(`name-${doomed.conceptId}`)).toEqual([
      { entity_id: null, confidence: null, method: null, disposition: null, disposed_at: null },
    ]);
    expect((await claimOf(`name-${control.conceptId}`))[0]).toMatchObject({
      entity_id: control.conceptId,
      method: 'name_exact',
      disposition: 'rejected',
    });
  });

  it('takes its staged import mapping, so a later push writes no dead id, and leaves the staged entity', async () => {
    const doomed = await concept('Pottery');
    const stagedBefore = await dataSource.query(
      'SELECT count(*) FROM ci_import.staged_entities WHERE user_id = $1',
      [ownerId],
    );

    expect((await footprint(doomed))['ci_import.entity_mappings']).toBe(1);

    await concepts.purge(owner, [doomed.conceptId]);

    // The staged entity is the import's own record of its source, and stays; the mapping onto the node is gone.
    expect(await footprint(doomed)).toEqual(EMPTY);
    expect(
      await dataSource.query('SELECT count(*) FROM ci_import.staged_entities WHERE user_id = $1', [ownerId]),
    ).toEqual(stagedBefore);
  });

  it('announces each removal once it has committed, and nothing for the ids it did not take', async () => {
    const doomed = await concept('Pottery');
    const found: number[] = [];

    (signalling.send as jest.Mock).mockImplementationOnce(async (name: string, payload: unknown) => {
      // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
      const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [
        doomed.conceptId,
      ]);

      found.push(Number(count));
      published.push({ name, payload });

      return [];
    });
    published.length = 0;

    await concepts.purge(owner, [doomed.conceptId, uuidv7()]);

    expect(announced()).toEqual([doomed.conceptId]);
    expect(found).toEqual([0]);
  });

  it('takes the duplicates that were merged into it, and announces them too', async () => {
    const survivor = await concept('Pottery');
    // Nothing merges concepts today, but a node retyped into one after it was merged carries its pointer, and the
    // schema's SET NULL would bring each tombstone back as an archived concept with the name it had.
    const tombstone = await insertNode(
      query,
      track,
      { entityType: 'Concept', name: 'Ceramics', ownerId },
      { mergedInto: survivor.conceptId },
    );

    await seedBareFootprint(query, track, {
      entityId: tombstone,
      entityType: 'Concept',
      searchType: 'concept',
      name: 'Ceramics',
      ownerId,
    });

    expectEveryTableTouched(await footprint({ conceptId: tombstone, name: 'Ceramics' }));
    published.length = 0;

    const purged = await concepts.purge(owner, [survivor.conceptId]);

    expect(purged).toEqual({ conceptIds: [survivor.conceptId], duplicateIds: [tombstone] });
    expect(await footprint({ conceptId: tombstone, name: 'Ceramics' })).toEqual(EMPTY);
    expect(announced()).toEqual([survivor.conceptId, tombstone].sort());
  });

  it('leaves a node of another kind alone, whatever id it is asked for under', async () => {
    const person = await insertNode(query, track, { entityType: 'Person', name: 'Dana', ownerId });
    const place = await insertNode(query, track, { entityType: 'Location', name: 'The office', ownerId });

    expect(await concepts.purge(owner, [person, place])).toEqual({ conceptIds: [], duplicateIds: [] });
    expect(await nodeExists(person)).toBe(true);
    expect(await nodeExists(place)).toBe(true);
    expect(published).toEqual([]);
  });

  it('leaves somebody else’s concept alone, and ignores ids that do not exist', async () => {
    const theirs = await concept('Their pottery', strangerId);
    const theirsBefore = await footprint(theirs);

    const purged = await concepts.purge(owner, [theirs.conceptId, uuidv7()]);

    expect(purged).toEqual({ conceptIds: [], duplicateIds: [] });
    expect(await footprint(theirs)).toEqual(theirsBefore);
    expect(published).toEqual([]);

    // And in the other direction: the stranger can purge their own.
    expect((await concepts.purge(stranger, [theirs.conceptId])).conceptIds).toEqual([theirs.conceptId]);
    expect(await footprint(theirs)).toEqual(EMPTY);
  });

  it('purges several in one call, once each, and leaves the rest', async () => {
    const first = await concept('Pottery');
    const second = await concept('Kintsugi');
    const control = await concept('Sourdough');
    const controlBefore = await footprint(control);

    const purged = await concepts.purge(owner, [first.conceptId, second.conceptId, first.conceptId]);

    expect(purged.conceptIds.sort()).toEqual([first.conceptId, second.conceptId].sort());
    expect(await footprint(first)).toEqual(EMPTY);
    expect(await footprint(second)).toEqual(EMPTY);
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('does nothing for an empty request', async () => {
    expect(await concepts.purge(owner, [])).toEqual({ conceptIds: [], duplicateIds: [] });
    expect(published).toEqual([]);
  });

  it('is all or nothing when something it does not know about blocks the delete', async () => {
    const doomed = await concept('Pottery');
    const doomedBefore = await footprint(doomed);

    // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing it at the concept's node
    // stands in for a table this teardown has never heard of.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [
      doomed.conceptId,
      strangerId,
    ]);

    published.length = 0;

    await expect(concepts.purge(owner, [doomed.conceptId])).rejects.toThrow(/foreign key/i);

    // Every delete that ran before the one that failed was rolled back with it.
    expect(await footprint(doomed)).toEqual(doomedBefore);
    expect(published).toEqual([]);
  });
});

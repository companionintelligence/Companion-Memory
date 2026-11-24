import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { EntityTagEntity } from '../../entities/EntityTagEntity';
import { TagEntity } from '../../entities/TagEntity';
import { TagService } from '../TagService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RENAMING AND DELETING A TAG, AGAINST A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both operations are defined by constraints a mocked repository cannot
 * express, so mocking them would only prove the mock:
 *
 *   * `tags_label_user_key` makes "rename onto a label I already own" a
 *     constraint violation unless the two tags are merged instead;
 *   * `entity_tag_unique_entry` decides which assignments a merge may move
 *     and which are duplicates that have to be dropped;
 *   * `entity_tag_tag_id_fkey` has no ON DELETE rule, so a delete that does
 *     not clear the assignments FIRST fails outright.
 *
 * Every fixture is scoped to a freshly generated user id, so the suite can
 * run against a developer's dev database without touching real rows.
 */

const TAG_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(TAG_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/TagService.mutations.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`TagService rename/delete against a live Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: TagService;

  const userA = randomUUID();
  const userB = randomUUID();
  const contextA = { userId: userA } as UserServiceContext;

  const seedTag = async (userId: string, label: string, description: string | null = null) => {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO ci_search.tags (id, label, description, user_id) VALUES ($1, $2, $3, $4)`,
      [id, label, description, userId],
    );

    return id;
  };

  const assign = async (tagId: string, entityType: string, entityId = randomUUID()) => {
    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ($1, $2, $3)`,
      [entityType, entityId, tagId],
    );

    return entityId;
  };

  const assignmentsFor = async (tagId: string): Promise<Array<{ entity_type: string; entity_id: string }>> =>
    dataSource.query(
      `SELECT entity_type, entity_id FROM ci_search.entity_tag WHERE tag_id = $1 ORDER BY entity_id`,
      [tagId],
    );

  const tagRow = async (id: string) =>
    (await dataSource.query(`SELECT id, label, description FROM ci_search.tags WHERE id = $1`, [id]))[0] ??
    null;

  beforeAll(async () => {
    const connection = resolveConnection(TAG_DATABASE_ENV);

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      entities: [TagEntity, EntityTagEntity],
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();

    service = new TagService(dataSource.getRepository(TagEntity), dataSource);
  });

  const cleanUp = async () => {
    await dataSource.query(
      `DELETE FROM ci_search.entity_tag
        WHERE tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
      [[userA, userB]],
    );
    await dataSource.query('DELETE FROM ci_search.tags WHERE user_id = ANY($1::uuid[])', [[userA, userB]]);
  };

  afterEach(cleanUp);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanUp();
      await dataSource.destroy();
    }
  });

  describe('update (rename)', () => {
    it('renames in place and leaves the assignments alone when the label is free', async () => {
      const id = await seedTag(userA, 'holiday');
      const eventId = await assign(id, 'event');

      const result = await service.update(contextA, id, { label: 'Vacation' });

      expect(result).toMatchObject({ merged: false, movedAssignments: 0, previousLabel: 'holiday' });
      // Labels are normalised, and the row keeps its identity across a rename.
      expect(result!.tag).toMatchObject({ id, label: 'vacation' });
      expect(await assignmentsFor(id)).toEqual([{ entity_type: 'event', entity_id: eventId }]);
    });

    it('merges into the existing tag when the new label is already taken', async () => {
      const source = await seedTag(userA, 'holiday');
      const target = await seedTag(userA, 'vacation', 'time off');

      const onlyOnSource = await assign(source, 'event');
      const onBoth = await assign(source, 'note');

      await assign(target, 'note', onBoth);

      const result = await service.update(contextA, source, { label: 'vacation' });

      // The surviving tag is the one that already held the label.
      expect(result).toMatchObject({ merged: true, previousLabel: 'holiday' });
      expect(result!.tag).toMatchObject({ id: target, label: 'vacation', description: 'time off' });

      // Only the assignment the target did not already have moves; the
      // duplicate is dropped rather than re-inserted (it would violate
      // entity_tag_unique_entry).
      expect(result!.movedAssignments).toBe(1);
      expect(await assignmentsFor(target)).toEqual(
        [
          { entity_type: 'note', entity_id: onBoth },
          { entity_type: 'event', entity_id: onlyOnSource },
        ].sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
      );

      // The merged-away tag and every trace of it are gone.
      expect(await tagRow(source)).toBeNull();
      expect(await assignmentsFor(source)).toEqual([]);
    });

    it("does not treat another user's identical label as a collision", async () => {
      const mine = await seedTag(userA, 'holiday');
      const theirs = await seedTag(userB, 'vacation');

      const result = await service.update(contextA, mine, { label: 'vacation' });

      expect(result).toMatchObject({ merged: false });
      expect(result!.tag).toMatchObject({ id: mine, label: 'vacation' });
      expect(await tagRow(theirs)).toMatchObject({ id: theirs, label: 'vacation' });
    });

    it('leaves the label alone when only the description is edited', async () => {
      const id = await seedTag(userA, 'holiday', 'old');

      const result = await service.update(contextA, id, { description: 'new' });

      expect(result!.tag).toMatchObject({ id, label: 'holiday', description: 'new' });
      expect(result!.previousLabel).toBe('holiday');
    });

    it("refuses to touch another user's tag", async () => {
      const theirs = await seedTag(userB, 'holiday');

      expect(await service.update(contextA, theirs, { label: 'stolen' })).toBeNull();
      expect(await tagRow(theirs)).toMatchObject({ label: 'holiday' });
    });

    it('takes over a label left behind by a soft-deleted tag', async () => {
      // Nothing soft-deletes tags today, but the column exists and the unique
      // constraint is not partial — a leftover row would otherwise make the
      // label permanently un-renameable-to.
      const id = await seedTag(userA, 'holiday');
      const ghost = await seedTag(userA, 'vacation');

      await dataSource.query('UPDATE ci_search.tags SET deleted_at = NOW() WHERE id = $1', [ghost]);

      const result = await service.update(contextA, id, { label: 'vacation' });

      expect(result).toMatchObject({ merged: false });
      expect(result!.tag).toMatchObject({ id, label: 'vacation' });
      expect(await tagRow(ghost)).toBeNull();
    });
  });

  describe('remove (delete)', () => {
    it('deletes the tag and every assignment of it', async () => {
      const id = await seedTag(userA, 'holiday');

      await assign(id, 'event');
      await assign(id, 'note');

      const result = await service.remove(contextA, id);

      expect(result).toEqual({ label: 'holiday', removedAssignments: 2 });
      expect(await tagRow(id)).toBeNull();
      expect(await assignmentsFor(id)).toEqual([]);
    });

    it("leaves the user's other tags and their assignments untouched", async () => {
      const doomed = await seedTag(userA, 'holiday');
      const kept = await seedTag(userA, 'work');

      const shared = await assign(doomed, 'event');

      await assign(kept, 'event', shared);

      await service.remove(contextA, doomed);

      expect(await assignmentsFor(kept)).toEqual([{ entity_type: 'event', entity_id: shared }]);
    });

    it("refuses to delete another user's tag", async () => {
      const theirs = await seedTag(userB, 'holiday');

      expect(await service.remove(contextA, theirs)).toBeNull();
      expect(await tagRow(theirs)).not.toBeNull();
    });

    it('reports nothing for a tag that does not exist', async () => {
      expect(await service.remove(contextA, randomUUID())).toBeNull();
    });
  });

  describe('getAssignmentCounts', () => {
    it("counts each tag, omits the empty ones, and never counts another user's", async () => {
      const busy = await seedTag(userA, 'holiday');
      const empty = await seedTag(userA, 'work');
      const theirs = await seedTag(userB, 'private');

      await assign(busy, 'event');
      await assign(busy, 'note');
      await assign(theirs, 'event');

      const counts = await service.getAssignmentCounts(contextA, [busy, empty, theirs]);

      expect(counts.get(busy)).toBe(2);
      expect(counts.has(empty)).toBe(false);
      expect(counts.has(theirs)).toBe(false);
    });

    it('is empty for an empty request', async () => {
      expect(await service.getAssignmentCounts(contextA, [])).toEqual(new Map());
    });
  });

  describe('replaceEntityTags', () => {
    it("replaces one entity's tag set atomically without touching another user's tags", async () => {
      const entityId = randomUUID();
      const old = await seedTag(userA, 'other');
      const kept = await seedTag(userA, 'gym');
      const theirs = await seedTag(userB, 'private');

      await assign(old, 'place', entityId);
      await assign(kept, 'place', entityId);
      await assign(theirs, 'place', entityId);

      await service.replaceEntityTags(contextA, { type: 'place', id: entityId }, ['Gym', 'Social']);

      const mine = await service.getTagsForEntity(contextA, { type: 'place', id: entityId });

      expect(mine.map((tag) => tag.label).sort()).toEqual(['gym', 'social']);
      expect(await assignmentsFor(old)).toEqual([]);
      expect(await assignmentsFor(theirs)).toEqual([{ entity_type: 'place', entity_id: entityId }]);
    });
  });

  it('keeps a merged-into label re-usable, which a soft delete would not', async () => {
    // The point of hard-deleting: tagging something with the label again has
    // to work immediately afterwards.
    const id = await seedTag(userA, 'holiday');

    await service.remove(contextA, id);
    await service.tagEntities(contextA, {
      labels: ['holiday'],
      entities: [{ type: 'event', id: randomUUID() }],
    });

    const [recreated] = await dataSource.query(
      'SELECT id FROM ci_search.tags WHERE user_id = $1 AND label = $2',
      [userA, 'holiday'],
    );

    expect(recreated).toBeDefined();
    expect(recreated.id).not.toBe(id);
  });
});

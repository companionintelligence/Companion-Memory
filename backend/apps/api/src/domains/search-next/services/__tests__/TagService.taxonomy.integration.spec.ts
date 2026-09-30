import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { CategoryDirectionOptoutEntity } from '../../entities/CategoryDirectionOptoutEntity';
import { EntityCategoryEntity } from '../../entities/EntityCategoryEntity';
import { EntityTagEntity } from '../../entities/EntityTagEntity';
import { TagCategoryEntity } from '../../entities/TagCategoryEntity';
import { TagDirectionEntity } from '../../entities/TagDirectionEntity';
import { TagEntity } from '../../entities/TagEntity';
import { TagService } from '../TagService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TAG TAXONOMY (kind / tag_directions / tag_categories /
 * category_direction_optouts / entity_categories), AGAINST A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same rationale as `TagService.mutations.integration.spec.ts`: the
 * behaviour under test is defined by constraints a mock cannot express —
 * `tag_directions_pkey` / `tag_categories_pkey` / `category_direction_optouts_pkey`
 * (composite PKs stopping a duplicate membership row), every new table's
 * `ON DELETE CASCADE` to `ci_search.tags(id)`, and the CHECK on `tags.kind`.
 * Every fixture is scoped to a freshly generated user id.
 */

const TAG_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(TAG_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/TagService.taxonomy.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`TagService taxonomy against a live Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: TagService;

  const userA = randomUUID();
  const userB = randomUUID();
  const contextA = { userId: userA } as UserServiceContext;

  const seedTag = async (
    userId: string,
    label: string,
    opts: { kind?: string; isBase?: boolean } = {},
  ): Promise<string> => {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO ci_search.tags (id, label, user_id, kind, is_base) VALUES ($1, $2, $3, $4, $5)`,
      [id, label, userId, opts.kind ?? null, opts.isBase ?? false],
    );

    return id;
  };

  const assignTag = async (tagId: string, entityType: string, entityId: string = randomUUID()) => {
    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ($1, $2, $3)`,
      [entityType, entityId, tagId],
    );

    return entityId;
  };

  // setEntityCategories owner-checks the entity itself, so those fixtures must
  // be real rows the caller owns, not bare uuids. A task is the smallest.
  const seedTask = async (userId: string): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO ci.tasks (user_id, title) VALUES ($1, 'tag taxonomy spec task') RETURNING id`,
      [userId],
    )) as Array<{ id: string }>;

    return id;
  };

  const tagLabels = (tags: { label: string }[]) => tags.map((t) => t.label).sort();

  beforeAll(async () => {
    const connection = resolveConnection(TAG_DATABASE_ENV);

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      entities: [
        TagEntity,
        EntityTagEntity,
        TagDirectionEntity,
        TagCategoryEntity,
        CategoryDirectionOptoutEntity,
        EntityCategoryEntity,
      ],
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

    // ci.tasks.user_id references ci.users; ci_search.tags.user_id does not.
    for (const userId of [userA, userB]) {
      await dataSource.query(`INSERT INTO ci.users (id, email, name) VALUES ($1, $2, $3)`, [
        userId,
        `tag-taxonomy.${userId}@example.test`,
        'tag taxonomy spec fixture',
      ]);
    }
  });

  const cleanUp = async () => {
    await dataSource.query('DELETE FROM ci.tasks WHERE user_id = ANY($1::uuid[])', [[userA, userB]]);
    // entity_tag has no ON DELETE rule to ci_search.tags, so it must go
    // first. Every other taxonomy table (tag_directions, tag_categories,
    // category_direction_optouts, entity_categories) cascades automatically
    // when the tag row underneath it is deleted.
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
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[userA, userB]]);
      await dataSource.destroy();
    }
  });

  describe('setKind', () => {
    it("assigns a tag's taxonomy level", async () => {
      const id = await seedTag(userA, 'work');

      const result = await service.setKind(contextA, id, 'direction');

      expect(result).toMatchObject({ id, kind: 'direction' });
    });

    it('rejects an invalid kind', async () => {
      const id = await seedTag(userA, 'work');

      await expect(service.setKind(contextA, id, 'bogus' as never)).rejects.toThrow('Invalid tag kind');
    });

    it("refuses another user's tag", async () => {
      const theirs = await seedTag(userB, 'work');

      expect(await service.setKind(contextA, theirs, 'direction')).toBeNull();
    });

    it('reports nothing for a tag that does not exist', async () => {
      expect(await service.setKind(contextA, randomUUID(), 'direction')).toBeNull();
    });
  });

  describe('direction grouping (tag_directions)', () => {
    it('is Unsorted (empty) with no membership row', async () => {
      const intention = await seedTag(userA, 'yard-work', { kind: 'intention' });

      expect(await service.getTagDirections(contextA, intention)).toEqual([]);
    });

    it('replaces membership and returns the resulting directions', async () => {
      const intention = await seedTag(userA, 'yard-work', { kind: 'intention' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });
      const work = await seedTag(userA, 'work', { kind: 'direction' });

      const result = await service.setTagDirections(contextA, intention, [home, work]);

      expect(tagLabels(result!)).toEqual(['home', 'work']);
      expect(tagLabels(await service.getTagDirections(contextA, intention))).toEqual(['home', 'work']);
    });

    it('a second call replaces rather than accumulates', async () => {
      const intention = await seedTag(userA, 'yard-work', { kind: 'intention' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });
      const work = await seedTag(userA, 'work', { kind: 'direction' });

      await service.setTagDirections(contextA, intention, [home, work]);
      await service.setTagDirections(contextA, intention, [work]);

      expect(tagLabels(await service.getTagDirections(contextA, intention))).toEqual(['work']);
    });

    it('an empty replacement clears membership (Unsorted)', async () => {
      const intention = await seedTag(userA, 'yard-work', { kind: 'intention' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });

      await service.setTagDirections(contextA, intention, [home]);
      await service.setTagDirections(contextA, intention, []);

      expect(await service.getTagDirections(contextA, intention)).toEqual([]);
    });

    it("silently drops a direction id that is not the caller's own kind='direction' tag", async () => {
      const intention = await seedTag(userA, 'yard-work', { kind: 'intention' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });
      const notADirection = await seedTag(userA, 'focus', { kind: 'intention' });
      const theirs = await seedTag(userB, 'work', { kind: 'direction' });

      const result = await service.setTagDirections(contextA, intention, [home, notADirection, theirs]);

      expect(tagLabels(result!)).toEqual(['home']);
    });

    it('throws when the target tag is not an intention', async () => {
      const direction = await seedTag(userA, 'home', { kind: 'direction' });
      const otherDirection = await seedTag(userA, 'work', { kind: 'direction' });

      await expect(service.setTagDirections(contextA, direction, [otherDirection])).rejects.toThrow(
        'Only intention tags can belong to a direction',
      );
    });

    it('returns null for a tag that does not exist or is not owned', async () => {
      expect(await service.setTagDirections(contextA, randomUUID(), [])).toBeNull();

      const theirs = await seedTag(userB, 'yard-work', { kind: 'intention' });

      expect(await service.setTagDirections(contextA, theirs, [])).toBeNull();
    });
  });

  describe('category grouping (tag_categories) — the orthogonal axis', () => {
    it('is Unsorted (empty) with no membership row', async () => {
      const intention = await seedTag(userA, 'focus', { kind: 'intention' });

      expect(await service.getTagCategories(contextA, intention)).toEqual([]);
    });

    it('replaces membership independently of direction membership', async () => {
      const intention = await seedTag(userA, 'focus', { kind: 'intention' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });
      const career = await seedTag(userA, 'career', { kind: 'category' });

      await service.setTagDirections(contextA, intention, [home]);
      await service.setTagCategories(contextA, intention, [career]);

      expect(tagLabels(await service.getTagDirections(contextA, intention))).toEqual(['home']);
      expect(tagLabels(await service.getTagCategories(contextA, intention))).toEqual(['career']);
    });

    it('throws when the target tag is not an intention', async () => {
      const category = await seedTag(userA, 'career', { kind: 'category' });
      const otherCategory = await seedTag(userA, 'health', { kind: 'category' });

      await expect(service.setTagCategories(contextA, category, [otherCategory])).rejects.toThrow(
        'Only intention tags can belong to a category',
      );
    });
  });

  describe('category ⇄ direction opt-outs (category_direction_optouts) — polarity', () => {
    it('a category with no opt-out rows applies under every direction', async () => {
      const category = await seedTag(userA, 'career', { kind: 'category' });
      await seedTag(userA, 'home', { kind: 'direction' });
      await seedTag(userA, 'work', { kind: 'direction' });

      expect(await service.getCategoryDirectionOptouts(contextA, category)).toEqual([]);
    });

    it('disabling a direction for a category writes an opt-out row', async () => {
      const category = await seedTag(userA, 'career', { kind: 'category' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });
      const work = await seedTag(userA, 'work', { kind: 'direction' });

      const applied = await service.setCategoryDirectionEnabled(contextA, category, home, false);

      expect(applied).toBe(true);
      expect(tagLabels(await service.getCategoryDirectionOptouts(contextA, category))).toEqual(['home']);

      // The OTHER direction is untouched — still applies (no opt-out row for it).
      expect((await service.getCategoryDirectionOptouts(contextA, category)).map((t) => t.id)).not.toContain(
        work,
      );
    });

    it('re-enabling removes the opt-out row', async () => {
      const category = await seedTag(userA, 'career', { kind: 'category' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });

      await service.setCategoryDirectionEnabled(contextA, category, home, false);
      const reEnabled = await service.setCategoryDirectionEnabled(contextA, category, home, true);

      expect(reEnabled).toBe(true);
      expect(await service.getCategoryDirectionOptouts(contextA, category)).toEqual([]);
    });

    it('re-enabling an already-enabled direction is a harmless no-op', async () => {
      const category = await seedTag(userA, 'career', { kind: 'category' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });

      expect(await service.setCategoryDirectionEnabled(contextA, category, home, true)).toBe(true);
      expect(await service.getCategoryDirectionOptouts(contextA, category)).toEqual([]);
    });

    it('a NEW direction created after the opt-out is unaffected — it still applies', async () => {
      const category = await seedTag(userA, 'career', { kind: 'category' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });

      await service.setCategoryDirectionEnabled(contextA, category, home, false);

      // A direction that did not exist when the opt-out was written.
      await seedTag(userA, 'community', { kind: 'direction' });

      // Only home is opted out; the new direction was never written and is
      // therefore on by default — the entire point of opt-out polarity.
      expect(tagLabels(await service.getCategoryDirectionOptouts(contextA, category))).toEqual(['home']);
    });

    it('returns false when the category id is not a kind=category tag owned by the caller', async () => {
      const notACategory = await seedTag(userA, 'focus', { kind: 'intention' });
      const home = await seedTag(userA, 'home', { kind: 'direction' });

      expect(await service.setCategoryDirectionEnabled(contextA, notACategory, home, false)).toBe(false);
    });

    it('returns false when the direction id is not a kind=direction tag owned by the caller', async () => {
      const category = await seedTag(userA, 'career', { kind: 'category' });
      const notADirection = await seedTag(userA, 'focus', { kind: 'intention' });

      expect(await service.setCategoryDirectionEnabled(contextA, category, notADirection, false)).toBe(false);
    });
  });

  describe('entity_categories — positional, separate from entity_tag', () => {
    it('is empty with no assignment', async () => {
      expect(await service.getEntityCategories(contextA, { type: 'task', id: randomUUID() })).toEqual([]);
    });

    it('sets and reads back an ordered category set', async () => {
      const entityId = await seedTask(userA);
      const health = await seedTag(userA, 'health', { kind: 'category' });
      const career = await seedTag(userA, 'career', { kind: 'category' });

      const result = await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [
        health,
        career,
      ]);

      expect(result!.map((t) => t.label)).toEqual(['health', 'career']);
      expect(
        (await service.getEntityCategories(contextA, { type: 'task', id: entityId })).map((t) => t.label),
      ).toEqual(['health', 'career']);
    });

    it('a second call replaces rather than accumulates', async () => {
      const entityId = await seedTask(userA);
      const health = await seedTag(userA, 'health', { kind: 'category' });
      const career = await seedTag(userA, 'career', { kind: 'category' });

      await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [health, career]);
      await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [career]);

      expect(
        (await service.getEntityCategories(contextA, { type: 'task', id: entityId })).map((t) => t.label),
      ).toEqual(['career']);
    });

    it('caps at three and drops the rest', async () => {
      const entityId = await seedTask(userA);
      const ids = await Promise.all(
        ['health', 'career', 'relationships', 'growth'].map((label) =>
          seedTag(userA, label, { kind: 'category' }),
        ),
      );

      const result = await service.setEntityCategories(contextA, { type: 'task', id: entityId }, ids);

      expect(result).toHaveLength(3);
      expect(result!.map((t) => t.label)).toEqual(['health', 'career', 'relationships']);
    });

    it('de-duplicates repeated ids', async () => {
      const entityId = await seedTask(userA);
      const health = await seedTag(userA, 'health', { kind: 'category' });

      const result = await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [
        health,
        health,
        health,
      ]);

      expect(result).toHaveLength(1);
    });

    it("silently drops an id that is not the caller's own kind='category' tag", async () => {
      const entityId = await seedTask(userA);
      const health = await seedTag(userA, 'health', { kind: 'category' });
      const notACategory = await seedTag(userA, 'focus', { kind: 'intention' });
      const theirs = await seedTag(userB, 'career', { kind: 'category' });

      const result = await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [
        health,
        notACategory,
        theirs,
      ]);

      expect(result!.map((t) => t.label)).toEqual(['health']);
    });

    it("an empty replacement clears the entity's categories", async () => {
      const entityId = await seedTask(userA);
      const health = await seedTag(userA, 'health', { kind: 'category' });

      await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [health]);
      expect(await service.getEntityCategories(contextA, { type: 'task', id: entityId })).toHaveLength(1);

      await service.setEntityCategories(contextA, { type: 'task', id: entityId }, []);

      expect(await service.getEntityCategories(contextA, { type: 'task', id: entityId })).toEqual([]);
    });

    it('a category set on one entity is invisible on another', async () => {
      const entityA = await seedTask(userA);
      const entityB = await seedTask(userA);
      const health = await seedTag(userA, 'health', { kind: 'category' });

      await service.setEntityCategories(contextA, { type: 'task', id: entityA }, [health]);

      expect(await service.getEntityCategories(contextA, { type: 'task', id: entityA })).toHaveLength(1);
      expect(await service.getEntityCategories(contextA, { type: 'task', id: entityB })).toEqual([]);
    });
  });

  describe('categories never leak into getTagsForEntity (entity_tag stays byte-identical)', () => {
    it('an entity with BOTH entity_tag rows and entity_categories rows only returns the entity_tag tags', async () => {
      const entityId = await seedTask(userA);
      const plainTag = await seedTag(userA, 'urgent');
      const health = await seedTag(userA, 'health', { kind: 'category' });

      await assignTag(plainTag, 'task', entityId);
      await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [health]);
      expect(await service.getEntityCategories(contextA, { type: 'task', id: entityId })).toHaveLength(1);

      const tags = await service.getTagsForEntity(contextA, { type: 'task', id: entityId });

      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({ id: plainTag, label: 'urgent' });
      // Exactly the pre-taxonomy shape: id, label, taggedAt — no kind/muted/
      // isBase/level, no category, leaking through.
      expect(Object.keys(tags[0]).sort()).toEqual(['id', 'label', 'taggedAt']);
    });

    it('an entity with ONLY entity_categories rows (no entity_tag row) resolves no tags at all', async () => {
      const entityId = await seedTask(userA);
      const health = await seedTag(userA, 'health', { kind: 'category' });

      await service.setEntityCategories(contextA, { type: 'task', id: entityId }, [health]);
      expect(await service.getEntityCategories(contextA, { type: 'task', id: entityId })).toHaveLength(1);

      expect(await service.getTagsForEntity(contextA, { type: 'task', id: entityId })).toEqual([]);
    });
  });

  describe('is_base tags are undeletable', () => {
    it('remove() throws for a base tag rather than deleting it', async () => {
      const base = await seedTag(userA, 'home', { kind: 'direction', isBase: true });

      await expect(service.remove(contextA, base)).rejects.toThrow('Cannot delete a base tag');

      const [row] = await dataSource.query('SELECT id FROM ci_search.tags WHERE id = $1', [base]);
      expect(row).toBeDefined();
    });

    it('a non-base tag of the same kind deletes normally', async () => {
      const notBase = await seedTag(userA, 'side-project', { kind: 'direction', isBase: false });

      const result = await service.remove(contextA, notBase);

      expect(result).toMatchObject({ label: 'side-project' });
    });
  });
});

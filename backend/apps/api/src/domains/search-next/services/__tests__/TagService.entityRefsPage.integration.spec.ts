import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { EntityTagEntity } from '../../entities/EntityTagEntity';
import { TagEntity } from '../../entities/TagEntity';
import type { EntityIdentifier, TaggableEntity } from '../../types';
import { type TagEntityRefsPage, TagService } from '../TagService';

/**
 * `TagService.findEntityRefsPage` against a live Postgres: one page of a tag's
 * assignments at a time, newest first, seeking past the cursor assignment in
 * either direction, owner-scoped — without loading the tag's whole assignment
 * list.
 */
const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/TagService.entityRefsPage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`TagService.findEntityRefsPage against a live Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: TagService;
  const userA = randomUUID();
  const userB = randomUUID();
  const contextA = { userId: userA } as UserServiceContext;
  let tagId: string;
  /** Oldest first, as assigned. */
  const assigned: Array<EntityIdentifier<TaggableEntity>> = [];

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      entities: [TagEntity, EntityTagEntity],
      ...dataSourceConnection(),
    });
    await dataSource.initialize();
    service = new TagService(dataSource.getRepository(TagEntity), dataSource);

    tagId = randomUUID();
    await dataSource.query(`INSERT INTO ci_search.tags (id, label, user_id) VALUES ($1, 'holiday', $2)`, [
      tagId,
      userA,
    ]);

    for (const type of ['event', 'content', 'person', 'event', 'place'] as const) {
      const id = randomUUID();
      await dataSource.query(
        `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ($1, $2, $3)`,
        [type, id, tagId],
      );
      assigned.push({ type, id });
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        `DELETE FROM ci_search.entity_tag WHERE tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
        [[userA, userB]],
      );
      await dataSource.query('DELETE FROM ci_search.tags WHERE user_id = ANY($1::uuid[])', [[userA, userB]]);
      await dataSource.destroy();
    }
  });

  const refsOf = (page: {
    entities: Array<{ entityType: string; entityId: string }>;
  }): Array<EntityIdentifier<TaggableEntity>> =>
    page.entities.map((assignment) => ({
      type: assignment.entityType as TaggableEntity,
      id: assignment.entityId,
    }));
  const newestFirst = () => [...assigned].reverse();

  it('reads the newest assignments first, with a next page and no previous one', async () => {
    const page = (await service.findEntityRefsPage(contextA, tagId, { first: 2 }))!;

    expect(refsOf(page)).toEqual(newestFirst().slice(0, 2));
    expect(page.hasNextPage).toBe(true);
    expect(page.hasPreviousPage).toBe(false);
  });

  it('walks forward past the cursor assignment through every row exactly once', async () => {
    const seen: Array<EntityIdentifier<TaggableEntity>> = [];
    let after: EntityIdentifier<TaggableEntity> | null = null;

    for (;;) {
      const page: TagEntityRefsPage = (await service.findEntityRefsPage(contextA, tagId, {
        first: 2,
        after,
      }))!;
      seen.push(...refsOf(page));

      if (!page.hasNextPage) {
        break;
      }

      after = refsOf(page)[refsOf(page).length - 1];
    }

    expect(seen).toEqual(newestFirst());
  });

  it('pages backward from the end and from a cursor, in forward order', async () => {
    const all = newestFirst();

    const tail = (await service.findEntityRefsPage(contextA, tagId, { last: 2 }))!;
    expect(refsOf(tail)).toEqual(all.slice(-2));
    expect(tail.hasPreviousPage).toBe(true);
    expect(tail.hasNextPage).toBe(false);

    const before = (await service.findEntityRefsPage(contextA, tagId, { last: 2, before: all[3] }))!;
    expect(refsOf(before)).toEqual(all.slice(1, 3));
    expect(before.hasNextPage).toBe(true);
  });

  it('answers an empty page, never the first page, for a cursor that is not assigned to the tag', async () => {
    const page = (await service.findEntityRefsPage(contextA, tagId, {
      first: 2,
      after: { type: 'event', id: randomUUID() },
    }))!;

    expect(page.entities).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });

  it("is null for another owner's tag", async () => {
    await expect(
      service.findEntityRefsPage({ userId: userB } as UserServiceContext, tagId, { first: 2 }),
    ).resolves.toBeNull();
  });
});

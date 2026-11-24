import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { ServiceContext } from '@ci/common/context';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ThreadEntity } from '../../entities/ThreadEntity';
import { ThreadService } from '../ThreadService';

/**
 * `ThreadService.findPage` against a real Postgres: one page at a time, in
 * `findAll`'s order — most recently updated first, the id breaking ties —
 * over the caller's unarchived threads only. `updated_at` is nullable in the
 * table and NULLs lead a descending sort, which a mock cannot check.
 */
const ENV = { urlEnvVar: 'CONVERSATIONS_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ThreadService.findPage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ThreadService.findPage pages findAll's order from SQL (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ThreadService;
  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as ServiceContext;

  const rows = [
    { title: 'oldest', at: '2026-01-01T00:00:00.000100Z', archived: false },
    { title: 'tied-a', at: '2026-01-03T00:00:00.000100Z', archived: false },
    { title: 'tied-b', at: '2026-01-03T00:00:00.000100Z', archived: false },
    { title: 'archived', at: '2026-01-09T00:00:00.000100Z', archived: true },
    { title: 'never-updated', at: null, archived: false },
  ].map((row) => ({ ...row, id: uuidv7() }));

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [ThreadEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'ThreadService.findPage');
    const q = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
    await createSyntheticTestUser(q, 'ThreadService-findPage', ownerId);
    await createSyntheticTestUser(q, 'ThreadService-findPage-stranger', strangerId);
    service = new ThreadService(
      dataSource.getRepository(ThreadEntity),
      {} as never,
      { send: jest.fn(async () => []) } as never,
      { emit: jest.fn() } as never,
    );

    for (const row of rows) {
      await q(
        `INSERT INTO ci.threads (thread_id, user_id, title, updated_at, is_archived)
         VALUES ($1, $2, $3, $4::timestamptz, $5)`,
        [row.id, ownerId, row.title, row.at, row.archived],
      );
    }

    await q(`INSERT INTO ci.threads (thread_id, user_id, title) VALUES ($1, $2, 'not yours')`, [
      uuidv7(),
      strangerId,
    ]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.threads WHERE user_id = ANY($1::uuid[])', [
        [ownerId, strangerId],
      ]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const byTitle = (title: string) => rows.find((row) => row.title === title)!.id;
  /** NULL leads a descending sort; the tie's later-made row (a larger uuid v7) comes first under `id DESC`. */
  const expected = () => [byTitle('never-updated'), byTitle('tied-b'), byTitle('tied-a'), byTitle('oldest')];

  it("findAll lists the owner's live threads, most recently updated first", async () => {
    const all = await service.findAll(owner);

    expect(all.map((thread) => thread.id)).toEqual(expected());
  });

  it('walks forward in pages of two through exactly findAll, past the NULL and the tie', async () => {
    const seen: string[] = [];
    let afterId: string | null = null;

    for (;;) {
      const page = await service.findPage(owner, { first: 2, afterId });
      seen.push(...page.entities.map((thread) => thread.id));
      expect(page.totalCount).toBe(4);

      if (!page.hasNextPage) {
        break;
      }

      afterId = page.entities[page.entities.length - 1].id;
    }

    expect(seen).toEqual(expected());
  });

  it('pages backward from the last row, without counting when told not to', async () => {
    const page = await service.findPage(
      owner,
      { last: 2, beforeId: byTitle('oldest') },
      { countTotal: false },
    );

    expect(page.entities.map((thread) => thread.id)).toEqual([byTitle('tied-b'), byTitle('tied-a')]);
    expect(page.hasPreviousPage).toBe(true);
    expect(page.totalCount).toBeNull();
  });

  it('yields an empty page for a cursor that matches no row', async () => {
    const page = await service.findPage(owner, { first: 2, afterId: uuidv7() });

    expect(page.entities).toEqual([]);
  });
});

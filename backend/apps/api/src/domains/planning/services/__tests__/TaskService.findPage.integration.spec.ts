import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { TaskEntity } from '../../entities/TaskEntity';
import { TaskPendingChangeEntity } from '../../entities/TaskPendingChangeEntity';
import { TaskService } from '../TaskService';

/**
 * `TaskService.findPage` against a real Postgres: one page at a time, in
 * `findAll`'s order — soonest deadline first with the undated last, then
 * priority, newest first among equals, then the id — under the same filters
 * as the count. The NULL deadlines and the equal-deadline run are what a page
 * boundary can get wrong and a mock cannot check.
 */
const ENV = { urlEnvVar: 'PLANNING_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[TaskService.findPage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`TaskService.findPage pages findAll's order from SQL (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: TaskService;
  const ownerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  const rows = [
    { title: 'A', status: 'open', priority: 3, due: '2026-01-10T00:00:00Z', created: '2026-01-01T00:00:01Z' },
    { title: 'B', status: 'open', priority: 1, due: '2026-01-10T00:00:00Z', created: '2026-01-01T00:00:02Z' },
    { title: 'C', status: 'open', priority: 5, due: '2026-01-05T00:00:00Z', created: '2026-01-01T00:00:03Z' },
    { title: 'D', status: 'open', priority: 2, due: null, created: '2026-01-01T00:00:04Z' },
    { title: 'E', status: 'open', priority: 2, due: null, created: '2026-01-01T00:00:05Z' },
    { title: 'F', status: 'done', priority: 3, due: '2026-01-01T00:00:00Z', created: '2026-01-01T00:00:06Z' },
  ].map((row) => ({ ...row, id: uuidv7() }));

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [TaskEntity, TaskPendingChangeEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'TaskService.findPage');
    const q = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
    await createSyntheticTestUser(q, 'TaskService-findPage', ownerId);
    service = new TaskService(
      dataSource.getRepository(TaskEntity),
      dataSource.getRepository(TaskPendingChangeEntity),
      { find: async () => [] } as never,
      { send: async () => undefined } as unknown as EventService,
      { remove: async () => true } as never,
      noopLogger,
    );

    for (const row of rows) {
      await q(
        `INSERT INTO ci.tasks (id, user_id, title, status, priority, due_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
        [row.id, ownerId, row.title, row.status, row.priority, row.due, row.created],
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the tasks with the user.
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ownerId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const byTitle = (title: string) => rows.find((row) => row.title === title)!.id;
  const titles = (ids: string[]) => ids.map((id) => rows.find((row) => row.id === id)!.title);

  it('findAll sorts by deadline, then priority, newest first among equals, the undated last', async () => {
    const all = await service.findAll(owner);

    expect(titles(all.map((task) => task.id))).toEqual(['F', 'C', 'B', 'A', 'E', 'D']);
  });

  it('walks forward in pages of two through exactly findAll, across the equal-deadline and NULL runs', async () => {
    const seen: string[] = [];
    let afterId: string | null = null;

    for (;;) {
      const page = await service.findPage(owner, { first: 2, afterId });
      seen.push(...page.entities.map((task) => task.id));
      expect(page.totalCount).toBe(6);

      if (!page.hasNextPage) {
        break;
      }

      afterId = page.entities[page.entities.length - 1].id;
    }

    expect(titles(seen)).toEqual(['F', 'C', 'B', 'A', 'E', 'D']);
  });

  it('applies the same filter to the page and the count', async () => {
    const page = await service.findPage(owner, { first: 10 }, { status: ['open'] });

    expect(titles(page.entities.map((task) => task.id))).toEqual(['C', 'B', 'A', 'E', 'D']);
    expect(page.totalCount).toBe(5);
  });

  it('pages backward from a cursor inside the undated run', async () => {
    const page = await service.findPage(owner, { last: 2, beforeId: byTitle('D') }, { countTotal: false });

    expect(titles(page.entities.map((task) => task.id))).toEqual(['A', 'E']);
    expect(page.hasPreviousPage).toBe(true);
    expect(page.totalCount).toBeNull();
  });

  it('yields an empty page for a cursor that matches no row', async () => {
    const page = await service.findPage(owner, { first: 2, afterId: uuidv7() });

    expect(page.entities).toEqual([]);
  });
});

import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PersonEntity } from '../../entities/PersonEntity';
import { PersonService } from '../PersonService';

/**
 * `PersonService.findPage` against a real Postgres: one page at a time, in
 * `findAll`'s order — plausible names first, then by name with the nameless
 * last, newest first among equal names, then the id — with a seek past the
 * cursor row instead of the whole table. The order mixes directions and holds
 * NULLs and duplicates, which is exactly what a mock cannot check and a page
 * boundary can get wrong.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[PersonService.findPage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`PersonService.findPage pages findAll's order from SQL (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PersonService;
  let userId: string;
  let context: UserServiceContext;
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  /** Deliberately out of every order the query could fall back to by accident. */
  const rows = [
    { name: 'Carol', first: null, at: '2026-01-01T00:00:00.000100Z' },
    { name: 'Bob', first: null, at: '2026-01-02T00:00:00.000100Z' },
    { name: '+1 555 0100', first: null, at: '2026-01-03T00:00:00.000100Z' },
    { name: null, first: 'Nameless', at: '2026-01-04T00:00:00.000100Z' },
    { name: 'Bob', first: null, at: '2026-01-05T00:00:00.000100Z' },
    { name: 'Alice', first: null, at: '2026-01-06T00:00:00.000100Z' },
    { name: 'Zed', first: 'Bobby', at: '2026-01-07T00:00:00.000100Z' },
  ].map((row) => ({ ...row, id: uuidv7() }));

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [BaseEntity, PersonEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PersonService.findPage');
    userId = await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params),
      'PersonService-findPage',
    );
    context = { userId } as UserServiceContext;
    service = new PersonService(dataSource.getRepository(PersonEntity), noopLogger, {
      send: jest.fn(async () => []),
    } as unknown as EventService);

    for (const row of rows) {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, created_at, updated_at)
         VALUES ($1, 'Person', $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz)`,
        [row.id, userId, row.name, JSON.stringify(row.first ? { first_name: row.first } : {}), row.at],
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const byName = (name: string | null, at?: string) =>
    rows.find((row) => row.name === name && (!at || row.at === at))!.id;

  it('findAll puts plausible names first, equal names newest first, and the nameless last', async () => {
    const all = await service.findAll(context);

    expect(all.map((person) => person.id)).toEqual([
      byName('Alice'),
      byName('Bob', '2026-01-05T00:00:00.000100Z'),
      byName('Bob', '2026-01-02T00:00:00.000100Z'),
      byName('Carol'),
      byName('Zed'),
      byName('+1 555 0100'),
      byName(null),
    ]);
  });

  it('walks forward in pages of two through exactly findAll, across the equal-name and NULL-name boundaries', async () => {
    const expected = (await service.findAll(context)).map((person) => person.id);
    const seen: string[] = [];
    let afterId: string | null = null;
    let hasPreviousPage: boolean[] = [];

    for (;;) {
      const page = await service.findPage(context, { first: 2, afterId }, { countTotal: false });
      seen.push(...page.entities.map((person) => person.id));
      hasPreviousPage = [...hasPreviousPage, page.hasPreviousPage];
      expect(page.totalCount).toBeNull();

      if (!page.hasNextPage) {
        break;
      }

      afterId = page.entities[page.entities.length - 1].id;
    }

    expect(seen).toEqual(expected);
    expect(hasPreviousPage).toEqual([false, true, true, true]);
  });

  it('pages of one through the two Bobs lose neither and repeat neither', async () => {
    const newer = byName('Bob', '2026-01-05T00:00:00.000100Z');
    const older = byName('Bob', '2026-01-02T00:00:00.000100Z');

    const first = await service.findPage(context, { first: 1, afterId: byName('Alice') });
    const second = await service.findPage(context, { first: 1, afterId: first.entities[0].id });
    const third = await service.findPage(context, { first: 1, afterId: second.entities[0].id });

    expect([first.entities[0].id, second.entities[0].id, third.entities[0].id]).toEqual([
      newer,
      older,
      byName('Carol'),
    ]);
  });

  it('pages backward: the last two, then the two before a cursor', async () => {
    const all = (await service.findAll(context)).map((person) => person.id);

    const tail = await service.findPage(context, { last: 2 });
    expect(tail.entities.map((person) => person.id)).toEqual(all.slice(-2));
    expect(tail.hasPreviousPage).toBe(true);
    expect(tail.hasNextPage).toBe(false);

    const before = await service.findPage(context, { last: 2, beforeId: all[4] });
    expect(before.entities.map((person) => person.id)).toEqual(all.slice(2, 4));
    expect(before.hasNextPage).toBe(true);
  });

  it('filters by name or structured first name, counting only the matches, and only when asked', async () => {
    const counted = await service.findPage(context, { first: 10 }, { query: 'bo', countTotal: true });

    expect(counted.entities.map((person) => person.id)).toEqual([
      byName('Bob', '2026-01-05T00:00:00.000100Z'),
      byName('Bob', '2026-01-02T00:00:00.000100Z'),
      byName('Zed'), // first_name "Bobby"
    ]);
    expect(counted.totalCount).toBe(3);

    const byDefault = await service.findPage(context, { first: 1 }, { query: 'bo' });
    expect(byDefault.totalCount).toBe(3);
    expect(byDefault.hasNextPage).toBe(true);
  });

  it('answers an empty page, never the first page, for a cursor that matches no row', async () => {
    const page = await service.findPage(context, { first: 2, afterId: uuidv7() }, { countTotal: true });

    expect(page.entities).toEqual([]);
    expect(page.hasNextPage).toBe(false);
    expect(page.totalCount).toBe(rows.length);
  });

  it("never lists another owner's people", async () => {
    const page = await service.findPage({ userId: uuidv7() } as UserServiceContext, { first: 10 });

    expect(page.entities).toEqual([]);
    expect(page.totalCount).toBe(0);
  });
});

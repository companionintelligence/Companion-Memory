import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PlaceEntity } from '../../entities/PlaceEntity';
import { PlaceService } from '../PlaceService';

/**
 * `PlaceService.findPage` against a real Postgres: one page at a time, in
 * `findAll`'s order (by name with the nameless last, newest first among equal
 * names, then the id), seeking past the cursor row — and, with the `user` join
 * gone from the list, the owner still reported off the row itself.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[PlaceService.findPage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`PlaceService.findPage pages findAll's order from SQL (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PlaceService;
  let userId: string;
  let context: UserServiceContext;

  const rows = [
    { name: 'Home', at: '2026-02-01T00:00:00.000100Z' },
    { name: 'Cafe', at: '2026-02-02T00:00:00.000100Z' },
    { name: null, at: '2026-02-03T00:00:00.000100Z' },
    { name: 'Cafe', at: '2026-02-04T00:00:00.000100Z' },
    { name: 'Airport', at: '2026-02-05T00:00:00.000100Z' },
  ].map((row) => ({ ...row, id: uuidv7() }));

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [BaseEntity, UserEntity, PlaceEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PlaceService.findPage');
    userId = await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params),
      'PlaceService-findPage',
    );
    context = { userId } as UserServiceContext;
    service = new PlaceService(
      dataSource.getRepository(PlaceEntity),
      { send: async () => [] } as never,
      {} as never,
    );

    for (const row of rows) {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, created_at, updated_at)
         VALUES ($1, 'Location', $2, $3, '{}'::jsonb, $4::timestamptz, $4::timestamptz)`,
        [row.id, userId, row.name, row.at],
      );
    }

    // A tombstone and a forgotten place: neither is listed.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, merged_into_entity_id)
       VALUES ($1, 'Location', $2, 'Cafe (merged)', $3)`,
      [uuidv7(), userId, rows[1].id],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, is_active)
       VALUES ($1, 'Location', $2, 'Forgotten', false)`,
      [uuidv7(), userId],
    );
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

  it('findAll orders by name, equal names newest first, the nameless last, and skips tombstones and forgotten places', async () => {
    const all = await service.findAll(context);

    expect(all.map((place) => place.id)).toEqual([
      byName('Airport'),
      byName('Cafe', '2026-02-04T00:00:00.000100Z'),
      byName('Cafe', '2026-02-02T00:00:00.000100Z'),
      byName('Home'),
      byName(null),
    ]);
  });

  it('reports the owner off the row, with no user join', async () => {
    const page = await service.findPage(context, { first: 1 });

    // `userId` is what the egress shape carries; the `Place` type does not name it.
    expect((page.entities[0] as { userId?: string | null }).userId).toBe(userId);
  });

  it('walks forward in pages of two through exactly findAll', async () => {
    const expected = (await service.findAll(context)).map((place) => place.id);
    const seen: string[] = [];
    let afterId: string | null = null;

    for (;;) {
      const page = await service.findPage(context, { first: 2, afterId }, { countTotal: false });
      seen.push(...page.entities.map((place) => place.id));
      expect(page.totalCount).toBeNull();

      if (!page.hasNextPage) {
        break;
      }

      afterId = page.entities[page.entities.length - 1].id;
    }

    expect(seen).toEqual(expected);
  });

  it('pages backward from the end and from a cursor', async () => {
    const all = (await service.findAll(context)).map((place) => place.id);

    const tail = await service.findPage(context, { last: 2 });
    expect(tail.entities.map((place) => place.id)).toEqual(all.slice(-2));

    const before = await service.findPage(context, { last: 2, beforeId: all[3] });
    expect(before.entities.map((place) => place.id)).toEqual(all.slice(1, 3));
  });

  it('filters by name and counts only the matches, only when asked', async () => {
    const page = await service.findPage(context, { first: 10 }, { query: 'caf', countTotal: true });

    expect(page.entities.map((place) => place.name)).toEqual(['Cafe', 'Cafe']);
    expect(page.totalCount).toBe(2);
  });

  it('answers an empty page for a cursor that matches no row', async () => {
    const page = await service.findPage(context, { first: 2, afterId: uuidv7() });

    expect(page.entities).toEqual([]);
    expect(page.hasNextPage).toBe(false);
    expect(page.totalCount).toBe(rows.length);
  });
});

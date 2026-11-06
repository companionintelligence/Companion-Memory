import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { ServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { NoteEntity } from '../../entities/NoteEntity';
import { NoteService } from '../NoteService';

/**
 * `NoteService.findPage` against a real Postgres: one page at a time, in
 * `findAll`'s order — last edited first, the id breaking ties — with a seek
 * past the cursor row instead of the whole table, scoped to the caller.
 */
const ENV = { urlEnvVar: 'NOTES_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[NoteService.findPage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`NoteService.findPage pages findAll's order from SQL (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: NoteService;
  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as ServiceContext;
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  /** Two notes edited at the same instant, so the id has to break the tie. */
  const rows = [
    { title: 'oldest', at: '2026-01-01T00:00:00.000100Z' },
    { title: 'tied-a', at: '2026-01-03T00:00:00.000100Z' },
    { title: 'tied-b', at: '2026-01-03T00:00:00.000100Z' },
    { title: 'newest', at: '2026-01-05T00:00:00.000100Z' },
    { title: 'middle', at: '2026-01-02T00:00:00.000100Z' },
  ].map((row) => ({ ...row, id: uuidv7() }));

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [NoteEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'NoteService.findPage');
    const q = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
    await createSyntheticTestUser(q, 'NoteService-findPage', ownerId);
    await createSyntheticTestUser(q, 'NoteService-findPage-stranger', strangerId);
    service = new NoteService(
      dataSource.getRepository(NoteEntity),
      { send: jest.fn(async () => []) } as unknown as EventService,
      noopLogger,
    );

    for (const row of rows) {
      await q(
        `INSERT INTO ci.notes (id, title, content, user_id, created_at, updated_at)
         VALUES ($1, $2, '', $3, $4::timestamptz, $4::timestamptz)`,
        [row.id, row.title, ownerId, row.at],
      );
    }

    await q(`INSERT INTO ci.notes (id, title, content, user_id) VALUES ($1, 'not yours', '', $2)`, [
      uuidv7(),
      strangerId,
    ]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.notes WHERE user_id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const byTitle = (title: string) => rows.find((row) => row.title === title)!.id;
  /** uuid v7 ids sort by creation, so the tie's later-made row comes first under `id DESC`. */
  const tiedFirst = byTitle('tied-b');
  const tiedSecond = byTitle('tied-a');

  it("findAll lists the owner's notes last edited first, the tie broken by id", async () => {
    const all = await service.findAll(owner);

    expect(all.map((note) => note.id)).toEqual([
      byTitle('newest'),
      tiedFirst,
      tiedSecond,
      byTitle('middle'),
      byTitle('oldest'),
    ]);
  });

  it('walks forward in pages of two through exactly findAll, counting once', async () => {
    const expected = (await service.findAll(owner)).map((note) => note.id);
    const seen: string[] = [];
    const previous: boolean[] = [];
    let afterId: string | null = null;

    for (;;) {
      const page = await service.findPage(owner, { first: 2, afterId });
      seen.push(...page.entities.map((note) => note.id));
      previous.push(page.hasPreviousPage);
      expect(page.totalCount).toBe(5);

      if (!page.hasNextPage) {
        break;
      }

      afterId = page.entities[page.entities.length - 1].id;
    }

    expect(seen).toEqual(expected);
    expect(previous).toEqual([false, true, true]);
  });

  it('pages backward from a cursor inside the tie', async () => {
    const page = await service.findPage(
      owner,
      { last: 2, beforeId: byTitle('middle') },
      { countTotal: false },
    );

    expect(page.entities.map((note) => note.id)).toEqual([tiedFirst, tiedSecond]);
    expect(page.hasPreviousPage).toBe(true);
    expect(page.hasNextPage).toBe(true);
    expect(page.totalCount).toBeNull();
  });

  it('yields an empty page for a cursor that matches no row', async () => {
    const page = await service.findPage(owner, { first: 2, afterId: uuidv7() });

    expect(page.entities).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });
});

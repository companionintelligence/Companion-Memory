import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { NoteEntity } from '../entities/NoteEntity';
import { NoteService } from '../services/NoteService';

/**
 * `NoteService.create` (GraphQL `createNote`) against a real Postgres.
 *
 * `NoteService.spec.ts` mocks the repository. A mock cannot show what these tests are
 * about: `ci.notes.id` has no default, so a create that loses its minted id fails in
 * the database. A client-minted id that is already taken must not be written over,
 * whoever owns the row.
 *
 * Same database setup as `NoteCapture.integration.spec.ts`: `NOTES_TEST_DATABASE_URL`,
 * else `DATABASE_URL`, else `.env`'s `DATABASE_*` values. With none answering, it
 * skips and says why.
 */

const DATABASE_ENV = {
  urlEnvVar: 'NOTES_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'NOTES_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[notes/NoteCreate.integration] SKIPPED: ${availability.reason}`);
}

describeWithDb('NoteService.create in Postgres', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: NoteService;

  // Fresh per run, so two concurrent runs cannot collide on ci.users.
  const owner: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const stranger: UserServiceContext = { userId: uuidv7() } as UserServiceContext;

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [NoteEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'NoteCreate.integration');

    for (const [context, name] of [
      [owner, 'Owner'],
      [stranger, 'Stranger'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email)
              VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [context.userId, `${name} spec fixture`, `${name.toLowerCase()}.${context.userId}@example.invalid`],
      );
    }

    service = new NoteService(
      dataSource.getRepository(NoteEntity),
      { send } as unknown as EventService,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [owner.userId, stranger.userId];

      // ci.notes.user_id REFERENCES ci.users(id) with no cascade: notes first.
      await dataSource.query('DELETE FROM ci.notes WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  beforeEach(() => {
    send.mockClear();
  });

  const readNote = async (id: string) => {
    const [row] = await dataSource.query('SELECT id, title, content, user_id FROM ci.notes WHERE id = $1', [
      id,
    ]);

    return row as { id: string; title: string; content: string; user_id: string } | undefined;
  };

  it('stores a note the client sent no id for (createNote passes id: undefined)', async () => {
    const note = await service.create(owner, {
      id: undefined,
      title: 'Shopping list',
      content: '<p>eggs</p>',
    });

    expect(note?.id).toEqual(expect.any(String));

    const row = await readNote(note!.id);

    expect(row?.user_id).toBe(owner.userId);
    expect(row?.content).toBe('<p>eggs</p>');
    expect(send).toHaveBeenCalledWith('note.created', { noteId: note!.id });
  });

  it('keeps a client-minted id and a replay of it stays one row', async () => {
    const id = uuidv7();

    const first = await service.create(owner, { id, title: 'Offline', content: '<p>first</p>' });
    const replay = await service.create(owner, { id, title: 'Offline', content: '<p>first</p>' });

    const [{ count }] = await dataSource.query('SELECT COUNT(*)::int AS count FROM ci.notes WHERE id = $1', [
      id,
    ]);

    expect(count).toBe(1);
    expect((await readNote(id))?.user_id).toBe(owner.userId);

    // createNote's NoteType.createdAt and updatedAt are non-null, so a replay has to
    // hand back the stored timestamps (save() on an existing row returned neither).
    expect(first?.createdAt).toEqual(expect.any(Date));
    expect(replay?.createdAt).toEqual(first?.createdAt);
    expect(replay?.updatedAt).toEqual(expect.any(Date));
  });

  it('a replayed create does not write over an edit made since it first landed', async () => {
    const id = uuidv7();

    await service.create(owner, { id, title: 'Offline', content: '<p>first</p>' });
    await service.update(owner, id, { content: '<p>edited on the web</p>' });

    const replay = await service.create(owner, { id, title: 'Offline', content: '<p>first</p>' });

    expect(replay?.content).toBe('<p>edited on the web</p>');
    expect((await readNote(id))?.content).toBe('<p>edited on the web</p>');
  });

  it("refuses a client-minted id that is another user's note and leaves their note alone", async () => {
    const id = uuidv7();

    await service.create(stranger, { id, title: 'Theirs', content: '<p>theirs</p>' });
    send.mockClear();

    const note = await service.create(owner, { id, title: 'Mine', content: '<p>mine now</p>' });

    expect(note).toBeNull();

    const row = await readNote(id);

    expect(row?.user_id).toBe(stranger.userId);
    expect(row?.title).toBe('Theirs');
    expect(row?.content).toBe('<p>theirs</p>');
    expect(send).not.toHaveBeenCalled();
  });
});

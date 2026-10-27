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
 * `NoteService.updateIfUnchanged` (GraphQL `updateNote` with `expectedUpdatedAt`) against
 * a real Postgres.
 *
 * The guard is one UPDATE whose WHERE compares `updated_at` to the millisecond. A mock
 * cannot show that the comparison holds against what Postgres stores (microseconds), or
 * that a note changed in between is left alone.
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
  console.warn(`[notes/NoteUpdate.integration] SKIPPED: ${availability.reason}`);
}

describeWithDb('NoteService.updateIfUnchanged in Postgres', () => {
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

    schemaLock = await acquireSchemaWriteLock(dataSource, 'NoteUpdate.integration');

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
    const [row] = await dataSource.query('SELECT content, user_id FROM ci.notes WHERE id = $1', [id]);

    return row as { content: string; user_id: string } | undefined;
  };

  it('writes when the note still has the updatedAt the caller saw, to the millisecond', async () => {
    const note = await service.create(owner, {
      id: uuidv7(),
      title: 'Trip ideas',
      content: '<p>Trip ideas</p>',
    });
    send.mockClear();

    // The Date the API handed out, which drops the microseconds Postgres keeps.
    const outcome = await service.updateIfUnchanged(
      owner,
      note!.id,
      { title: 'Trip ideas', content: '<p>Trip ideas in May</p>' },
      note!.updatedAt,
    );

    expect(outcome?.written).toBe(true);
    expect(outcome?.note.content).toBe('<p>Trip ideas in May</p>');
    expect(outcome!.note.updatedAt.getTime()).toBeGreaterThanOrEqual(note!.updatedAt.getTime());
    expect((await readNote(note!.id))?.content).toBe('<p>Trip ideas in May</p>');
    expect(send).toHaveBeenCalledWith('note.updated', { noteId: note!.id });

    // The updatedAt that came back is the next base: a second guarded write with it lands too.
    const again = await service.updateIfUnchanged(
      owner,
      note!.id,
      { content: '<p>Trip ideas in May and June</p>' },
      outcome!.note.updatedAt,
    );

    expect(again?.written).toBe(true);
  });

  it('leaves a note that changed since alone and hands back what is stored', async () => {
    const note = await service.create(owner, { id: uuidv7(), title: 'Shopping', content: '<p>Shopping</p>' });

    // Another device saves first. Written here with an updated_at a few milliseconds on,
    // because the create and an ordinary update can share a millisecond in a test.
    await dataSource.query(
      `UPDATE ci.notes
          SET content = '<p>Shopping: milk, from the phone</p>',
              updated_at = updated_at + interval '5 milliseconds'
        WHERE id = $1`,
      [note!.id],
    );
    send.mockClear();

    const outcome = await service.updateIfUnchanged(
      owner,
      note!.id,
      { content: '<p>Shopping: eggs, typed during the outage</p>' },
      note!.updatedAt,
    );

    expect(outcome?.written).toBe(false);
    expect(outcome?.note.content).toBe('<p>Shopping: milk, from the phone</p>');
    expect((await readNote(note!.id))?.content).toBe('<p>Shopping: milk, from the phone</p>');
    expect(send).not.toHaveBeenCalled();
  });

  it("returns null for another user's note and does not touch it", async () => {
    const note = await service.create(stranger, { id: uuidv7(), title: 'Theirs', content: '<p>theirs</p>' });
    send.mockClear();

    const outcome = await service.updateIfUnchanged(
      owner,
      note!.id,
      { content: '<p>mine now</p>' },
      note!.updatedAt,
    );

    expect(outcome).toBeNull();
    expect(await readNote(note!.id)).toEqual({ content: '<p>theirs</p>', user_id: stranger.userId });
    expect(send).not.toHaveBeenCalled();
  });
});

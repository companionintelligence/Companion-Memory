import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { NoteEntity } from '../entities/NoteEntity';
import { NoteService } from '../services/NoteService';

/**
 * `captureMany`'s three guards, proved against a real Postgres.
 *
 * `NoteService.spec.ts` covers the classification and the event fan-out, but it does
 * so against a mock that re-implements the ON CONFLICT predicates in TypeScript. That
 * is the wrong place for these three properties to live: they ARE the SQL, and a mock
 * agreeing with the code that wrote it proves only that both were written by the same
 * person. Both tests matter — the unit one catches a dropped branch at review time,
 * this one catches a predicate that is present but wrong.
 *
 * What each guard has to hold in the database:
 *
 *  1. a replay of a stored snapshot writes nothing and raises nothing — outbox
 *     delivery is at-least-once, so this is the ordinary case, not the exotic one;
 *  2. a snapshot older than the stored row does not overwrite it;
 *  3. an id belonging to another user is never written through — the failure a
 *     client-minted primary key makes reachable in the first place.
 *
 * Opt-in: set `NOTES_TEST_DATABASE_URL` to a database with the migrations applied.
 * The rest of the notes suite mocks its repository, so this must not be a hard
 * dependency of `yarn test`.
 *
 *   NOTES_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest NoteCapture.integration
 *
 * No scratch database here, unlike `pipeline/__tests__/harness/scratchDatabase.ts`.
 * That harness exists for suites that apply a real MIGRATION, whose DDL takes
 * `ACCESS EXCLUSIVE` and cannot share a database with anything. This suite only
 * writes rows, under users it creates for itself, so it takes the shared write lock
 * and cleans up after itself like every other DB-backed domain spec.
 */

const DATABASE_URL = process.env.NOTES_TEST_DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('NoteService.captureMany — the guards, in Postgres', () => {
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

  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [NoteEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits rows in ci.notes / ci.users, which a migration
    // suite may be altering inside its own transaction. See
    // `domains/__tests__/support/schemaLock.ts`.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'NoteCapture.integration');

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

      // ci.notes.user_id REFERENCES ci.users(id) with NO cascade, so the notes must
      // go first or the user delete fails on the FK.
      await dataSource.query('DELETE FROM ci.notes WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  beforeEach(() => {
    send.mockClear();
  });

  const readNote = async (id: string) => {
    const [row] = await dataSource.query(
      'SELECT id, title, content, user_id, created_at, updated_at FROM ci.notes WHERE id = $1',
      [id],
    );

    return row as
      | { id: string; title: string; content: string; user_id: string; created_at: Date; updated_at: Date }
      | undefined;
  };

  it('inserts a client-minted note, dating it from the capture instant', async () => {
    const id = uuidv7();
    const capturedAt = at('2026-08-13T09:00:00.000Z');

    const result = await service.captureMany(owner, [
      { id, title: 'Groceries', content: '<p>Groceries</p>', capturedAt },
    ]);

    expect(result.created).toEqual([id]);

    const row = await readNote(id);

    expect(row?.content).toBe('<p>Groceries</p>');
    expect(row?.user_id).toBe(owner.userId);
    // A note written offline last night belongs to last night, not to the drain.
    expect(row?.created_at.toISOString()).toBe('2026-08-13T09:00:00.000Z');
    expect(row?.updated_at.toISOString()).toBe('2026-08-13T09:00:00.000Z');
  });

  it('GUARD 1 — an at-least-once replay writes nothing and raises nothing', async () => {
    const id = uuidv7();
    const snapshot = { id, title: 'G', content: '<p>G</p>', capturedAt: at('2026-08-13T09:00:00.000Z') };

    await service.captureMany(owner, [snapshot]);

    // Exactly what happens when an /attempt report is lost: the row survives in the
    // queue and the same snapshot is delivered a second time. A plain INSERT would
    // raise a unique violation here, which the flusher reads as transient and retries
    // to exhaustion — a safely-stored note parked in needs_attention.
    const replay = await service.captureMany(owner, [snapshot]);

    expect(replay).toEqual({ created: [], updated: [], stale: [id], conflicted: [] });

    const [{ count }] = await dataSource.query('SELECT COUNT(*)::int AS count FROM ci.notes WHERE id = $1', [
      id,
    ]);

    expect(count).toBe(1);
  });

  it('GUARD 2 — a snapshot older than the stored row does not overwrite it', async () => {
    const id = uuidv7();

    await service.captureMany(owner, [
      { id, content: '<p>newer</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    const result = await service.captureMany(owner, [
      { id, content: '<p>older</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    expect(result.stale).toEqual([id]);
    expect((await readNote(id))?.content).toBe('<p>newer</p>');
  });

  it('GUARD 2 — a newer snapshot does advance the row, without moving created_at', async () => {
    const id = uuidv7();

    await service.captureMany(owner, [
      { id, content: '<p>first</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    const result = await service.captureMany(owner, [
      { id, content: '<p>second</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    expect(result.updated).toEqual([id]);

    const row = await readNote(id);

    expect(row?.content).toBe('<p>second</p>');
    expect(row?.updated_at.toISOString()).toBe('2026-08-13T12:00:00.000Z');
    // The insert branch owns created_at; an update must not move it.
    expect(row?.created_at.toISOString()).toBe('2026-08-13T09:00:00.000Z');
  });

  it("GUARD 3 — another user's id is never written through, and their row is untouched", async () => {
    const id = uuidv7();

    await service.captureMany(stranger, [
      { id, title: 'Theirs', content: '<p>theirs</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    // Seeding the stranger's note emitted its own note.created; only what the refused
    // capture below emits is under test.
    send.mockClear();

    // The write `repository.save()` would allow: a colliding client-minted id
    // rewriting a stranger's note AND reassigning its user_id.
    const result = await service.captureMany(owner, [
      { id, title: 'Mine', content: '<p>mine now</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    expect(result).toEqual({ created: [], updated: [], stale: [], conflicted: [id] });

    const row = await readNote(id);

    expect(row?.user_id).toBe(stranger.userId);
    expect(row?.content).toBe('<p>theirs</p>');
    expect(row?.title).toBe('Theirs');
    expect(send).not.toHaveBeenCalled();
  });

  it('writes a mixed batch in one statement, reporting each id accurately', async () => {
    const fresh = uuidv7();
    const owned = uuidv7();
    const foreign = uuidv7();

    await service.captureMany(owner, [
      { id: owned, content: '<p>v1</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);
    await service.captureMany(stranger, [
      { id: foreign, content: '<p>theirs</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    send.mockClear();

    const result = await service.captureMany(owner, [
      { id: fresh, content: '<p>new</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
      { id: owned, content: '<p>v2</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
      { id: foreign, content: '<p>mine now</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    expect(result.created).toEqual([fresh]);
    expect(result.updated).toEqual([owned]);
    expect(result.conflicted).toEqual([foreign]);

    expect((await readNote(fresh))?.content).toBe('<p>new</p>');
    expect((await readNote(owned))?.content).toBe('<p>v2</p>');
    // Unharmed by travelling in the same batch as two writable rows.
    expect((await readNote(foreign))?.content).toBe('<p>theirs</p>');

    // One created + one updated, and nothing for the refused id.
    expect(send.mock.calls.map(([event]) => event)).toEqual(['note.created', 'note.updated']);
  });
});

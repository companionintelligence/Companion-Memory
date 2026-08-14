import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';

import {
  ScratchDatabase,
  resolveAdminConnection,
  scratchDatabaseAvailability,
} from '../../pipeline/__tests__/harness/scratchDatabase';
import { NoteEntity } from '../entities/NoteEntity';
import { NoteService } from '../services/NoteService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `captureMany`'s three guards, against a real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `NoteService.spec.ts` covers the classification and the event fan-out, but it
 * does so against a mock that re-implements the ON CONFLICT predicates in
 * TypeScript. That is the wrong place for these three properties to be proven:
 * they ARE the SQL, and a mock agreeing with the code that wrote it proves only
 * that both were written by the same person.
 *
 * What matters here is that each guard holds in the database:
 *
 *  1. a replay of a stored snapshot writes nothing and raises nothing (the
 *     outbox delivers at-least-once, so this is the ordinary case);
 *  2. a snapshot older than the stored row does not overwrite it;
 *  3. an id belonging to another user is never written through — the failure
 *     a client-minted primary key makes reachable in the first place.
 *
 * Runs against a database created for this run and dropped after it, never the
 * operator's archive — see `scratchDatabase.ts`. SKIPS without an admin
 * credential (`DATABASE_ADMIN_PASSWORD`), because the alternative is the
 * application connection, which is the archive.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

const CONTEXT = { userId: USER } as UserServiceContext;
const OTHER_CONTEXT = { userId: OTHER_USER } as UserServiceContext;

/** Distinct v7-shaped id per case, so no test can be perturbed by another. */
const noteId = (n: number) => `01920000-0000-7000-8000-00000000000${n}`;

const at = (iso: string) => new Date(iso);

describeWithDatabase('NoteService.captureMany — the guards, in Postgres', () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let service: NoteService;
  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'NoteCapture.integration.spec' });

    // The harness connection maps no entities (the pipeline speaks raw SQL), and
    // NoteService needs a repository. Same server, same scratch database, NoteEntity
    // registered — `synchronize` stays off, so the migrations remain the only schema.
    const admin = resolveAdminConnection();

    if (!admin) {
      throw new Error('scratchDatabaseAvailability() said available but no admin connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      host: admin.host,
      port: admin.port,
      username: admin.username,
      password: admin.password,
      database: scratch.name,
      entities: [NoteEntity],
      synchronize: false,
    });

    await dataSource.initialize();
    await scratch.assertOwn();

    // ci.notes.user_id is a real FK; everything else on ci.users defaults.
    await dataSource.query('INSERT INTO ci.users (id) VALUES ($1), ($2)', [USER, OTHER_USER]);

    service = new NoteService(
      dataSource.getRepository(NoteEntity),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { send } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
    );
  }, 600_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await scratch?.drop();
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
    const id = noteId(1);
    const capturedAt = at('2026-08-13T09:00:00.000Z');

    const result = await service.captureMany(CONTEXT, [
      { id, title: 'Groceries', content: '<p>Groceries</p>', capturedAt },
    ]);

    expect(result.created).toEqual([id]);

    const row = await readNote(id);

    expect(row?.content).toBe('<p>Groceries</p>');
    expect(row?.user_id).toBe(USER);
    // A note written offline last night belongs to last night, not to the drain.
    expect(row?.created_at.toISOString()).toBe('2026-08-13T09:00:00.000Z');
    expect(row?.updated_at.toISOString()).toBe('2026-08-13T09:00:00.000Z');
  });

  it('GUARD 1 — an at-least-once replay writes nothing and raises nothing', async () => {
    const id = noteId(2);
    const capturedAt = at('2026-08-13T09:00:00.000Z');
    const snapshot = { id, title: 'G', content: '<p>G</p>', capturedAt };

    await service.captureMany(CONTEXT, [snapshot]);

    // Exactly what happens when an /attempt report is lost: the row survives in the
    // queue and the same snapshot is delivered a second time. A plain INSERT would
    // raise a unique violation here, which the flusher reads as transient and retries
    // to exhaustion — a safely-stored note parked in needs_attention.
    const replay = await service.captureMany(CONTEXT, [snapshot]);

    expect(replay).toEqual({ created: [], updated: [], stale: [id], conflicted: [] });

    const [{ count }] = await dataSource.query('SELECT COUNT(*)::int AS count FROM ci.notes WHERE id = $1', [
      id,
    ]);

    expect(count).toBe(1);
  });

  it('GUARD 2 — a snapshot older than the stored row does not overwrite it', async () => {
    const id = noteId(3);

    await service.captureMany(CONTEXT, [
      { id, content: '<p>newer</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    const result = await service.captureMany(CONTEXT, [
      { id, content: '<p>older</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    expect(result.stale).toEqual([id]);
    expect((await readNote(id))?.content).toBe('<p>newer</p>');
  });

  it('GUARD 2 — a newer snapshot does advance the row', async () => {
    const id = noteId(4);

    await service.captureMany(CONTEXT, [
      { id, content: '<p>first</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    const result = await service.captureMany(CONTEXT, [
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
    const id = noteId(5);

    await service.captureMany(OTHER_CONTEXT, [
      { id, title: 'Theirs', content: '<p>theirs</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    // Seeding the other user's note emitted its own note.created; only what the
    // refused capture below emits is under test.
    send.mockClear();

    // The attack `repository.save()` would allow: a colliding client-minted id
    // rewriting a stranger's note AND reassigning its user_id.
    const result = await service.captureMany(CONTEXT, [
      { id, title: 'Mine', content: '<p>mine now</p>', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    expect(result).toEqual({ created: [], updated: [], stale: [], conflicted: [id] });

    const row = await readNote(id);

    expect(row?.user_id).toBe(OTHER_USER);
    expect(row?.content).toBe('<p>theirs</p>');
    expect(row?.title).toBe('Theirs');
    expect(send).not.toHaveBeenCalled();
  });

  it('writes a mixed batch in one statement, reporting each id accurately', async () => {
    const fresh = noteId(6);
    const owned = noteId(7);
    const foreign = noteId(8);

    await service.captureMany(CONTEXT, [
      { id: owned, content: '<p>v1</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);
    await service.captureMany(OTHER_CONTEXT, [
      { id: foreign, content: '<p>theirs</p>', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    send.mockClear();

    const result = await service.captureMany(CONTEXT, [
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

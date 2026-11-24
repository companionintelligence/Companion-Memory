import type { UserServiceContext } from '@ci/common/context';

import { NoteEntity } from '../entities/NoteEntity';

import { NoteService } from './NoteService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/**
 * `takenIds` stands in for rows already in `ci.notes`: under `orIgnore()` an insert of
 * one of those ids returns no row, which is how Postgres reports ON CONFLICT DO NOTHING.
 */
function makeInsertBuilder(
  record: { values?: unknown; inserted: boolean },
  takenIds: ReadonlySet<string> = new Set(),
) {
  const qb: Record<string, unknown> = {};
  qb.insert = jest.fn(() => qb);
  qb.into = jest.fn(() => qb);
  qb.orIgnore = jest.fn(() => qb);
  qb.values = jest.fn((v: unknown) => {
    record.values = v;

    return qb;
  });
  qb.execute = jest.fn(async () => {
    const rows = ([] as Array<{ id: string }>).concat(record.values as Array<{ id: string }>);
    const written = rows.filter((row) => !takenIds.has(row.id));

    record.inserted = written.length > 0;

    return { raw: written.map((row) => ({ id: row.id })) };
  });

  return qb;
}

/** A row as `ci.notes` already holds it, for the captureMany classification tests. */
interface StoredRow {
  id: string;
  user_id: string;
  updated_at: Date;
}

/**
 * Stands in for Postgres across captureMany's two statements.
 *
 * The INSERT arm re-implements the ON CONFLICT predicates
 * (`n.user_id = EXCLUDED.user_id AND n.updated_at < EXCLUDED.updated_at`) against `stored`
 * and returns only the ids that would actually be written. So these tests check the
 * service's classification and event fan-out against an independent statement of the same
 * rules — they do NOT exercise the SQL itself, which needs a live database.
 */
function makeQuery(stored: StoredRow[]) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    seen.push({ sql, params });

    if (sql.includes('SELECT id, user_id, updated_at')) {
      const ids = params[0] as string[];

      return stored.filter((row) => ids.includes(row.id));
    }

    if (sql.includes('INSERT INTO ci.notes')) {
      const written: Array<{ id: string }> = [];

      // 5 binds per row: id, title, content, user_id, captured_at.
      for (let at = 0; at < params.length; at += 5) {
        const id = params[at] as string;
        const userId = params[at + 3] as string;
        const capturedAt = params[at + 4] as Date;
        const existing = stored.find((row) => row.id === id);

        if (!existing) {
          written.push({ id });

          continue;
        }

        if (existing.user_id === userId && existing.updated_at.getTime() < capturedAt.getTime()) {
          written.push({ id });
        }
      }

      return written;
    }

    return [];
  });

  return { query, seen };
}

function makeService(stored: StoredRow[] = [], findOneResult: NoteEntity | null = null) {
  const insertRecord = { inserted: false } as { values?: unknown; inserted: boolean };
  const takenIds = new Set(findOneResult ? [findOneResult.id] : []);
  const created: NoteEntity[] = [];
  const { query, seen } = makeQuery(stored);

  const create = jest.fn((partial: Partial<NoteEntity>) => {
    const entity = Object.assign(new NoteEntity(), { ...partial, userId: USER });

    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: NoteEntity) => entity);
  const find = jest.fn(async () => created);
  // Honors an owner filter, so a lookup scoped to this user cannot see a stranger's row.
  const findOne = jest.fn(async (options?: { where?: { userId?: string } }) => {
    const userId = options?.where?.userId;

    return findOneResult && (userId === undefined || findOneResult.userId === userId) ? findOneResult : null;
  });

  const repository = {
    create,
    save,
    find,
    findOne,
    manager: { query },
    // 6 persisted columns, matching repository.metadata.columns.length; drives
    // computeChunkSize in createMany.
    metadata: { target: NoteEntity, columns: { length: 6 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(insertRecord, takenIds)),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new NoteService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, send, insert: insertRecord, save, findOne, queries: seen };
}

describe('NoteService bulk createMany', () => {
  it('inserts set-based (one INSERT, no per-row save) and does NOT emit a per-row NoteCreatedEvent', async () => {
    const { service, send, insert, save } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'n1', title: 'One', content: 'a' },
      { id: 'n2', title: 'Two', content: 'b' },
    ]);

    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    expect(result.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns an empty array (and issues no INSERT) for empty input', async () => {
    const { service, send, insert } = makeService();

    const result = await service.createMany(CONTEXT, []);

    expect(result).toEqual([]);
    expect(insert.inserted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('NoteService captureMany — the outbox replay path', () => {
  const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';
  const at = (iso: string) => new Date(iso);

  it('inserts an unseen note and emits NoteCreatedEvent so it indexes live', async () => {
    const { service, send } = makeService();

    const result = await service.captureMany(CONTEXT, [
      { id: 'n1', title: 'One', content: 'a', capturedAt: at('2026-08-13T10:00:00.000Z') },
    ]);

    expect(result).toEqual({ created: ['n1'], updated: [], stale: [], conflicted: [] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual(['note.created', { noteId: 'n1' }]);
  });

  it('stamps created_at AND updated_at from the capture instant, not the delivery instant', async () => {
    // A note written offline last night belongs to last night on the timeline.
    const { service, queries } = makeService();
    const capturedAt = at('2026-08-13T10:00:00.000Z');

    await service.captureMany(CONTEXT, [{ id: 'n1', title: 'One', content: 'a', capturedAt }]);

    const insert = queries.find((entry) => entry.sql.includes('INSERT INTO ci.notes'));

    expect(insert?.params).toEqual(['n1', 'One', 'a', USER, capturedAt]);
    // One bind reused for both columns — see the VALUES tuple.
    expect(insert?.sql).toContain('(id, title, content, user_id, created_at, updated_at)');
  });

  it('replays an already-stored snapshot as stale, not as an error — delivery is at-least-once', async () => {
    // The row survives whenever an /attempt report is lost, so the SAME note arrives
    // again. That must be free: a unique violation would read to the flusher as a
    // transient 5xx and retry a safely-stored note into needs_attention.
    const { service, send } = makeService([
      { id: 'n1', user_id: USER, updated_at: at('2026-08-13T10:00:00.000Z') },
    ]);

    const result = await service.captureMany(CONTEXT, [
      { id: 'n1', title: 'One', content: 'a', capturedAt: at('2026-08-13T10:00:00.000Z') },
    ]);

    expect(result).toEqual({ created: [], updated: [], stale: ['n1'], conflicted: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses to write a snapshot older than what is stored', async () => {
    // A note edited online while an older snapshot sat in the queue is ordinary, not
    // exotic. Last-write-wins on the CLIENT capture instant.
    const { service, send } = makeService([
      { id: 'n1', user_id: USER, updated_at: at('2026-08-13T12:00:00.000Z') },
    ]);

    const result = await service.captureMany(CONTEXT, [
      { id: 'n1', content: 'stale', capturedAt: at('2026-08-13T09:00:00.000Z') },
    ]);

    expect(result.stale).toEqual(['n1']);
    expect(result.updated).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('advances an owned note when the snapshot is newer, emitting NoteUpdatedEvent', async () => {
    const { service, send } = makeService([
      { id: 'n1', user_id: USER, updated_at: at('2026-08-13T09:00:00.000Z') },
    ]);

    const result = await service.captureMany(CONTEXT, [
      { id: 'n1', content: 'newer', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    expect(result.updated).toEqual(['n1']);
    expect(send.mock.calls[0]).toEqual(['note.updated', { noteId: 'n1' }]);
  });

  it('NEVER writes through to a note belonging to another user', async () => {
    // `repository.save()` with the primary key set would UPDATE that row unscoped and
    // reassign user_id. A client-supplied id makes that reachable, so it is refused here.
    const { service, send, queries } = makeService([
      { id: 'n1', user_id: OTHER_USER, updated_at: at('2026-08-13T09:00:00.000Z') },
    ]);

    const result = await service.captureMany(CONTEXT, [
      { id: 'n1', content: 'theirs now', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    expect(result).toEqual({ created: [], updated: [], stale: [], conflicted: ['n1'] });
    expect(send).not.toHaveBeenCalled();
    // Not merely refused by the SQL predicate — never sent at all.
    expect(queries.some((entry) => entry.sql.includes('INSERT INTO ci.notes'))).toBe(false);
  });

  it('keeps a conflicting id from blocking the rest of the batch', async () => {
    const { service } = makeService([
      { id: 'n1', user_id: OTHER_USER, updated_at: at('2026-08-13T09:00:00.000Z') },
    ]);

    const result = await service.captureMany(CONTEXT, [
      { id: 'n1', content: 'theirs', capturedAt: at('2026-08-13T12:00:00.000Z') },
      { id: 'n2', content: 'mine', capturedAt: at('2026-08-13T12:00:00.000Z') },
    ]);

    expect(result.conflicted).toEqual(['n1']);
    expect(result.created).toEqual(['n2']);
  });

  it('collapses repeats of one id within a request to the newest snapshot', async () => {
    // A batch must behave exactly like the same snapshots arriving one at a time.
    const { service, send, queries } = makeService();

    const result = await service.captureMany(CONTEXT, [
      { id: 'n1', content: 'first', capturedAt: at('2026-08-13T10:00:00.000Z') },
      { id: 'n1', content: 'last', capturedAt: at('2026-08-13T11:00:00.000Z') },
    ]);

    expect(result.created).toEqual(['n1']);

    const insert = queries.find((entry) => entry.sql.includes('INSERT INTO ci.notes'));

    expect(insert?.params).toContain('last');
    expect(insert?.params).not.toContain('first');
    // One row written, so exactly one event — not one per snapshot.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('issues no statements at all for empty input', async () => {
    const { service, queries, send } = makeService();

    const result = await service.captureMany(CONTEXT, []);

    expect(result).toEqual({ created: [], updated: [], stale: [], conflicted: [] });
    expect(queries).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Absent vs. `undefined` vs. `null`.
//
// NoteResolver.updateNote builds its DTO as `{ title: input.title, content:
// input.content }` with both keys always present, so an untouched field
// arrives here as `key: undefined` rather than an absent key — reproduced
// below rather than passing a sparse object, since a sparse `{ title: 'x' }`
// in a test would not catch a regression of this fix. `Object.assign` must
// not let that clobber the entity's current value; an explicit `null` must
// still clear it. Because NoteType.title/content are nullable GraphQL fields,
// the un-fixed bug did not crash — it silently serialized the clobbered field
// as `null` in the response while the database kept the real value (the same
// class of bug fixed in TaskService by #2703, generalized here).
// ---------------------------------------------------------------------------
describe('NoteService update', () => {
  function makeStoredNote(overrides: Partial<NoteEntity> = {}): NoteEntity {
    return Object.assign(new NoteEntity(), {
      id: 'n1',
      userId: USER,
      title: 'Original title',
      content: 'Original content',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('leaves an untouched field alone when the caller sends every key, undefined for the ones it did not set', async () => {
    const { service } = makeService([], makeStoredNote());

    const result = await service.update(CONTEXT, 'n1', {
      title: 'Renamed',
      content: undefined,
    });

    expect(result?.title).toBe('Renamed');
    expect(result?.content).toBe('Original content');
  });

  it('still clears a field when the caller sends an explicit null', async () => {
    const { service } = makeService([], makeStoredNote());

    const result = await service.update(CONTEXT, 'n1', { content: null });

    expect(result?.content).toBeNull();
    expect(result?.title).toBe('Original title');
  });
});

describe('NoteService single create still emits', () => {
  it('emits NoteCreatedEvent on a single interactive create', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'n1', title: 'One', content: 'a' });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ noteId: 'n1' });
  });

  it('suppresses the event when emitCreated: false is passed', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'n1', title: 'One', content: 'a' }, { emitCreated: false });

    expect(send).not.toHaveBeenCalled();
  });

  it('mints an id when the caller passes id: undefined (GraphQL createNote with no client id)', async () => {
    const { service, insert, send } = makeService();

    const note = await service.create(CONTEXT, {
      id: undefined,
      title: 'Shopping list',
      content: '<p>eggs</p>',
    });

    const written = insert.values as NoteEntity;
    expect(written.id).toEqual(expect.any(String));
    expect(note?.id).toBe(written.id);
    expect(send.mock.calls[0][1]).toEqual({ noteId: written.id });
  });

  it('keeps a client-minted id', async () => {
    const { service, insert } = makeService();

    await service.create(CONTEXT, { id: 'client-id', title: 'One', content: 'a' });

    expect((insert.values as NoteEntity).id).toBe('client-id');
  });

  it('never goes through save(), which would UPDATE an existing row whoever owns it', async () => {
    const { service, save } = makeService();

    await service.create(CONTEXT, { id: 'client-id', title: 'One', content: 'a' });

    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a client-minted id that belongs to another user's note", async () => {
    const stranger = Object.assign(new NoteEntity(), { id: 'client-id', userId: 'someone-else' });
    const { service, insert, send } = makeService([], stranger);

    const note = await service.create(CONTEXT, { id: 'client-id', title: 'Mine', content: 'a' });

    expect(note).toBeNull();
    expect(insert.inserted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the stored note unchanged when the caller replays its own create', async () => {
    const stored = Object.assign(new NoteEntity(), {
      id: 'client-id',
      userId: USER,
      title: 'Edited since',
      content: 'newer',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const { service, insert } = makeService([], stored);

    const note = await service.create(CONTEXT, { id: 'client-id', title: 'Offline', content: 'older' });

    expect(insert.inserted).toBe(false);
    expect(note?.title).toBe('Edited since');
    expect(note?.content).toBe('newer');
    expect(note?.createdAt).toEqual(stored.createdAt);
  });

  it('does not look up an owner when the server mints the id', async () => {
    const { service, findOne } = makeService();

    await service.create(CONTEXT, { id: undefined, title: 'One', content: 'a' });

    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('NoteService createMany ids', () => {
  it('mints an id for a row that passes id: undefined', async () => {
    const { service, insert } = makeService();

    await service.createMany(CONTEXT, [{ id: undefined, title: 'One', content: 'a' }]);

    expect((insert.values as NoteEntity[])[0].id).toEqual(expect.any(String));
  });
});

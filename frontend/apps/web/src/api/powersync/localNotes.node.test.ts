import { describe, expect, it, vi } from 'vitest';

vi.mock('./replicaQuery', () => ({ useReplicaQuery: vi.fn() }));

import { createLocalNote, deleteLocalNote, LOCAL_NOTES_SQL, updateLocalNote } from './localNotes';

function fakeDb() {
  return { execute: vi.fn(async () => undefined) };
}

describe('local notes', () => {
  it('lists last edited first, as the appliance does', () => {
    expect(LOCAL_NOTES_SQL).toContain('ORDER BY updated_at DESC, id DESC');
  });

  it('creates under the client-minted id with both timestamps set, leaving user_id to the server', async () => {
    const db = fakeDb();

    await createLocalNote(db as never, { id: 'n1', title: 'Groceries', content: '<p>eggs</p>' });

    const [sql, params] = db.execute.mock.calls[0] as unknown as [string, unknown[]];

    expect(sql).toBe('INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    expect(params.slice(0, 3)).toEqual(['n1', 'Groceries', '<p>eggs</p>']);
    expect(params[3]).toBe(params[4]);
    expect(String(params[3])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('updates title, content and updated_at only', async () => {
    const db = fakeDb();

    await updateLocalNote(db as never, { id: 'n1', title: 'T', content: 'C' });

    const [sql, params] = db.execute.mock.calls[0] as unknown as [string, unknown[]];

    expect(sql).toBe('UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?');
    expect(params[0]).toBe('T');
    expect(params[3]).toBe('n1');
  });

  it('deletes by id', async () => {
    const db = fakeDb();

    await deleteLocalNote(db as never, 'n1');

    expect(db.execute).toHaveBeenCalledWith('DELETE FROM notes WHERE id = ?', ['n1']);
  });
});

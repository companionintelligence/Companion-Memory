/**
 * Notes on the phone: the synced `notes` table, read and written locally.
 *
 * A note is the one thing a user writes in this app and may well add to or
 * edit offline, so on a phone with a replica the note pages read and write
 * this table and nothing else — online or off. PowerSync carries the writes
 * up (`connector.ts` replays them through the note mutations, a create with
 * the row's own id so the row that syncs back down is this one) and server
 * changes down. The browser, which syncs nothing, keeps the GraphQL pages.
 *
 * `user_id` is left for the server: the replica is one user's, and the row
 * PowerSync writes back carries it.
 */
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { useReplicaQuery } from './replicaQuery';

/** A note as the device holds it (the `notes` table, sync-rules.yaml). */
export interface LocalNote {
  id: string;
  title: string | null;
  content: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export const LOCAL_NOTE_COLUMNS = 'id, title, content, created_at, updated_at';

/** The list's order: the appliance's (`NoteService.list`), last edited first. */
export const LOCAL_NOTES_SQL = `SELECT ${LOCAL_NOTE_COLUMNS} FROM notes ORDER BY updated_at DESC, id DESC`;

export const LOCAL_NOTE_SQL = `SELECT ${LOCAL_NOTE_COLUMNS} FROM notes WHERE id = ?`;

/** Every note on the phone, kept current as the table changes. */
export function useLocalNotes() {
  return useReplicaQuery<LocalNote>(LOCAL_NOTES_SQL);
}

/** One note, kept current; `id` undefined or `new` reads nothing. */
export function useLocalNote(id: string | undefined) {
  const enabled = Boolean(id) && id !== 'new';

  return useReplicaQuery<LocalNote>(enabled ? LOCAL_NOTE_SQL : 'SELECT 1 WHERE 0', enabled ? [id] : []);
}

/** An ISO instant the way PowerSync will write it back: it sorts with the server's. */
function now(): string {
  return new Date().toISOString();
}

/** Create a note under a client-minted id; the id is the note's, permanently. */
export async function createLocalNote(
  db: AbstractPowerSyncDatabase,
  note: { id: string; title: string; content: string },
): Promise<void> {
  const at = now();

  await db.execute('INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    note.id,
    note.title,
    note.content,
    at,
    at,
  ]);
}

export async function updateLocalNote(
  db: AbstractPowerSyncDatabase,
  note: { id: string; title: string; content: string },
): Promise<void> {
  await db.execute('UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?', [
    note.title,
    note.content,
    now(),
    note.id,
  ]);
}

export async function deleteLocalNote(db: AbstractPowerSyncDatabase, id: string): Promise<void> {
  await db.execute('DELETE FROM notes WHERE id = ?', [id]);
}

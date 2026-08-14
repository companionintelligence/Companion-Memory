/**
 * **Notes** as a durable capture path — the first outbox source that is not a sensor.
 *
 * Notes differ from `location.ts` in one way that shapes everything here: a note already
 * has a delivery path that works, the GraphQL `createNote` mutation. This module is not
 * that path's replacement, it is what happens when that path cannot reach the appliance.
 * So where {@link captureLocationFix} fuses "make durable" with "deliver", this module does
 * only the first: it queues, or it says plainly that it could not. The caller owns the
 * decision to try the network first, because the caller is the only one that knows whether
 * it already did.
 *
 * That is also why there is no web write-through here. `captureLocationFix` falls back to
 * POSTing directly when there is no sidecar, because for a location fix the alternative is
 * losing it. For a note, a direct POST would be the *second* attempt to reach the same
 * unreachable appliance in the same second. Reporting `unavailable` and letting the UI say
 * "not saved" is the honest answer, and it is exactly the contract `outbox.ts` asks callers
 * to honor: never conclude a capture was durably recorded when it was not.
 *
 * ## The id is minted here, before the note is ever queued
 *
 * This is the design decision that makes an offline note a first-class note rather than a
 * placeholder awaiting reconciliation. `NoteService.create` has always honored a caller-
 * supplied id (`id: data.id || uuidv7()`), so the client can mint one and the appliance
 * will use it verbatim. Consequences worth stating, because they are all *absences*:
 *
 * - There is no temporary id, so nothing has to be swapped when the drain succeeds.
 * - `/notes/{id}` is the note's real, permanent URL the instant it is typed. It can be
 *   navigated to, bookmarked and shared before the appliance has ever heard of the note.
 * - Nothing has to watch the queue to learn the "real" id, because there is only one id.
 *
 * The id is a **UUIDv7**, matching what the appliance mints, so client- and server-created
 * notes interleave correctly in any id-ordered index rather than scattering.
 *
 * ## Snapshots, not a create-then-update log
 *
 * A note keeps being typed after the first autosave fires. The sidecar can enqueue and
 * delete but cannot rewrite a queued payload, and delete-then-re-enqueue opens a window
 * where the note is in neither place — a crash there loses it outright, which is the one
 * outcome this feature exists to prevent. So each autosave enqueues a fresh, complete
 * snapshot under the same note id. The queue is append-only; convergence happens at the
 * endpoint, where `POST /v1/notes` upserts and keeps the newest `captured_at`. Drains are
 * FIFO by `seq`, so the last thing the user typed is the last thing written.
 */

import { enqueueOutboxItem } from '../outbox';
import { NOTE_OUTBOX_KIND } from '../outboxFlush';

/** localStorage key holding the ids of notes this client authored that may still be queued. */
const QUEUED_NOTES_STORAGE_KEY = 'ci.deviceSources.queuedNotes';

/**
 * Cap on remembered ids. Bounds a key that would otherwise grow for the life of the
 * install; oldest entries are dropped first. Losing the oldest entry only means later
 * edits to a long-abandoned offline note stop being queued — the note itself is already
 * in the outbox and still drains.
 */
const MAX_REMEMBERED_NOTES = 200;

/** A note snapshot on the wire, matching `bulkNoteRecordSchema` exactly. */
export interface NoteRecord {
  id: string;
  title: string | null;
  content: string | null;
  /** ISO-8601 **client** instant this snapshot was taken. The last-write-wins key. */
  captured_at: string;
}

/** What happened to a snapshot. Every terminal state is named. */
export type NoteCaptureOutcome =
  /** Committed to the sidecar's on-disk queue. Survives force-quit and reboot. */
  | { status: 'queued'; record: NoteRecord; id: string }
  /**
   * No sidecar on this platform (web), so there is no durable local store and the note is
   * NOT saved. The caller must tell the user — see the module docblock.
   */
  | { status: 'unavailable'; record: NoteRecord; message: string }
  /** The sidecar exists and refused (queue full, or an internal failure). Not saved. */
  | { status: 'failed'; record: NoteRecord; message: string };

function webCrypto(): { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => void } | undefined {
  return (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => void };
    }
  ).crypto;
}

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const provider = webCrypto();

  if (typeof provider?.getRandomValues === 'function') {
    provider.getRandomValues(bytes);

    return bytes;
  }

  // Only reached on a runtime without WebCrypto. Weaker entropy, but a note id needs to be
  // unique, not unguessable — it is scoped to one user and the appliance refuses an id
  // that resolves to somebody else's row.
  for (let index = 0; index < count; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }

  return bytes;
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

/**
 * Mint a note id: a **UUIDv7**, the same version `NoteService` mints server-side.
 *
 * v7 rather than `crypto.randomUUID()`'s v4 because the leading 48 bits are the capture
 * time in milliseconds: ids sort in creation order, so client-minted notes land in the same
 * index locality as server-minted ones instead of scattering across the primary key.
 */
export function newNoteId(atMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = Math.max(0, Math.trunc(atMs));

  // 48-bit big-endian millisecond timestamp. Divided rather than shifted: `>>` coerces to
  // int32, which silently truncates every timestamp past 2038.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  const hex = Array.from(bytes, (byte) => HEX[byte]).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Build the wire record for one snapshot. */
export function buildNoteRecord(
  note: { id: string; title?: string | null; content?: string | null },
  capturedAtMs: number = Date.now(),
): NoteRecord {
  return {
    id: note.id,
    title: note.title ?? null,
    content: note.content ?? null,
    captured_at: new Date(capturedAtMs).toISOString(),
  };
}

function readRememberedNotes(): string[] {
  try {
    const raw = window.localStorage.getItem(QUEUED_NOTES_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // Unavailable or corrupt — treat as empty rather than throwing inside a save path.
    return [];
  }
}

function writeRememberedNotes(ids: string[]): void {
  try {
    window.localStorage.setItem(QUEUED_NOTES_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Private mode / quota. The note is already durable in the sidecar; only the
    // ability to queue LATER edits to it is lost.
  }
}

/**
 * Ids of notes this client authored while it could not reach the appliance.
 *
 * The list exists to answer one question at the next autosave: *do we hold this note's
 * full content?* Only a note we authored in this browser profile can be re-snapshotted
 * safely. A note fetched from the appliance and merely failing to load right now must
 * NEVER be snapshotted — the editor would be showing empty content it never received, and
 * queueing that would overwrite the real note with nothing. `captured_at` cannot save us
 * there either: the empty snapshot genuinely is newer.
 *
 * **Ids only, never content.** Note bodies stay in the sidecar's SQLCipher database, which
 * is encrypted at rest; mirroring them into localStorage in plaintext would quietly undo
 * that.
 */
export function rememberQueuedNote(id: string): void {
  const ids = readRememberedNotes().filter((known) => known !== id);

  ids.push(id);

  writeRememberedNotes(ids.slice(-MAX_REMEMBERED_NOTES));
}

/** Whether `id` names a note this client authored and may still owe the appliance. */
export function isQueuedNote(id: string): boolean {
  return readRememberedNotes().includes(id);
}

/**
 * Forget `id`. Call once the appliance has served the note back — proof the drain landed,
 * so later edits belong on the ordinary online path.
 */
export function forgetQueuedNote(id: string): void {
  const ids = readRememberedNotes();
  const remaining = ids.filter((known) => known !== id);

  if (remaining.length !== ids.length) {
    writeRememberedNotes(remaining);
  }
}

/**
 * Durably queue one note snapshot.
 *
 * Resolves only after the sidecar has committed the row to disk, so `queued` genuinely
 * means the note survives a reboot. See the module docblock for why there is no
 * write-through on platforms without a sidecar.
 */
export async function captureNote(record: NoteRecord): Promise<NoteCaptureOutcome> {
  const queued = await enqueueOutboxItem({
    kind: NOTE_OUTBOX_KIND,
    // Posted onward verbatim, so the payload IS the endpoint's envelope.
    payload: { records: [record] },
    capturedAt: record.captured_at,
    // Deliberately NOT a stable per-note key. The sidecar returns the existing row for a
    // repeated key without touching its payload, so a per-note key would pin the queue to
    // the FIRST snapshot and silently discard everything typed afterwards. Each snapshot
    // is its own row; `(id, captured_at)` keeps a retried enqueue of the SAME snapshot
    // free, which is the only duplicate worth collapsing.
    idempotencyKey: `${record.id}:${record.captured_at}`,
  });

  if (queued.ok) {
    rememberQueuedNote(record.id);

    return { status: 'queued', record, id: queued.value.id };
  }

  if (queued.reason === 'unavailable') {
    return { status: 'unavailable', record, message: queued.message };
  }

  return { status: 'failed', record, message: queued.message };
}

export interface CreateNoteDto {
  id?: string;
  title?: string | null;
  content?: string | null;
}

export interface UpdateNoteDto {
  title?: string | null;
  content?: string | null;
}

/**
 * One note as it arrives from a durable client queue (`POST /v1/notes`).
 *
 * Differs from {@link CreateNoteDto} in the two fields that make replay safe:
 * `id` is REQUIRED (the client minted it before the note was ever queued, so it
 * is the identity both sides already agree on) and `capturedAt` is REQUIRED (it
 * is the last-write-wins discriminator — see NoteService.captureMany).
 */
export interface CaptureNoteDto {
  id: string;
  title?: string | null;
  content?: string | null;
  /** Client instant the snapshot was taken — never the delivery instant. */
  capturedAt: Date;
}

/**
 * Per-id outcome of {@link NoteService.captureMany}, so the caller can report
 * accurate accounting and tell a benign no-op from a genuine conflict.
 */
export interface CaptureNoteResult {
  /** Ids that did not exist and were inserted. */
  created: string[];
  /** Ids that existed, were ours, and carried older content — overwritten. */
  updated: string[];
  /** Ids already at or ahead of this snapshot. Benign: the note is safe. */
  stale: string[];
  /**
   * Ids that exist and belong to ANOTHER user. Never written through. A
   * genuine conflict, surfaced rather than swallowed — see the controller.
   */
  conflicted: string[];
}

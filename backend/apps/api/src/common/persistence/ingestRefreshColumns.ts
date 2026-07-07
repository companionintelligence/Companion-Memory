/** The entities the importer's bulk-ingest paths write. */
export type IngestEntityKind = 'communication' | 'event' | 'item' | 'content' | 'browser_activity';

/**
 * Version of the ingest conflict-refresh contract below. Bumping ANY column
 * list in {@link INGEST_REFRESH_COLUMNS} MUST bump this version: a future
 * importer header handshake will compare its compiled-in version against this
 * one to detect that the two sides disagree about which fields a re-sync
 * self-heals (the cross-repo handshake itself is out of scope here — nothing
 * reads this over the wire yet).
 */
export const INGEST_SCHEMA_VERSION = 1;

/**
 * Central, per-entity list of the DB columns a bulk re-ingest of an existing
 * provenance triple refreshes (the ON CONFLICT DO UPDATE SET / self-heal
 * list). The ingest services reference these instead of inline arrays so the
 * refresh contract lives in exactly one place.
 *
 * An EMPTY list means conflicts are DO NOTHING find-or-return: the existing
 * row is left untouched.
 *
 * List ONLY source-derived mutable columns — never the identity/arbiter
 * columns (id, time, user_id, source_*), and never columns a user may edit
 * server-side (a re-sync would clobber those).
 *
 * Bumping a column list MUST bump {@link INGEST_SCHEMA_VERSION} (see its doc)
 * and the snapshot in ingestRefreshColumns.test.ts.
 */
export const INGEST_REFRESH_COLUMNS: Record<IngestEntityKind, readonly string[]> = {
  // CommunicationService.createMany self-heal set: a re-sync corrects e.g. the
  // importer's fixed email `direction` or a newly-populated
  // `participants_metadata`. The UPDATE ... FROM (VALUES ...) statement there
  // binds parameters in THIS order — keep them in lockstep.
  communication: ['direction', 'participants_metadata', 'content', 'preview', 'subject'],
  event: [],
  item: [],
  content: [],
  browser_activity: [],
};

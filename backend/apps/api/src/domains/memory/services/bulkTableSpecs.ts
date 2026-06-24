import {
  type BulkCommunicationRecord,
  type BulkEventRecord,
  type BulkTableSpec,
  bulkCommunicationSchema,
  bulkEventSchema,
  toIso,
} from '../types/bulkIngest';

// =====================================================================
// Destination specs for the bulk COPY pipeline (issue #11)
// =====================================================================
// Each spec is the single source of truth for one destination table:
// the staging DDL, how a validated record maps to COPY columns, and the
// set-based INSERT…SELECT that folds staging into ci.<table> while
// preserving the EXACT provenance idempotency of the GraphQL path
// (the same partial unique indexes / triples).
//
// The id values are generated in SQL with ci.gen_uuid_v7() so the
// pipeline never has to round-trip ids, and a re-run produces a fresh id
// only for genuinely new rows (existing rows are skipped by ON CONFLICT).

// ---------------------------------------------------------------------
// ci.communications
// ---------------------------------------------------------------------
// Hypertable on (time, user_id). Provenance index:
//   communications_source_triple_uniq
//     ON ci.communications (user_id, time, source_type, source_system, source_id)
//     WHERE source_id IS NOT NULL
// So the conflict target MUST be that exact column list + predicate.

export const communicationsBulkSpec: BulkTableSpec<BulkCommunicationRecord> = {
  destination: 'ci.communications',
  stagingTable: 'bulk_stage_communications',
  schema: bulkCommunicationSchema,
  stagingColumns: [
    { name: 'time', ddl: 'TIMESTAMPTZ' },
    { name: 'communication_type', ddl: 'TEXT' },
    { name: 'direction', ddl: 'TEXT' },
    { name: 'content', ddl: 'TEXT' },
    { name: 'subject', ddl: 'TEXT' },
    { name: 'preview', ddl: 'TEXT' },
    { name: 'thread_id', ddl: 'TEXT' },
    { name: 'category', ddl: 'TEXT' },
    { name: 'connection_id', ddl: 'TEXT' },
    { name: 'source_type', ddl: 'TEXT' },
    { name: 'source_system', ddl: 'TEXT' },
    { name: 'source_id', ddl: 'TEXT' },
  ],
  copyColumns: [
    { name: 'time', get: (r) => toIso(r.time) },
    { name: 'communication_type', get: (r) => r.communication_type },
    { name: 'direction', get: (r) => r.direction },
    { name: 'content', get: (r) => r.content },
    { name: 'subject', get: (r) => r.subject },
    { name: 'preview', get: (r) => r.preview },
    { name: 'thread_id', get: (r) => r.thread_id },
    { name: 'category', get: (r) => r.category },
    { name: 'connection_id', get: (r) => r.connection_id },
    { name: 'source_type', get: (r) => r.source_type },
    { name: 'source_system', get: (r) => r.source_system },
    { name: 'source_id', get: (r) => r.source_id },
  ],
  idColumn: 'id',
  insertSelectSql: `
    INSERT INTO ci.communications (
      id, "time", user_id, communication_type, direction, content,
      subject, preview, thread_id, category, connection_id,
      source_type, source_system, source_id
    )
    SELECT
      ci.gen_uuid_v7(),
      s."time",
      $1::uuid,
      s.communication_type::ci.communication_type,
      s.direction::ci.communication_direction,
      s.content,
      s.subject,
      s.preview,
      s.thread_id,
      s.category,
      s.connection_id,
      s.source_type,
      s.source_system,
      s.source_id
    FROM bulk_stage_communications s
    ON CONFLICT (user_id, "time", source_type, source_system, source_id)
      WHERE source_id IS NOT NULL
      DO NOTHING
    RETURNING id`,
};

// ---------------------------------------------------------------------
// ci.events
// ---------------------------------------------------------------------
// Plain table. Provenance index:
//   events_source_triple_uniq
//     ON ci.events (source_type, source_system, source_id)
//     WHERE source_id IS NOT NULL

export const eventsBulkSpec: BulkTableSpec<BulkEventRecord> = {
  destination: 'ci.events',
  stagingTable: 'bulk_stage_events',
  schema: bulkEventSchema,
  stagingColumns: [
    { name: 'title', ddl: 'TEXT' },
    { name: 'start_time', ddl: 'TIMESTAMPTZ' },
    { name: 'end_time', ddl: 'TIMESTAMPTZ' },
    { name: 'description', ddl: 'TEXT' },
    { name: 'event_type', ddl: 'TEXT' },
    { name: 'category', ddl: 'TEXT' },
    { name: 'location_name', ddl: 'TEXT' },
    { name: 'confidence_score', ddl: 'DOUBLE PRECISION' },
    { name: 'source_type', ddl: 'TEXT' },
    { name: 'source_system', ddl: 'TEXT' },
    { name: 'source_id', ddl: 'TEXT' },
  ],
  copyColumns: [
    { name: 'title', get: (r) => r.title },
    { name: 'start_time', get: (r) => toIso(r.start_time) },
    { name: 'end_time', get: (r) => toIso(r.end_time) },
    { name: 'description', get: (r) => r.description },
    { name: 'event_type', get: (r) => r.event_type },
    { name: 'category', get: (r) => r.category },
    { name: 'location_name', get: (r) => r.location_name },
    { name: 'confidence_score', get: (r) => r.confidence_score },
    { name: 'source_type', get: (r) => r.source_type },
    { name: 'source_system', get: (r) => r.source_system },
    { name: 'source_id', get: (r) => r.source_id },
  ],
  idColumn: 'event_id',
  insertSelectSql: `
    INSERT INTO ci.events (
      event_id, user_id, title, start_time, end_time, description,
      event_type, category, location_name, confidence_score,
      source_type, source_system, source_id
    )
    SELECT
      ci.gen_uuid_v7(),
      $1::uuid,
      s.title,
      s.start_time,
      s.end_time,
      s.description,
      s.event_type,
      s.category,
      s.location_name,
      COALESCE(s.confidence_score, 1.0),
      s.source_type,
      s.source_system,
      s.source_id
    FROM bulk_stage_events s
    ON CONFLICT (source_type, source_system, source_id)
      WHERE source_id IS NOT NULL
      DO NOTHING
    RETURNING event_id`,
};

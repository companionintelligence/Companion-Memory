import { z } from 'zod';

import { CommunicationDirection, CommunicationType } from '../types';

// =====================================================================
// BULK COPY ingest (issue #11) — NDJSON record schemas + table specs
// =====================================================================
// The high-throughput sibling of the GraphQL batch mutations
// (createCommunications / createEvents). The importer streams one JSON
// object per line (NDJSON); each line is validated against the schemas
// below, written into a per-request TEMP staging table via Postgres
// `COPY ... FROM STDIN`, then folded into the destination `ci.<table>`
// with a single set-based `INSERT ... SELECT ... ON CONFLICT DO NOTHING`.
//
// The record shapes are a pragmatic subset of CreateCommunicationDto /
// CreateEventDto: the columns the importer actually fills, plus the
// provenance triple (source_type, source_system, source_id) that drives
// idempotent re-ingest. New columns can be added per BulkTableSpec below
// without touching the controller.

/** A timestamp the importer may send either as ISO-8601 or epoch millis. */
const timestamp = z.union([z.string().datetime({ offset: true }), z.number().int()]);

// ---------------------------------------------------------------------
// communications
// ---------------------------------------------------------------------

export const bulkCommunicationSchema = z.object({
  // Hypertable partition key — the importer keeps this stable per source row,
  // so it participates in the provenance unique index.
  time: timestamp,
  communication_type: z.nativeEnum(CommunicationType),
  direction: z.nativeEnum(CommunicationDirection),
  content: z.string(),
  subject: z.string().nullish(),
  preview: z.string().nullish(),
  thread_id: z.string().nullish(),
  category: z.string().nullish(),
  connection_id: z.string().nullish(),
  // Provenance triple. Idempotency only engages when source_id is present
  // (matches the communications_source_triple_uniq partial index predicate).
  source_type: z.string().nullish(),
  source_system: z.string().nullish(),
  source_id: z.string().nullish(),
});

export type BulkCommunicationRecord = z.infer<typeof bulkCommunicationSchema>;

// ---------------------------------------------------------------------
// events
// ---------------------------------------------------------------------

export const bulkEventSchema = z.object({
  title: z.string(),
  start_time: timestamp,
  end_time: timestamp.nullish(),
  description: z.string().nullish(),
  event_type: z.string().nullish(),
  category: z.string().nullish(),
  location_name: z.string().nullish(),
  confidence_score: z.number().min(0).max(1).nullish(),
  source_type: z.string().nullish(),
  source_system: z.string().nullish(),
  source_id: z.string().nullish(),
});

export type BulkEventRecord = z.infer<typeof bulkEventSchema>;

// ---------------------------------------------------------------------
// Per-table spec — the one place that knows how a destination maps
// ---------------------------------------------------------------------

/** Render a validated record value to a COPY-text column value (or null). */
export type CopyColumn<T> = {
  /** Destination column name (snake_case, as in the migration). */
  readonly name: string;
  /** Pull the value out of the validated record. `undefined`/`null` ⇒ NULL. */
  readonly get: (record: T) => unknown;
};

/**
 * Everything the generic COPY pipeline needs to load one destination table.
 * Adding inventory / browser_activity later is implementing one of these.
 */
export interface BulkTableSpec<T> {
  /** Fully-qualified destination, e.g. `ci.communications`. */
  readonly destination: string;
  /** Per-request TEMP staging table name (unqualified — lives in pg_temp). */
  readonly stagingTable: string;
  /** Zod schema validating a single NDJSON record. */
  readonly schema: z.ZodType<T>;
  /**
   * Column DDL for the staging table, in COPY order. Kept text/loose: the
   * staging table is throwaway and the destination enforces real types on the
   * INSERT…SELECT cast.
   */
  readonly stagingColumns: ReadonlyArray<{ readonly name: string; readonly ddl: string }>;
  /** How to render each staging column from a validated record, in COPY order. */
  readonly copyColumns: ReadonlyArray<CopyColumn<T>>;
  /**
   * The set-based fold: `INSERT INTO <destination> (...) SELECT ... FROM
   * <staging> ON CONFLICT (...) DO NOTHING RETURNING <id>`. The owning user is
   * bound as the `$1` parameter server-side (never trusted from / interpolated
   * out of the body). Returns the SQL plus the column name of the returned id,
   * so the caller can emit a per-row created event for every new row.
   */
  readonly insertSelectSql: string;
  /** Column name returned by the INSERT…SELECT (e.g. `id`, `event_id`). */
  readonly idColumn: string;
}

/** Convert an incoming timestamp (ISO string or epoch ms) to an ISO string. */
export function toIso(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface BulkIngestResponse {
  /** Lines read off the wire (excluding blank lines). */
  received: number;
  /** Rows newly inserted into the destination (RETURNING count). */
  inserted: number;
  /** Rows skipped by ON CONFLICT (already present on the provenance triple). */
  deduped: number;
  /** Per-line validation/parse failures; the rest of the stream still loads. */
  rejected: { line: number; reason: string }[];
}

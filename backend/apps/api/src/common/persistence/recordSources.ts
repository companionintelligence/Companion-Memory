import type { EntityManager } from 'typeorm';

/**
 * Append-only writer for ci.record_sources, the multi-provenance ledger (see
 * docs/design/cross-pipeline-identity.md §5 and the table's migration,
 * 20260901175654_cross_pipeline_identity).
 *
 * One ledger row per (record, source_type, source_system, source_id,
 * platform) — so a record that arrived through both pipelines carries two
 * rows, which is what disconnect/undo-import consults before deleting
 * anything and what the import doctor's convergence metric counts. `platform`
 * joined the key in 20260903141234_add_platform_to_record_sources_pk so that
 * two platforms federated under the same source_system (a Gmail fetch and a
 * Microsoft-account fetch, both `email`) don't collapse onto one row. ON
 * CONFLICT DO NOTHING: a re-ingest of the same arrival is a no-op, matching
 * the write paths it rides along with.
 */

export interface RecordSourceRow {
  recordId: string;
  sourceType: string;
  sourceSystem: string;
  sourceId: string;
  connectionId?: string | null;
  importRunId?: string | null;
  /**
   * The delivering platform (ci.record_sources.platform). `undefined` means
   * "the system is the platform" (every platform kind) and is stored as
   * `sourceSystem`; an explicit `null` means the producer could not say —
   * a federated kind with no platform — and is stored as NULL. Callers
   * writing federated kinds must pass one of the two explicitly
   * (domains/memory/identity `ledgerPlatform` decides).
   */
  platform?: string | null;
}

/**
 * Rows per INSERT: 6 array params regardless of row count, but keep the array
 * lengths bounded so a huge import batch doesn't ship one giant statement.
 */
const LEDGER_CHUNK_ROWS = 5000;

/**
 * Insert ledger rows with the caller's EntityManager (join their transaction —
 * the ledger must commit or roll back with the records it evidences).
 * Duplicate arrivals within `rows` are collapsed before sending: the ON
 * CONFLICT arbiter is the table's identity unique index (user_id,
 * record_table, source_type, source_system, source_id, platform), and DO
 * NOTHING makes the statement safe either way, but trimming keeps the arrays
 * small. The in-memory dedup key below mirrors that arbiter (platform
 * included) so two rows differing only in platform both survive to the
 * INSERT rather than one silently losing to the other before it even sees
 * ON CONFLICT.
 */
export async function appendRecordSources(
  manager: EntityManager,
  scope: { table: string; userId: string },
  rows: RecordSourceRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const platform = row.platform === undefined ? row.sourceSystem : row.platform;
    const key = `${row.sourceType}|${row.sourceSystem}|${row.sourceId}|${platform ?? ''}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });

  for (let offset = 0; offset < unique.length; offset += LEDGER_CHUNK_ROWS) {
    const chunk = unique.slice(offset, offset + LEDGER_CHUNK_ROWS);
    await manager.query(
      `INSERT INTO ci.record_sources
         (user_id, record_table, record_id, source_type, source_system, source_id, connection_id, import_run_id, platform)
       SELECT $1, $2, r.record_id, r.source_type, r.source_system, r.source_id, r.connection_id, r.import_run_id, r.platform
       FROM unnest(
         $3::uuid[], $4::text[], $5::text[], $6::text[], $7::uuid[], $8::uuid[], $9::text[]
       ) AS r(record_id, source_type, source_system, source_id, connection_id, import_run_id, platform)
       ON CONFLICT (user_id, record_table, source_type, source_system, source_id, platform) DO NOTHING`,
      [
        scope.userId,
        scope.table,
        chunk.map((row) => row.recordId),
        chunk.map((row) => row.sourceType),
        chunk.map((row) => row.sourceSystem),
        chunk.map((row) => row.sourceId),
        chunk.map((row) => row.connectionId ?? null),
        chunk.map((row) => row.importRunId ?? null),
        chunk.map((row) => (row.platform === undefined ? row.sourceSystem : row.platform)),
      ],
    );
  }
}

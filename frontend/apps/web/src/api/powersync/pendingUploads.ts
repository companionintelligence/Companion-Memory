/**
 * What PowerSync still has to upload from this phone, by table.
 *
 * Every local write to a synced table (a note, a saved search) lands in PowerSync's own
 * queue, `ps_crud`, until the connector replays it against the Memory server. The lock
 * screen's "waiting to sync" note reads this beside the capture outbox, so an edit made
 * offline counts as waiting the same way a position fix does. Each queue row's `data` is
 * JSON whose `type` is the table name (the SDK's `CrudEntry.fromRow`).
 *
 * Off native, or before the replica is open, there is no database in context and the
 * query hook answers with an error and no rows, which reads as nothing waiting.
 */
import { useQuery } from '@powersync/react';

export const PENDING_UPLOADS_SQL =
  "SELECT json_extract(data, '$.type') AS tbl, count(*) AS n FROM ps_crud GROUP BY tbl";

interface PendingUploadRow {
  tbl: string | null;
  n: number;
}

/** Rows waiting to upload, keyed by table name; kept current as the queue drains. */
export function usePendingUploadsByTable(): Record<string, number> {
  const { data } = useQuery<PendingUploadRow>(PENDING_UPLOADS_SQL);
  const counts: Record<string, number> = {};

  for (const row of data ?? []) {
    if (row.tbl) {
      counts[row.tbl] = Number(row.n) || 0;
    }
  }

  return counts;
}

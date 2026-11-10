import fs from 'node:fs';

import type { DataSource, EntityManager } from 'typeorm';

import config from '@ci/configuration';

/**
 * What is left on the volume the DATABASE writes into — the half of an import's
 * disk budget nothing was looking at.
 *
 * `archive/unpack.ts` has had a free-space preflight since it existed, and it
 * measures the SCRATCH filesystem: the tree the parsers read. But the parse is
 * not where an import's bytes end up. The push writes every record into
 * Postgres, whose data directory is a different volume on this appliance and a
 * much smaller one — a 2.7GB Takeout filled a 96GB VM and the push died
 * mid-run, and because the failure came back through the container runtime the
 * import reported an OCI error rather than "the database volume is full".
 */
export interface DatabaseSpace {
  /** `pg_database_size(current_database())`. Always available. */
  databaseBytes: number;
  /** Free bytes on the database's volume, or null when this process cannot see it. */
  freeBytes: number | null;
  /** Where {@link freeBytes} came from, for the stage detail and the log. */
  dataDir: string | null;
}

/**
 * Headroom the push refuses to eat into.
 *
 * Postgres needs room to write WAL, extend indexes and run autovacuum after the
 * last row lands, so stopping at literally zero leaves a database that is full
 * rather than one that is nearly full — and a full Postgres is materially
 * harder to recover than a stalled import.
 */
export const DATABASE_FREE_FLOOR_BYTES = 2 * 1024 ** 3;

/**
 * Where the database keeps its data, as far as THIS process can tell.
 *
 * Asks Postgres first (`SHOW data_directory`), which is exactly right whenever
 * the two share a filesystem namespace — host-mode development, a single-
 * container deployment — and needs no configuration to be correct there. When
 * they do not (the api and the database in separate containers, which is the
 * shipped topology), that path does not resolve here and `CI_IMPORT_DB_DATA_DIR`
 * is the operator's way to point at the same volume through its own mount.
 */
async function dataDirectoryOf(manager: DataSource | EntityManager): Promise<string | null> {
  const configured = config.import.databaseDataDir.trim();

  if (configured && statfsWorks(configured)) {
    return configured;
  }

  try {
    const rows = (await manager.query('SHOW data_directory')) as Array<{ data_directory?: string }>;
    const reported = rows[0]?.data_directory;

    return reported && statfsWorks(reported) ? reported : null;
  } catch {
    return null;
  }
}

function statfsWorks(dir: string): boolean {
  try {
    fs.statfsSync(dir);

    return true;
  } catch {
    return false;
  }
}

/**
 * Measure the database's footprint and its remaining headroom.
 *
 * Never throws. This is instrumentation on the path of an import that is
 * already running, and a probe that could fail the run would be a worse bug
 * than the one it exists to report — an unreadable volume yields
 * `freeBytes: null`, which every caller reads as "cannot say" rather than
 * "no space".
 */
export async function readDatabaseSpace(manager: DataSource | EntityManager): Promise<DatabaseSpace> {
  let databaseBytes: number;

  try {
    const rows = (await manager.query(
      'SELECT pg_database_size(current_database())::bigint AS bytes',
    )) as Array<{ bytes: string }>;

    databaseBytes = Number(rows[0]?.bytes ?? 0);
  } catch {
    databaseBytes = 0;
  }

  const dataDir = await dataDirectoryOf(manager);

  if (dataDir == null) {
    return { databaseBytes, freeBytes: null, dataDir: null };
  }

  try {
    const stats = fs.statfsSync(dataDir);

    return { databaseBytes, freeBytes: Number(stats.bavail) * Number(stats.bsize), dataDir };
  } catch {
    return { databaseBytes, freeBytes: null, dataDir: null };
  }
}

/**
 * The database volume is out of room (or close enough that finishing would
 * leave it out of room).
 *
 * Its own class so the stage runner can report a cause instead of whatever the
 * container runtime turned the ENOSPC into. This is the message the failed 2.7GB
 * Takeout should have produced.
 */
export class DatabaseVolumeFullError extends Error {
  constructor(
    public readonly space: DatabaseSpace,
    detail?: string,
  ) {
    const free = space.freeBytes == null ? 'unknown' : `${(space.freeBytes / 1e9).toFixed(1)}GB`;

    super(
      `the database volume${space.dataDir ? ` (${space.dataDir})` : ''} is out of space: ` +
        `${free} free with the database at ${(space.databaseBytes / 1e9).toFixed(1)}GB` +
        `${detail ? ` — ${detail}` : ''}. Nothing already saved was lost and the rows that did not ` +
        `land are still queued; free space on that volume and run the import's push again.`,
    );
    this.name = 'DatabaseVolumeFullError';
  }
}

/**
 * Postgres SQLSTATE 53100 (`disk_full`), however the driver wrapped it, plus
 * the bare ENOSPC a filesystem write raises on the way to the same place.
 *
 * Checked at both levels for the same reason `isDuplicateKey` is: TypeORM
 * surfaces the code on the error or on its `driverError` depending on which
 * query path raised it.
 */
export function isOutOfDiskError(err: unknown): boolean {
  const wrapped = err as { code?: string; driverError?: { code?: string }; message?: string };

  if (wrapped?.code === '53100' || wrapped?.driverError?.code === '53100') {
    return true;
  }

  if (wrapped?.code === 'ENOSPC' || wrapped?.driverError?.code === 'ENOSPC') {
    return true;
  }

  return typeof wrapped?.message === 'string' && wrapped.message.includes('No space left on device');
}

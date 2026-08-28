/**
 * Boot-time guard against running the application on a database whose schema is
 * not the one this checkout's migrations describe.
 *
 * Two failure modes, both seen locally:
 *
 *   1. **Foreign stack.** Every worktree gets its own compose project and its
 *      own `db-data` volume, but the Postgres host port is dynamic while
 *      `.env` hard-codes `DATABASE_PORT=5432`. Any tooling that resolves the
 *      port from `.env` instead of from the running stack — `yarn workspace
 *      @ci/be-api migrate`, `yarn dbmate up`, a seed script, a jest run — lands
 *      on whichever worktree happens to hold host 5432 and migrates THAT
 *      database. `scripts/dev-stack` stamps the owning stack's name into the
 *      database (see `stampStackIdentity` there) so the mismatch is detectable.
 *
 *   2. **Drift.** A branch switch, a rollback, or case (1) leaves
 *      `schema_migrations` describing a schema no file on disk produces. dbmate
 *      then considers everything applied and `migrate` is a silent no-op, so
 *      the app boots against tables that do not exist and dies later with an
 *      unrelated-looking `relation "ci.x" does not exist`.
 *
 * The check compares the migration filenames on disk against the applied
 * versions and refuses to boot on a mismatch, so the failure names its own
 * cause instead of surfacing as a missing relation ten minutes later.
 */
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

/** Set to `1`/`true` to boot anyway. For deliberately mismatched environments. */
const SKIP_ENV_VAR = 'CI_SKIP_SCHEMA_CHECK';

/**
 * The GUC `scripts/dev-stack` stamps onto the application database, naming the
 * compose project that owns it. Absent on staging/production and on any stack
 * brought up by hand with plain `docker compose up`, where per-worktree
 * isolation is not a concept — an absent stamp therefore skips the ownership
 * half of the check rather than failing it.
 */
export const STACK_KEY_SETTING = 'ci.stack_key';

export interface MigrationDrift {
  /** On disk, never applied. The database is BEHIND this checkout. */
  pending: string[];
  /** Applied, but no file produces them. The database is AHEAD of (or beside) this checkout. */
  unknown: string[];
  onDiskCount: number;
  appliedCount: number;
  latestOnDisk: string | null;
  latestApplied: string | null;
}

/**
 * Migration versions on disk, newest last.
 *
 * The version is every leading digit before the first underscore, not a fixed
 * 14 — one grandfathered file carries a 15-digit prefix and is recorded that
 * way in real `schema_migrations` tables (see bin/check-migration-versions.js).
 */
export function migrationVersionsOnDisk(dir: string = resolveMigrationsDir()): string[] {
  return readdirSync(dir)
    .map((name) => /^(\d+)_.+\.sql$/.exec(name)?.[1])
    .filter((version): version is string => version != null)
    .sort();
}

/**
 * The migrations directory, found by walking up from this module.
 *
 * Resolved by search rather than by a fixed `../` count because the depth
 * differs between running from source (`src/common/persistence`) and running
 * the build (`dist/src/common/persistence`), and by walking rather than off
 * `process.cwd()` because jest and the seed scripts run from elsewhere.
 */
export function resolveMigrationsDir(): string {
  const suffix = path.join('db', 'postgres', 'migrations');

  for (let dir = __dirname; ; ) {
    if (existsSync(path.join(dir, suffix))) {
      return path.join(dir, suffix);
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      throw new Error(`Could not locate ${suffix} above ${__dirname}`);
    }

    dir = parent;
  }
}

export function diffMigrations(onDisk: string[], applied: string[]): MigrationDrift {
  const onDiskSet = new Set(onDisk);
  const appliedSet = new Set(applied);

  return {
    pending: onDisk.filter((version) => !appliedSet.has(version)),
    unknown: applied.filter((version) => !onDiskSet.has(version)),
    onDiskCount: onDisk.length,
    appliedCount: applied.length,
    latestOnDisk: onDisk.length > 0 ? onDisk[onDisk.length - 1] : null,
    latestApplied: applied.length > 0 ? applied[applied.length - 1] : null,
  };
}

/** Minimal shape of a `pg` client / TypeORM query runner, so callers can pass either. */
export interface SchemaProbe {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface SchemaIntegrityInput {
  probe: SchemaProbe;
  /** Compose project this process belongs to, or null when it cannot be determined. */
  expectedStackKey?: string | null;
  migrationsDir?: string;
}

export interface SchemaIntegrityReport {
  drift: MigrationDrift;
  /** Stack the database says owns it, or null when unstamped. */
  ownerStackKey: string | null;
  expectedStackKey: string | null;
  /** True when the database is stamped by a DIFFERENT stack than this process. */
  foreign: boolean;
}

export async function inspectSchemaIntegrity({
  probe,
  expectedStackKey = null,
  migrationsDir,
}: SchemaIntegrityInput): Promise<SchemaIntegrityReport> {
  const ownerRows = await probe.query(`SELECT current_setting('${STACK_KEY_SETTING}', true) AS stack_key`);
  const ownerStackKey = (ownerRows.rows[0]?.stack_key as string | null) || null;
  const applied = await appliedVersions(probe);

  return {
    drift: diffMigrations(migrationVersionsOnDisk(migrationsDir), applied),
    ownerStackKey,
    expectedStackKey,
    foreign: ownerStackKey != null && expectedStackKey != null && ownerStackKey !== expectedStackKey,
  };
}

/**
 * Applied versions, oldest first.
 *
 * A missing `schema_migrations` is not an error but the zero case: a database
 * created but never migrated reads as "everything is pending", which is both
 * true and the more useful message.
 */
async function appliedVersions(probe: SchemaProbe): Promise<string[]> {
  try {
    const result = await probe.query('SELECT version FROM schema_migrations ORDER BY version');

    return result.rows.map((row) => String(row.version));
  } catch (err) {
    // 42P01 undefined_table
    if ((err as { code?: string }).code === '42P01') {
      return [];
    }

    throw err;
  }
}

/** Human-readable diagnosis, or null when the schema matches. */
export function describeSchemaIntegrity(report: SchemaIntegrityReport): string | null {
  const { drift, ownerStackKey, expectedStackKey, foreign } = report;

  if (!foreign && drift.pending.length === 0 && drift.unknown.length === 0) {
    return null;
  }

  const lines = ["The database does not match this checkout's migrations.", ''];

  if (foreign) {
    lines.push(
      `  This database belongs to the "${ownerStackKey}" stack, but this process is "${expectedStackKey}".`,
      '  Something resolved the Postgres port from .env (a hard-coded 5432) instead of',
      "  from this worktree's running stack.",
      '',
    );
  }

  lines.push(
    `  migrations on disk: ${drift.onDiskCount} (latest ${drift.latestOnDisk ?? 'none'})`,
    `  applied in database: ${drift.appliedCount} (latest ${drift.latestApplied ?? 'none'})`,
    '',
  );

  if (drift.unknown.length > 0) {
    lines.push(
      `  ${drift.unknown.length} applied migration(s) have no file on this branch — the database is`,
      '  AHEAD of the code. dbmate treats them as applied, so `migrate` is a silent no-op:',
      ...summarize(drift.unknown),
      '',
    );
  }

  if (drift.pending.length > 0) {
    lines.push(
      `  ${drift.pending.length} migration(s) on disk are not applied — run \`make migrate\`:`,
      ...summarize(drift.pending),
      '',
    );
  }

  // Recovery differs by direction: a behind database is one `make migrate`
  // away, an ahead one cannot be migrated back at all and has to be recreated.
  if (drift.unknown.length > 0) {
    lines.push(
      "  A database that is ahead cannot be migrated back — recreate this stack's volume:",
      '    make dbdestroy && make migrate      # or, to drop the volume outright:',
      '    docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local down -v',
      '',
    );
  }

  lines.push(`  Set ${SKIP_ENV_VAR}=1 to boot anyway.`);

  return lines.join('\n');
}

/** First few versions, so a 100-migration gap does not fill the terminal. */
function summarize(versions: string[]): string[] {
  const shown = versions.slice(0, 5).map((version) => `    ${version}`);

  return versions.length > shown.length
    ? [...shown, `    … and ${versions.length - shown.length} more`]
    : shown;
}

/**
 * Throws when the database is not the one this checkout's migrations describe.
 *
 * Deliberately fatal rather than a warning: the alternative is what this guard
 * exists to stop — the app serving reads against a schema it does not know,
 * and `make seed` dying partway through with a missing relation.
 */
export async function assertSchemaIntegrity(input: SchemaIntegrityInput): Promise<void> {
  if (skipRequested()) {
    return;
  }

  const message = describeSchemaIntegrity(await inspectSchemaIntegrity(input));

  if (message != null) {
    throw new Error(message);
  }
}

export function skipRequested(): boolean {
  const value = process.env[SKIP_ENV_VAR];

  return value === '1' || value === 'true';
}

/**
 * Compose project this process belongs to.
 *
 * `make` exports COMPOSE_PROJECT_NAME for every target and dev-stack passes it
 * down to overmind, so the api/worker processes inherit it. Null when the app
 * is started outside that path, which only disables the ownership half of the
 * check — the migration comparison still runs.
 */
export function currentStackKey(): string | null {
  const fromEnv = process.env.COMPOSE_PROJECT_NAME || process.env.PROJECT_NAME;

  // Same normalisation scripts/dev-stack/key.ts applies before it names the
  // compose project, so the two sides compare equal.
  return fromEnv ? fromEnv.toLowerCase().replace(/[/.]/g, '-') : null;
}

export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

/**
 * Opens a short-lived connection of its own and runs {@link assertSchemaIntegrity}.
 *
 * Its own connection, before the DI container exists, so the process dies
 * before TypeORM builds a metadata graph for tables that may not be there and
 * before pg-boss starts claiming jobs. Runs for both the web and the worker
 * role: either one against a foreign schema is a corruption risk.
 */
export async function verifyDatabaseSchema(connection: DatabaseConnection): Promise<void> {
  if (skipRequested()) {
    return;
  }

  const client = new Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    // Bounded, because `pg` waits forever by default: an unreachable database
    // would hang the process here instead of failing where TypeORM used to.
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Could not reach ${connection.host}:${connection.port}/${connection.database} to verify the schema: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  try {
    await assertSchemaIntegrity({ probe: client, expectedStackKey: currentStackKey() });
  } finally {
    await client.end();
  }
}

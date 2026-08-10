import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { DataSource } from 'typeorm';

import { isPortOpen, resolveConnection, type DatabaseAvailability } from './pipelineHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DATABASE OF ITS OWN, created and dropped per run.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `pipelineHarness.ts` isolates itself two ways: a throwaway SCHEMA for its
 * synthetic source table, and a throwaway STAGE ID for its ledger rows. Both
 * work because everything that harness drives is synthetic — it invents the
 * table it sweeps and it invents the key it writes.
 *
 * `enrichmentLoop.integration.spec.ts` cannot do either. It drives two REAL
 * declared stages, and a real stage names real tables: `ObjectPromoteStage`
 * reads `ci.events` and writes `ci.inventory`, `TemporalRepairStage` reads and
 * writes `ci.events`. Those names are compiled into the stages, which is
 * correct — they are the appliance's tables — and it means the only place the
 * spec can run without touching somebody's archive is a database where
 * `ci.events` is a database of its own making.
 *
 * ── Why not a transaction ──────────────────────────────────────────────────
 *
 * The version of that spec this module replaces funnelled every statement
 * through one {@link import('typeorm').QueryRunner} inside a transaction it
 * always rolled back, and said in its header that nothing could therefore
 * reach the operator's data. It reached the operator's data: a run against the
 * dev appliance left ~599,000 `ci.pipeline_state` rows, 2,147 `ci.inventory`
 * objects and 2,875 `ci.events` rows carrying repaired time provenance, none
 * of it authorised by a human.
 *
 * Rollback discipline is the wrong instrument for this job, and it is worth
 * being precise about why rather than treating the incident as carelessness:
 *
 *  - It is a claim about EVERY code path the test reaches, re-asserted on
 *    every future change to any of them. One service that takes its own
 *    connection — a pool checkout, a `createQueryRunner`, a listener the real
 *    bus dispatches on another handle — and the transaction is a fence with a
 *    gate in it. Nothing warns you; the writes simply commit.
 *  - It cannot fail loudly. A rollback that did not cover something looks
 *    exactly like a rollback that did, right up until you count rows.
 *  - It is unnecessary. The thing being protected is a database, and a
 *    database is a cheap object to make.
 *
 * So: this module makes one. Every statement the suite issues goes to a
 * database created for that run and dropped after it, and the isolation is a
 * property of the CONNECTION rather than of the discipline of everything
 * downstream of it. A `kill -9` mid-run leaks a database with an obvious name
 * instead of committing to yours, and the next run reaps it.
 *
 * ── The guard ──────────────────────────────────────────────────────────────
 *
 * {@link ScratchDatabase.assertOwn} is the part that matters. Creating a
 * database and connecting to it is not a safety property by itself — the whole
 * incident above was a suite that believed it was isolated. So the suite
 * re-derives the answer from the server, before it writes anything and again
 * before it drops anything: the connection must be ON a database whose name
 * this run generated, and that database must contain the marker row this run
 * wrote. Anything else throws, loudly, naming what it found.
 *
 * That is what makes `PIPELINE_TEST_DATABASE_URL` safe to leave pointed at the
 * dev appliance: it now supplies the SERVER, never the target. Point it
 * wherever you like — the suite still writes only to a database it made.
 *
 * ── Credentials ────────────────────────────────────────────────────────────
 *
 * `CREATE DATABASE`, and `CREATE EXTENSION postgis` / `timescaledb` inside it,
 * are superuser operations, and `infrastructure/setup-database/entrypoint.sh`
 * deliberately creates the application role `companion` with neither CREATEDB
 * nor SUPERUSER. So this needs the admin credential the same script reads —
 * `DATABASE_ADMIN_PASSWORD`, which `.env.default` ships. Absent it, the suite
 * SKIPS rather than falling back to the application connection, because the
 * application connection is the operator's archive.
 */

// ---------------------------------------------------------------------------
// Naming, and the pattern every destructive statement is checked against
// ---------------------------------------------------------------------------

/**
 * Scratch database names: `ci_pipeline_scratch_<yyyymmddhhmmss>_<8 hex>`.
 *
 * The timestamp is not decoration. {@link reapOrphans} has to decide whether a
 * leftover database belongs to a run that died or to one still going, and the
 * only thing it can read without connecting to each candidate is the name. The
 * hex suffix is what keeps two developers (or two jest workers) from colliding
 * within the same second.
 */
const SCRATCH_NAME_PATTERN = /^ci_pipeline_scratch_\d{14}_[0-9a-f]{8}$/;

/** Leftovers older than this are assumed to belong to a killed run. */
const ORPHAN_REAP_AGE_MS = 2 * 60 * 60 * 1000;

/** Schema holding the marker {@link ScratchDatabase.assertOwn} checks. */
const MARKER_SCHEMA = 'pipeline_scratch';

/** Table holding the marker. One row, written before the migrations run. */
const MARKER_TABLE = 'marker';

/**
 * Extensions the migrations assume, in the order
 * `infrastructure/setup-database/entrypoint.sh` creates them.
 *
 * No migration issues `CREATE EXTENSION` — on the appliance the bootstrap
 * container does it once, against the `companion` database, before dbmate ever
 * runs. A fresh database gets none of them by inheritance, so this reproduces
 * that step. Keep the list in step with the bootstrap script: a missing
 * extension surfaces as a migration failing on a type it has never heard of
 * (`GEOGRAPHY(POINT, 4326)`), which is a long way from the cause.
 */
const REQUIRED_EXTENSIONS = ['timescaledb', 'postgis', 'vector', 'pg_stat_statements', 'btree_gist'];

/** dbmate's ledger. Written so a leaked scratch database is still inspectable. */
const MIGRATIONS_TABLE = 'public.schema_migrations';

/**
 * The migrations, as dbmate orders them: by filename, which begins with the
 * UTC timestamp `yarn workspace @ci/be-api migrate:make` stamps.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

/** An administrative connection: enough rights to CREATE and DROP a database. */
export interface AdminConnection {
  host: string;
  port: number;
  username: string;
  password: string;
  /** The maintenance database CREATE/DROP DATABASE are issued against. */
  database: string;
}

const DEFAULT_ADMIN_USERNAME = 'postgres';
const DEFAULT_MAINTENANCE_DATABASE = 'postgres';

/**
 * Where to create the scratch database, or `null` when the environment does
 * not describe an administrative connection.
 *
 * Precedence: an explicit admin URL, then the admin password paired with the
 * SERVER coordinates the ordinary harness already resolves. Note what is not
 * here — no fallback to the application credential. A suite that cannot make
 * itself a database must not run at all; the alternative is the one this
 * module exists to prevent.
 */
export function resolveAdminConnection(): AdminConnection | null {
  const url = process.env.PIPELINE_TEST_ADMIN_DATABASE_URL;

  if (url != null && url.trim().length > 0) {
    try {
      const parsed = new URL(url);

      return {
        host: parsed.hostname,
        port: parsed.port.length > 0 ? Number(parsed.port) : 5432,
        username: decodeURIComponent(parsed.username) || DEFAULT_ADMIN_USERNAME,
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, '') || DEFAULT_MAINTENANCE_DATABASE,
      };
    } catch {
      // Reported as "no admin connection" rather than thrown, so the suite
      // skips legibly instead of failing every test on a parse error.
      return null;
    }
  }

  const password = process.env.DATABASE_ADMIN_PASSWORD;

  // The one field with no default, for the same reason `resolveConnection()`
  // gives about the application password: everything else about this server is
  // public knowledge, and the absence of the secret IS the signal.
  if (password == null || password.length === 0) {
    return null;
  }

  // The SERVER, from whatever the ordinary harness resolves — which is how
  // PIPELINE_TEST_DATABASE_URL still gets a say in WHERE the scratch database
  // is created, while having no say at all in what it is called.
  const server = resolveConnection();

  return {
    host: server?.host ?? process.env.DATABASE_HOST ?? 'localhost',
    port: server?.port ?? Number(process.env.DATABASE_PORT ?? 5432),
    username: process.env.DATABASE_ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME,
    password,
    database: DEFAULT_MAINTENANCE_DATABASE,
  };
}

let cachedAvailability: DatabaseAvailability | null = null;

/**
 * Whether a scratch database can be created for this run — answered
 * SYNCHRONOUSLY, so a spec can pick `describe` vs `describe.skip` at collection
 * time. See the README beside this file for why that matters.
 */
export function scratchDatabaseAvailability(): DatabaseAvailability {
  if (cachedAvailability != null) {
    return cachedAvailability;
  }

  const admin = resolveAdminConnection();

  if (admin == null) {
    cachedAvailability = {
      available: false,
      reason:
        'no administrative database connection configured — this suite creates and drops a database of ' +
        'its own, which the application role deliberately cannot do. Set DATABASE_ADMIN_PASSWORD (it is ' +
        'in .env.default, and `make dev` copies that to .env on first run) or PIPELINE_TEST_ADMIN_DATABASE_URL. ' +
        'There is no fallback to the application connection on purpose: that is the operator’s archive.',
      target: '(unset)',
    };

    return cachedAvailability;
  }

  const target = `${admin.host}:${admin.port}`;
  const timeoutMs = Number(process.env.PIPELINE_TEST_PROBE_TIMEOUT_MS ?? 2_000);

  if (!isPortOpen(admin.host, admin.port, timeoutMs)) {
    cachedAvailability = {
      available: false,
      reason: `nothing accepting connections at ${target} (probe timeout ${timeoutMs} ms)`,
      target,
    };

    return cachedAvailability;
  }

  cachedAvailability = { available: true, reason: `Postgres reachable at ${target}`, target };

  return cachedAvailability;
}

// ---------------------------------------------------------------------------
// The scratch database
// ---------------------------------------------------------------------------

/** What {@link ScratchDatabase.create} reports about the setup it just did. */
export interface ScratchDatabaseStats {
  /** Migrations applied. Every one of them, from an empty database. */
  migrations: number;
  /** Wall clock for CREATE DATABASE + extensions + migrations. */
  setupMs: number;
  /** Leftover scratch databases from killed runs, dropped during setup. */
  reaped: string[];
}

/**
 * One disposable Postgres database, with this repo's migrations applied.
 *
 * Construct with {@link ScratchDatabase.create}, and always {@link drop} it in
 * `afterAll`. A leak is not a data-safety problem — the name says what it is
 * and the next run reaps it — but it does cost disk.
 */
export class ScratchDatabase {
  /** The database this run created. Nothing else in the cluster shares the name. */
  readonly name: string;

  /**
   * The marker this run wrote into it, and the thing {@link assertOwn} really
   * checks. A name can be guessed or reused; this cannot.
   */
  readonly token: string;

  /** Pooled connection to {@link name}. Every statement the suite issues goes here. */
  readonly dataSource: DataSource;

  readonly stats: ScratchDatabaseStats;

  private readonly admin: AdminConnection;

  private dropped = false;

  private constructor(init: {
    name: string;
    token: string;
    dataSource: DataSource;
    admin: AdminConnection;
    stats: ScratchDatabaseStats;
  }) {
    this.name = init.name;
    this.token = init.token;
    this.dataSource = init.dataSource;
    this.admin = init.admin;
    this.stats = init.stats;
  }

  /**
   * Create the database, enable the extensions, apply every migration, and
   * return a connection to it.
   *
   * Throws — rather than skipping — on any failure past the availability check.
   * A server that answers a TCP handshake but cannot be migrated is a broken
   * setup, and skipping there would turn it into a green run.
   */
  static async create(
    options: { createdBy: string } = { createdBy: 'pipeline scratch' },
  ): Promise<ScratchDatabase> {
    const admin = resolveAdminConnection();

    if (admin == null) {
      throw new Error(
        'ScratchDatabase.create() called with no administrative connection. Guard the suite with ' +
          'scratchDatabaseAvailability().available before calling it.',
      );
    }

    const startedAt = Date.now();
    const name = scratchDatabaseName();
    const token = randomUUID();

    const maintenance = connect({ ...admin, database: admin.database });

    await maintenance.initialize();

    let reaped: string[];

    try {
      reaped = await reapOrphans(maintenance);

      // Not `IF NOT EXISTS`: the name carries 32 bits of randomness and a
      // timestamp, so a collision is not a thing to absorb quietly — it means
      // the name generator is broken, and absorbing it would hand this run a
      // database somebody else is using.
      await maintenance.query(`CREATE DATABASE "${assertScratchName(name)}"`);
    } catch (err: unknown) {
      await maintenance.destroy();

      throw err;
    }

    await maintenance.destroy();

    const dataSource = connect({ ...admin, database: name });

    try {
      await dataSource.initialize();

      for (const extension of REQUIRED_EXTENSIONS) {
        await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
      }

      // The marker goes in BEFORE the migrations, so a run killed during them
      // still leaves a database the reap can recognise — and so `assertOwn` is
      // answerable from the first statement onwards rather than from the point
      // the schema happens to be complete.
      await dataSource.query(`CREATE SCHEMA "${MARKER_SCHEMA}"`);
      await dataSource.query(
        `CREATE TABLE "${MARKER_SCHEMA}"."${MARKER_TABLE}" (
           token      UUID PRIMARY KEY,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           created_by TEXT NOT NULL
         )`,
      );
      await dataSource.query(
        `INSERT INTO "${MARKER_SCHEMA}"."${MARKER_TABLE}" (token, created_by) VALUES ($1::uuid, $2)`,
        [token, `${options.createdBy} (pid ${process.pid})`],
      );

      const migrations = await applyMigrations(dataSource);

      const scratch = new ScratchDatabase({
        name,
        token,
        dataSource,
        admin,
        stats: { migrations, setupMs: Date.now() - startedAt, reaped },
      });

      // The guard's own first outing, against the database it was just handed.
      // If the checks cannot pass here they will never pass, and finding that
      // out at setup is better than finding it out in `drop()`.
      await scratch.assertOwn();

      return scratch;
    } catch (err: unknown) {
      // A half-built database is still this run's to remove, and leaving one
      // behind after a migration failure would make the failure look like a
      // disk problem an hour later.
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }

      await dropDatabase(admin, name);

      throw err;
    }
  }

  /**
   * THE GUARD, against this run's own identity. See
   * {@link assertScratchDatabase}.
   */
  async assertOwn(): Promise<void> {
    await assertScratchDatabase(this.dataSource, { name: this.name, token: this.token });
  }

  /**
   * Close the connection and drop the database.
   *
   * {@link assertOwn} runs first, and the name is re-checked against the
   * pattern immediately before it is interpolated: a DROP DATABASE is the one
   * statement here that could ruin somebody's week, so it is guarded twice by
   * two different facts.
   */
  async drop(): Promise<void> {
    if (this.dropped) {
      return;
    }

    await this.assertOwn();

    this.dropped = true;

    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }

    await dropDatabase(this.admin, this.name);
  }

  /** Whether {@link name} still exists. Asserted after teardown. */
  async exists(): Promise<boolean> {
    const maintenance = connect({ ...this.admin });

    await maintenance.initialize();

    try {
      const rows = (await maintenance.query(`SELECT 1 AS present FROM pg_database WHERE datname = $1`, [
        this.name,
      ])) as Array<{ present: number }>;

      return rows.length > 0;
    } finally {
      await maintenance.destroy();
    }
  }
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/** What a connection has to prove about itself before anything writes to it. */
export interface ScratchIdentity {
  /** The database name this run generated. */
  name: string;
  /** The marker token this run wrote into it. */
  token: string;
}

/**
 * THE GUARD. Re-derive FROM THE SERVER that `dataSource` is on a database this
 * run created, and throw if it is not.
 *
 * Four facts, in order, each of which the previous one does not cover:
 *
 *  1. the connection is on the database whose name was generated — catches a
 *     handle that came from somewhere else entirely;
 *  2. that name matches the scratch pattern — catches a caller that generated
 *     the "expected" name from the wrong place, which is how a guard ends up
 *     comparing the operator's database to itself and passing;
 *  3. the marker table exists — catches a real database that happens to be
 *     named like one of ours;
 *  4. the marker carries THIS run's token — catches a leftover scratch database
 *     from an earlier run, which is a real database with real rows in it.
 *
 * Cheap enough (two round trips) to call before every block of work, which is
 * how the spec uses it. The failure this defends against is not "the wrong
 * database was configured at startup" — that would be caught once, at setup. It
 * is any path, present or future, by which the connection ends up somewhere
 * else, and a check that runs once cannot see those.
 */
export async function assertScratchDatabase(
  dataSource: DataSource,
  expected: ScratchIdentity,
): Promise<void> {
  const [row] = (await dataSource.query(
    `SELECT current_database()                                      AS database,
            to_regclass('${MARKER_SCHEMA}.${MARKER_TABLE}')::text   AS marker`,
  )) as Array<{ database: string; marker: string | null }>;

  const refuse = (why: string): never => {
    throw new Error(
      `REFUSING TO RUN: ${why}\n` +
        `  connected to : ${row?.database ?? '(unknown)'}\n` +
        `  expected     : ${expected.name}\n` +
        `This suite drives real declared stages, which write ci.events and ci.inventory BY NAME. It is ` +
        `only ever allowed to do that inside a database it created for this run. Pointed at an appliance ` +
        `database it once committed ~599,000 ledger rows and 2,147 inventory objects into somebody's ` +
        `personal archive; this check is what makes that unrepeatable.`,
    );
  };

  if (row?.database == null || row.database !== expected.name) {
    refuse('the connection is not on the database this run created.');
  }

  if (!SCRATCH_NAME_PATTERN.test(row.database)) {
    refuse(`"${row.database}" is not a scratch database name (${String(SCRATCH_NAME_PATTERN)}).`);
  }

  if (row.marker == null) {
    refuse(`${MARKER_SCHEMA}.${MARKER_TABLE} is missing — this database was not created by this harness.`);
  }

  const tokens = (await dataSource.query(
    `SELECT token::text AS token FROM "${MARKER_SCHEMA}"."${MARKER_TABLE}"`,
  )) as Array<{ token: string }>;

  if (tokens.length !== 1 || tokens[0].token !== expected.token) {
    refuse(
      `the marker does not carry this run's token (found ${tokens.length} row(s): ` +
        `${tokens.map((t) => t.token).join(', ') || 'none'}).`,
    );
  }
}

/**
 * A connection to the maintenance database, for tests that need to point the
 * guard at something it must refuse.
 */
export function connectToAdminDatabase(): DataSource {
  const admin = resolveAdminConnection();

  if (admin == null) {
    throw new Error('connectToAdminDatabase() called with no administrative connection configured.');
  }

  return connect(admin);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `ci_pipeline_scratch_<yyyymmddhhmmss>_<8 hex>`. */
function scratchDatabaseName(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  return `ci_pipeline_scratch_${stamp}_${randomBytes(4).toString('hex')}`;
}

/**
 * The last thing between a name and a `DROP DATABASE`.
 *
 * Postgres has no parameter binding for object names, so every statement in
 * this file that carries one goes through here first.
 */
function assertScratchName(name: string): string {
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing to CREATE or DROP the database "${name}": it does not match ${String(SCRATCH_NAME_PATTERN)}, ` +
        `so it is not one this harness made.`,
    );
  }

  return name;
}

function connect(connection: AdminConnection): DataSource {
  return new DataSource({
    type: 'postgres',
    // Discrete fields rather than a URL, so a password containing URL
    // metacharacters (both dev ones end in `!`) never has to survive a round
    // trip through percent-encoding.
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    database: connection.database,
    // Nothing is mapped through TypeORM: the pipeline speaks raw SQL and the
    // entities exist only to document it. `synchronize` would be a second way
    // to write a schema, and the migrations are the only one this repo has.
    entities: [],
    synchronize: false,
    logging: false,
    extra: { max: 8 },
  });
}

async function dropDatabase(admin: AdminConnection, name: string): Promise<void> {
  const maintenance = connect({ ...admin });

  await maintenance.initialize();

  try {
    // WITH (FORCE) terminates any connection still on it — a leaked pool from a
    // failed test, or the previous run's if this is a reap. Without it a single
    // stale backend turns teardown into a leaked database.
    await maintenance.query(`DROP DATABASE IF EXISTS "${assertScratchName(name)}" WITH (FORCE)`);
  } finally {
    await maintenance.destroy();
  }
}

/**
 * Drop scratch databases left behind by runs that were killed before teardown.
 *
 * Bounded two ways so it can never touch anything real: only names matching
 * {@link SCRATCH_NAME_PATTERN}, and only those whose embedded timestamp is
 * older than {@link ORPHAN_REAP_AGE_MS} — which is what keeps it from dropping
 * a database belonging to another jest worker running right now.
 */
async function reapOrphans(maintenance: DataSource): Promise<string[]> {
  const rows = (await maintenance.query(
    `SELECT datname FROM pg_database WHERE datname ~ '^ci_pipeline_scratch_[0-9]{14}_[0-9a-f]{8}$'`,
  )) as Array<{ datname: string }>;

  const cutoff = Date.now() - ORPHAN_REAP_AGE_MS;
  const reaped: string[] = [];

  for (const { datname } of rows) {
    const created = parseStamp(datname);

    // An unparseable stamp cannot be aged, so it is left alone. A database this
    // harness cannot date is not this harness's to drop.
    if (created == null || created.getTime() > cutoff) {
      continue;
    }

    await maintenance.query(`DROP DATABASE IF EXISTS "${assertScratchName(datname)}" WITH (FORCE)`);
    reaped.push(datname);
  }

  return reaped;
}

/** Pull the creation instant back out of a scratch database name. */
function parseStamp(name: string): Date | null {
  const match = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[0-9a-f]{8}$/.exec(name);

  if (match == null) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// The migrations
// ---------------------------------------------------------------------------

/**
 * Apply every migration in `db/postgres/migrations`, in dbmate's order.
 *
 * ── Why not shell out to dbmate ────────────────────────────────────────────
 *
 * `bin/dbmate.js` is the repo's migration entry point and would be the obvious
 * thing to spawn. It cannot be spawned from here: it pulls in `@inquirer/prompts`
 * for its destructive-operation confirmation, which Yarn PnP refuses to resolve
 * for it, and dbmate's own binary lives inside a PnP zip. Both are fixable and
 * neither is this change's business — and a test that depends on an external
 * binary being resolvable is a test that skips for reasons nobody can read.
 *
 * What is reproduced is small and pinned by the guards below: read the files in
 * filename order, execute the `-- migrate:up` section of each in its own
 * transaction, record the version. If a migration ever needs more than that —
 * dbmate options on the marker line, or `CREATE INDEX CONCURRENTLY`, which
 * cannot run in a transaction at all — this throws and names dbmate, rather
 * than applying it in a way dbmate would not have.
 */
async function applyMigrations(dataSource: DataSource): Promise<number> {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `Cannot find the migrations at ${MIGRATIONS_DIR}. This path is relative to this file; if the ` +
        `harness has moved, move it with them.`,
    );
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}.`);
  }

  const runner = dataSource.createQueryRunner();

  await runner.connect();

  try {
    await runner.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version VARCHAR(255) NOT NULL PRIMARY KEY)`,
    );

    for (const file of files) {
      const version = file.slice(0, file.indexOf('_'));
      const body = upSection(file, readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));

      await runner.startTransaction();

      try {
        await runner.query(body);
        await runner.query(`INSERT INTO ${MIGRATIONS_TABLE} (version) VALUES ($1)`, [version]);
        await runner.commitTransaction();
      } catch (err: unknown) {
        await runner.rollbackTransaction();

        throw new Error(
          `Migration ${file} failed against the scratch database: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return files.length;
  } finally {
    await runner.release();
  }
}

/** The `-- migrate:up` half of a dbmate migration, with the two guards. */
function upSection(file: string, sql: string): string {
  const marker = /^-- migrate:up([^\n]*)$/m.exec(sql);

  if (marker == null) {
    throw new Error(`${file} has no "-- migrate:up" marker; dbmate would refuse it too.`);
  }

  const options = marker[1].trim();

  if (options.length > 0) {
    throw new Error(
      `${file} declares dbmate options ("${options}") on its migrate:up line, which this applier does ` +
        `not implement. Teach it, or give this suite a database that has already been migrated by dbmate.`,
    );
  }

  const start = marker.index + marker[0].length;
  const end = sql.indexOf('\n-- migrate:down', start);
  const body = end < 0 ? sql.slice(start) : sql.slice(start, end);

  // Every statement here runs inside a transaction, exactly as dbmate runs it,
  // and CONCURRENTLY cannot. Today no migration uses it — several say in
  // comments that they deliberately do not, for this reason — so this guard is
  // a tripwire for the day one does, not a limitation anyone is hitting.
  if (/\bCONCURRENTLY\b/i.test(stripSqlComments(body))) {
    throw new Error(
      `${file} uses CONCURRENTLY, which cannot run inside the per-migration transaction this applier ` +
        `(like dbmate) wraps every migration in.`,
    );
  }

  return body;
}

/** Good enough to keep the CONCURRENTLY guard from firing on prose about it. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

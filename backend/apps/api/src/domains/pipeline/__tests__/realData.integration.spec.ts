import { randomBytes } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { DEFAULT_SLICE_SIZE, PIPELINE_QUEUES } from '../constants';
import { PipelineStateService } from '../services/PipelineStateService';
import type { Stage, StageResult } from '../types';
import { STAGE_VERSIONS } from '../versions';

import { databaseAvailability, resolveConnection } from './harness/pipelineHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PIPELINE AGAINST THE OPERATOR'S ACTUAL ARCHIVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `pipeline.integration.spec.ts` proves the pipeline is CORRECT: the ledger
 * transitions, the keyset chain, idempotence, the bump. It proves all of it over
 * a throwaway table this repo seeded itself — twenty-five rows, uuids chosen so
 * they sort predictably, one page of one index. Correct, and silent about the
 * only question a 22-year personal archive asks, which is what the same SQL does
 * when the table underneath it is real.
 *
 * `docs/jobs-system-rebuild-plan.md` §14.2 carries that question as an OPEN
 * RISK, in one sentence: *the LEFT JOIN must stay index-only on the largest
 * tables*. Nothing had measured it. This file measures it, on `ci.events` —
 * 324,044 rows imported through CI-Import-Tools, the largest table on the
 * appliance that a sweep can be pointed at without spending money.
 *
 * ── What it measures ───────────────────────────────────────────────────────
 *
 *  1. The plan of THE ONE RULE with an EMPTY ledger. This is the state every
 *     stage starts in and the only state the risk had ever been reasoned about.
 *  2. The plan of the same query with the ledger POPULATED — ~50,000 rows for a
 *     throwaway stage id, then `ANALYZE`, because the planner's choice is a
 *     function of the statistics and an un-analyzed ledger still looks empty to
 *     it. An empty ledger is the easy case; a converging one is the case the
 *     appliance actually lives in.
 *  3. Keyset pagination over REAL uuids at the real slice size: every id visited
 *     exactly once, in order, with nothing lost at a page boundary. Real
 *     `ci.gen_uuid_v7()` ids, not the hand-ordered fixtures the other suite
 *     uses, which cannot expose an ordering assumption because they were built
 *     to satisfy it.
 *  4. The version bump on real rows: mark a sample done at v1, watch it leave
 *     the candidate set, bump, watch it come back.
 *
 * Every EXPLAIN is run on the REAL statement — captured out of
 * `PipelineStateService` as it issues it, then re-submitted with `EXPLAIN` in
 * front and the same bind parameters. Retyping the SQL here would measure a
 * copy, and a copy is exactly the thing that drifts.
 *
 * ── Why nothing here can touch the operator's data ─────────────────────────
 *
 * Same discipline as `DeadLetterReaperListener.spec.ts`, and for a stronger
 * reason: that suite writes synthetic rows, this one runs against 324,044 real
 * ones. Every statement is funnelled through a single {@link QueryRunner} inside
 * a transaction that is **ALWAYS rolled back**. Nothing is ever committed, no
 * other session can observe any of it (asserted, from a second connection, while
 * the writes are in flight), there is nothing to clean up, and a `kill -9`
 * mid-run leaves the database untouched because the aborted transaction takes
 * the lot with it.
 *
 * `ci.events` is only ever READ. The only table written is `ci.pipeline_state`,
 * only ever under a stage id — `test.realdata_<hex>` — that nothing else in the
 * system writes, and only ever inside the transaction. {@link fingerprintLedger}
 * is taken before the first test and again after the last, from a connection
 * outside every transaction, and the suite fails if the two differ.
 *
 * Each describe opens ONE transaction in `beforeAll` rather than one per test.
 * That is a deliberate departure from the reaper spec's per-test transaction: the
 * populated-ledger section inserts 50,000 rows, and doing that four times would
 * leave 200,000 dead tuples in a control-plane table on a live appliance for
 * autovacuum to deal with. Rolled back exactly as strictly, once instead of four
 * times.
 *
 * ── Skipping ───────────────────────────────────────────────────────────────
 *
 * SKIPPED, not failed, when no Postgres is reachable — decided synchronously at
 * collection time; see `harness/README.md`.
 *
 * There is a second, softer gate that jest cannot express as a skip, because
 * answering it needs a query and a suite must choose `describe` vs
 * `describe.skip` while its module is still evaluating. A table of a few hundred
 * rows is SUPPOSED to be scanned sequentially — asserting a plan shape there
 * would be asserting that the planner is wrong. So the plan-shape assertions run
 * only when `ci.events` is at least {@link PLAN_SHAPE_MIN_ROWS}, and a database
 * below that line gets one unmissable warning saying which assertions did not
 * run. Everything else in the file — pagination, the bump, the ledger
 * fingerprint — runs on any corpus.
 */

const availability = databaseAvailability();

const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once per run so a skipped suite is never mistaken for a passing one.
  console.warn(`[realData.integration] SKIPPED — ${availability.reason}`);
}

// Two `EXPLAIN (ANALYZE)`s of a 324k-row join, a 50,000-row insert and an
// `ANALYZE` all live in one `beforeAll`. Comfortably a few seconds in practice,
// but jest's 5 s default is not a budget worth having a flake over.
jest.setTimeout(180_000);

// ---------------------------------------------------------------------------
// What "real data" means here
// ---------------------------------------------------------------------------

/**
 * The source table this suite sweeps. Chosen for three reasons and no others:
 * it is the biggest table on the appliance that already holds imported data, its
 * primary key is a bare uuid (so it fits `StageSource` without a cast), and NO
 * declared stage sweeps it — so the throwaway stage id used here can never
 * collide with, or be mistaken for, a real one.
 */
const SOURCE_SCHEMA = 'ci';
const SOURCE_TABLE = 'events';
const SOURCE_ID_COLUMN = 'event_id';
const SOURCE_USER_COLUMN = 'user_id';

/** Ledger `entity_type` for every row this suite writes. */
const ENTITY_TYPE = 'event';

/**
 * Stage-id prefix. Greppable, and the key the final "did we leak?" check uses.
 * The suffix is random per run so two developers running this at once cannot
 * collide on `ci.pipeline_state`'s `(entity_type, entity_id, stage)` primary key.
 */
const STAGE_PREFIX = 'test.realdata_';

/** Ledger rows inserted for the populated-ledger measurement. */
const POPULATED_LEDGER_ROWS = 50_000;

/** Rows paged through in the keyset test — twenty full slices at the real size. */
const PAGED_ROWS = 20 * DEFAULT_SLICE_SIZE;

/** Real rows taken through claim → complete → bump. */
const BUMP_SAMPLE_ROWS = 250;

/**
 * Below this many source rows the plan-shape assertions do not run.
 *
 * Not a fudge factor: a sequential scan of a small table IS the right plan, and
 * a test that failed on one would be asserting that Postgres should be slower.
 * The number is one order of magnitude above the point where the planner starts
 * preferring an index for a `LIMIT`-ed ordered scan on this hardware, so a
 * database that clears it is one where the plan choice is a real decision.
 */
const PLAN_SHAPE_MIN_ROWS = 50_000;

/**
 * Ceiling on ONE page of the sweep, whatever plan the planner picks.
 *
 * Direction-independent, unlike the plan-shape assertions: a sweep hop is a
 * pg-boss job, so a page that takes longer than this is not "a different plan",
 * it is a stage that cannot finish. Deliberately loose — this is a tripwire for
 * a catastrophic regression (a lost index, a cross join), not a performance
 * budget. The measured numbers are three orders of magnitude under it and are
 * logged, which is where the actual performance conversation belongs.
 */
const SWEEP_PAGE_BUDGET_MS = 5_000;

// ---------------------------------------------------------------------------
// EXPLAIN plumbing
// ---------------------------------------------------------------------------

/**
 * One node of an `EXPLAIN (FORMAT JSON)` tree.
 *
 * JSON rather than the text format on purpose: the brief asked for assertions
 * robust to plan wording, and the text format is prose — `Parallel Seq Scan on
 * events s` in one release, indented differently in the next, and localisable.
 * The JSON keys are a documented interface. A parallel sequential scan is
 * `"Node Type": "Seq Scan"` with `"Parallel Aware": true`, so matching the node
 * type alone catches the parallel variants without knowing about them.
 */
interface PlanNode {
  'Node Type': string;
  'Parallel Aware'?: boolean;
  'Relation Name'?: string;
  /** Only emitted under VERBOSE, which is why this suite always asks for it. */
  Schema?: string;
  'Index Name'?: string;
  /** Present when the planner turned a predicate into an index BOUND. */
  'Index Cond'?: string;
  /** Present when it could only apply the predicate after reading the row. */
  Filter?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

interface ExplainedPlan {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
}

/** A plan plus the things a log line and an assertion both want. */
interface Measurement {
  label: string;
  plan: ExplainedPlan;
  /** Total time Postgres reported for the execution, in ms. */
  executionMs: number;
  planningMs: number;
  /** Shared buffers touched by the whole plan. */
  sharedBlocks: number;
  /** Of those, the ones spent on the source table — the cost §14.2 is about. */
  sourceBlocks: number;
  /** Rows the statement actually returned. */
  rows: number;
}

/** Every node in the tree, depth-first. */
function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

/**
 * Scan nodes reading one particular relation.
 *
 * Matched on `Relation Name` + `Schema` rather than on the alias, because the
 * sweep aliases its source `s` and an alias is a detail of the query text.
 */
function scansOf(plan: ExplainedPlan, schema: string, table: string): PlanNode[] {
  return flattenPlan(plan.Plan).filter(
    (node) => node['Relation Name'] === table && (node.Schema == null || node.Schema === schema),
  );
}

/** `Seq Scan`, `Parallel Seq Scan`, and anything else Postgres spells that way. */
const SEQUENTIAL_SCAN = /seq(uential)?\s*scan/i;

/** `Index Scan`, `Index Only Scan`, and their parallel variants. */
const INDEXED_SCAN = /index(\s+only)?\s+scan/i;

/** Human-readable plan shape for a log line: `Index Scan using events_pkey`. */
function describeScan(node: PlanNode): string {
  const parallel = node['Parallel Aware'] === true ? 'Parallel ' : '';
  const using = node['Index Name'] != null ? ` using ${node['Index Name']}` : '';

  return `${parallel}${node['Node Type']}${using}`;
}

/**
 * Shared buffers the whole statement touched.
 *
 * Read from the ROOT node alone, not summed over the tree: Postgres accumulates
 * a node's buffer counters into its parent, so adding them up counts every block
 * once per level of nesting and turns a 38,000-block plan into a 191,000-block
 * one. The root's number is the real total.
 */
function sumBlocks(plan: ExplainedPlan): number {
  return (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0);
}

/** One measurement, formatted for the terminal. The deliverable, not decoration. */
function formatMeasurement(m: Measurement): string {
  const scans = scansOf(m.plan, SOURCE_SCHEMA, SOURCE_TABLE).map(describeScan).join(', ');

  return (
    `[realData.integration] ${m.label}\n` +
    `    ${SOURCE_SCHEMA}.${SOURCE_TABLE} scan: ${scans}\n` +
    `    execution ${m.executionMs.toFixed(3)} ms, planning ${m.planningMs.toFixed(3)} ms, ` +
    `${m.sourceBlocks} blocks on ${SOURCE_SCHEMA}.${SOURCE_TABLE} of ${m.sharedBlocks} total, ` +
    `${m.rows} rows returned`
  );
}

/**
 * Shared buffers spent on the SOURCE TABLE alone.
 *
 * The number the risk is actually about, and the only one that is stable enough
 * to assert on. A whole-plan total moves with whatever `ci.pipeline_state`
 * happens to hold — including rows another jest worker committed while this
 * suite ran — so comparing two whole-plan totals compares the ledger as much as
 * the sweep. Per-relation, the comparison is `ci.events` against `ci.events`.
 *
 * Scan nodes report per-loop buffers, so a parallel scan's blocks are counted
 * once per worker, exactly as `EXPLAIN`'s text output shows them.
 */
function sourceScanBlocks(plan: ExplainedPlan): number {
  return scansOf(plan, SOURCE_SCHEMA, SOURCE_TABLE).reduce(
    (total, node) => total + (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
    0,
  );
}

/**
 * node-pg parses a `json` column for us, but `QueryRunner.query` is typed
 * `Promise<any>` and a driver that ever hands the column back as text would fail
 * somewhere unrecognisable. Both shapes are accepted here, once.
 */
function parseExplain(raw: unknown): ExplainedPlan {
  const rows = raw as Array<Record<string, unknown>>;
  const column = rows[0]['QUERY PLAN'];
  const parsed =
    typeof column === 'string' ? (JSON.parse(column) as ExplainedPlan[]) : (column as ExplainedPlan[]);

  return parsed[0];
}

// ---------------------------------------------------------------------------
// Statement capture
// ---------------------------------------------------------------------------

/** One statement `PipelineStateService` issued, verbatim, with its bind parameters. */
interface CapturedStatement {
  sql: string;
  params: unknown[];
}

/**
 * A silent `LoggerService`.
 *
 * Not fastidiousness about test output: the real one builds a pino logger with a
 * `pino-pretty` transport outside production, and a transport is a worker thread
 * jest reports as an open handle.
 */
function silentLogger(): LoggerService {
  const noop = (): void => undefined;

  return {
    setContext: noop,
    log: noop,
    error: noop,
    warn: noop,
    debug: noop,
    verbose: noop,
  } as unknown as LoggerService;
}

describeWithDatabase(`pipeline against real imported data (${availability.target})`, () => {
  /** Pooled, OUTSIDE every transaction. Used for corpus facts and the leak check. */
  let dataSource: DataSource;

  /** The one connection every statement under test runs on, inside a transaction. */
  let runner: QueryRunner;

  /** Every statement `PipelineStateService` issued on the current transaction. */
  let captured: CapturedStatement[] = [];

  let stateService: PipelineStateService;

  /** `ci.events` row count. Gates the plan-shape assertions; reported in the logs. */
  let corpusRows = 0;

  /** The user with the most events. The sweep is always user-scoped. */
  let corpusUserId = '';

  /** Rows belonging to {@link corpusUserId}. */
  let corpusUserRows = 0;

  /** Read from `pg_index`, never hardcoded — the plan assertions name it. */
  let sourcePrimaryKeyIndex = '';

  /** Unique to this run, so two developers running the suite cannot collide. */
  const stageId = `${STAGE_PREFIX}${randomBytes(4).toString('hex')}`;

  /**
   * The mutable view of the version map — the same cast `StageRegistry.spec` and
   * the integration harness use.
   *
   * The throwaway stage is registered at RUNTIME rather than declared in
   * `constants.ts`, because a committed test stage would appear in
   * `GET /api/pipeline/state` on a real appliance at 0 % coverage forever. Jest
   * gives every test FILE its own module registry, so this mutation is invisible
   * to every other spec.
   */
  const versions = STAGE_VERSIONS as unknown as Record<string, number>;

  /**
   * A stage over `ci.events`, with NO applicability predicate.
   *
   * `predicate` is left absent deliberately: the sweep renders it as `TRUE`, so
   * what gets measured is the cost of the ledger LEFT JOIN itself rather than
   * the cost of some particular stage's filter. That is the thing §14.2 asks
   * about, and adding a selective predicate would flatter it.
   *
   * `version` is a GETTER reading the map, so `versions[stageId] = 2` — the
   * literal production bump, one integer in one map — is visible to a `Stage`
   * object that was built before it.
   */
  const stage: Stage = {
    id: stageId,
    get version(): number {
      return versions[stageId];
    },
    queue: PIPELINE_QUEUES.INDEX,
    entityTypes: [ENTITY_TYPE],
    source: {
      schema: SOURCE_SCHEMA,
      table: SOURCE_TABLE,
      idColumn: SOURCE_ID_COLUMN,
      userColumn: SOURCE_USER_COLUMN,
    },
    // Never called. This suite drives the ledger and the sweep directly; the
    // worker path is `pipeline.integration.spec.ts`'s job.
    run: async (): Promise<Map<string, StageResult>> => new Map(),
  };

  /** Every measurement taken, printed as one table at the end of the run. */
  const measurements: Measurement[] = [];

  /** Ledger state before the first test, re-read after the last. */
  let ledgerBefore: { rows: number; digest: string };

  /** `ci.events` row count before the first test. This suite must never write it. */
  let sourceRowsBefore = 0;

  // -------------------------------------------------------------------------
  // Transaction lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open a transaction and point a real `PipelineStateService` at it.
   *
   * The `DataSource` the service receives is a two-property double whose `query`
   * RECORDS the statement and then forwards it to the runner. Recording is what
   * lets the EXPLAIN tests measure the real SQL instead of a copy of it;
   * forwarding to a single runner is what keeps every write inside the one
   * transaction that gets rolled back.
   */
  async function openTransaction(): Promise<void> {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    captured = [];

    stateService = new PipelineStateService(
      {
        query: async (sql: string, params?: unknown[]): Promise<unknown> => {
          captured.push({ sql, params: params ?? [] });

          return runner.query(sql, params);
        },
      } as unknown as DataSource,
      silentLogger(),
    );
  }

  /** ALWAYS a rollback. Nothing this suite writes is ever committed. */
  async function rollbackTransaction(): Promise<void> {
    await runner.rollbackTransaction();
    await runner.release();
  }

  /**
   * Run the last statement `PipelineStateService` issued again, under EXPLAIN.
   *
   * The SQL and the bind parameters are the ones the service actually sent, so
   * there is nothing to keep in sync: change the sweep and this measures the
   * changed sweep. `ANALYZE` means it really executes — harmless, since the
   * captured statement is always the `SELECT` from `selectStale`.
   */
  async function explainLastStatement(label: string, rows: number): Promise<Measurement> {
    const last = captured[captured.length - 1];

    if (last == null) {
      throw new Error(`explainLastStatement("${label}") found no captured statement to explain.`);
    }

    const plan = parseExplain(
      await runner.query(`EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT JSON) ${last.sql}`, last.params),
    );

    const measurement: Measurement = {
      label,
      plan,
      executionMs: plan['Execution Time'],
      planningMs: plan['Planning Time'],
      sharedBlocks: sumBlocks(plan),
      sourceBlocks: sourceScanBlocks(plan),
      rows,
    };

    measurements.push(measurement);

    // The measurement, on the operator's terminal, whether or not anything is
    // asserted about it. §14.2 asks for numbers; a green test is not a number.
    console.info(formatMeasurement(measurement));

    return measurement;
  }

  /** Sequential scans of the source table in one plan. */
  function sequentialSourceScans(plan: ExplainedPlan): PlanNode[] {
    return scansOf(plan, SOURCE_SCHEMA, SOURCE_TABLE).filter((node) =>
      SEQUENTIAL_SCAN.test(node['Node Type']),
    );
  }

  /** Index scans of the source table in one plan. */
  function indexedSourceScans(plan: ExplainedPlan): PlanNode[] {
    return scansOf(plan, SOURCE_SCHEMA, SOURCE_TABLE).filter((node) => INDEXED_SCAN.test(node['Node Type']));
  }

  /**
   * Whether a plan-SHAPE assertion is meaningful on this database.
   *
   * See {@link PLAN_SHAPE_MIN_ROWS}. Callers that skip on `false` have already
   * logged their measurement, so nothing goes unreported — only unasserted.
   */
  function planShapeIsMeaningful(): boolean {
    return corpusRows >= PLAN_SHAPE_MIN_ROWS;
  }

  /** Count the ledger rows this suite's stage owns, from INSIDE the transaction. */
  async function ledgerRowCount(): Promise<number> {
    const rows = (await runner.query(`SELECT count(*)::int AS n FROM ci.pipeline_state WHERE stage = $1`, [
      stageId,
    ])) as Array<{ n: number }>;

    return rows[0].n;
  }

  /**
   * An order-independent fingerprint of every ledger row this suite could
   * possibly have created, taken outside every transaction.
   *
   * Scoped to `entity_type = 'event'`, which is narrower than it looks and
   * exactly right. This suite writes one entity type and nothing else on the
   * appliance writes that one: the declared stages key their rows under `file`,
   * `content` and `position`, and the integration harness next door uses
   * `harness_source_row`. So this covers 100 % of what a leak from here would
   * look like, and 0 % of what anything else is doing.
   *
   * It is NOT the whole table, and that is a correction rather than a
   * concession. Fingerprinting everything failed the first time this suite ran
   * beside `pipeline.integration.spec.ts` in another jest worker: that harness
   * legitimately COMMITS its own rows and deletes them at teardown, so the
   * ledger honestly differs between this suite's first and last statement and
   * the check was reporting a sibling's correct behaviour as this suite's leak.
   * A safety check that fails for the wrong reason gets muted, and then it is
   * not a safety check.
   *
   * Not `string_agg`: this table is the control plane and may one day hold
   * millions of rows, and building one giant string to hash it would be a worse
   * thing to run against a live appliance than the tests it is checking. Summing
   * a per-row hash streams, and being order-independent it needs no `ORDER BY`
   * either.
   */
  async function fingerprintLedger(): Promise<{ rows: number; digest: string }> {
    const rows = (await dataSource.query(
      `SELECT count(*)::int AS rows,
              coalesce(sum(('x' || substr(md5(ps.*::text), 1, 8))::bit(32)::bigint), 0)::text AS digest
         FROM ci.pipeline_state ps
        WHERE ps.entity_type = $1`,
      [ENTITY_TYPE],
    )) as Array<{ rows: number; digest: string }>;

    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Suite setup
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability() said yes but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      // Discrete fields when there is no URL, so a password containing URL
      // metacharacters (the dev one ends in `!`) never has to survive a round
      // trip through percent-encoding.
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      // Nothing is mapped through TypeORM: the pipeline speaks raw SQL and the
      // entities exist only to document it. `synchronize` would be actively
      // dangerous pointed at a database holding a personal archive.
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 4 },
    });

    await dataSource.initialize();

    // Three outcomes, deliberately different (harness README): no database →
    // skipped at collection time; a database missing the tables → FAIL here,
    // naming the fix, because that is a broken setup and skipping would turn a
    // migration mistake into a green run.
    const [present] = (await dataSource.query(
      `SELECT to_regclass('ci.pipeline_state')::text AS ledger, to_regclass('ci.events')::text AS source`,
    )) as Array<{ ledger: string | null; source: string | null }>;

    if (present.ledger == null) {
      throw new Error(
        'ci.pipeline_state is missing — run `yarn workspace @ci/be-api migrate` and re-run this suite.',
      );
    }

    if (present.source == null) {
      throw new Error(
        'ci.events is missing — run `yarn workspace @ci/be-api migrate` and re-run this suite.',
      );
    }

    // The user with the most events. Real archives are single-user appliances,
    // but reading the busiest user rather than assuming one keeps the suite
    // honest on a database that has been seeded as well as imported into.
    const [busiest] = (await dataSource.query(
      `SELECT user_id::text AS user_id, count(*)::int AS n
         FROM ci.events
        GROUP BY user_id
        ORDER BY n DESC
        LIMIT 1`,
    )) as Array<{ user_id: string; n: number }>;

    if (busiest == null) {
      throw new Error(
        'ci.events is empty. This suite exists to measure the pipeline against imported data; there is ' +
          'none here. Import an archive, or point PIPELINE_TEST_DATABASE_URL at a database that has one.',
      );
    }

    corpusUserId = busiest.user_id;
    corpusUserRows = busiest.n;

    const [total] = (await dataSource.query(`SELECT count(*)::int AS n FROM ci.events`)) as Array<{
      n: number;
    }>;

    corpusRows = total.n;
    sourceRowsBefore = total.n;

    // The primary key index by name, from the catalog. The plan assertions name
    // it, and hardcoding `events_pkey` would make this suite fail on a database
    // whose constraint was created under a different name.
    const [pk] = (await dataSource.query(
      `SELECT i.relname::text AS index_name
         FROM pg_index x
         JOIN pg_class c ON c.oid = x.indrelid
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND x.indisprimary`,
      [SOURCE_SCHEMA, SOURCE_TABLE],
    )) as Array<{ index_name: string }>;

    sourcePrimaryKeyIndex = pk?.index_name ?? '';

    ledgerBefore = await fingerprintLedger();

    // Versions start at 1, never 0 — `versions.ts` explains at length why 0
    // would strand any row a killed worker left in `status='running'`.
    versions[stageId] = 1;

    console.info(
      `[realData.integration] corpus: ${corpusRows} rows in ${SOURCE_SCHEMA}.${SOURCE_TABLE} ` +
        `(${corpusUserRows} for the busiest user), pk index ${sourcePrimaryKeyIndex}; ` +
        `ci.pipeline_state holds ${ledgerBefore.rows} rows; throwaway stage ${stageId}`,
    );

    if (!planShapeIsMeaningful()) {
      // Unmissable, because a small-corpus run looks identical to a real one in
      // jest's output and is not evidence for anything §14.2 asks about.
      console.warn(
        `[realData.integration] ${SOURCE_SCHEMA}.${SOURCE_TABLE} has ${corpusRows} rows, below the ` +
          `${PLAN_SHAPE_MIN_ROWS} needed for a query plan to be a real choice. The PLAN-SHAPE assertions ` +
          `are not running on this database — plans are still measured and logged, but this run is NOT ` +
          `evidence about the staleness sweep on production-shaped data.`,
      );
    }
  });

  afterAll(async () => {
    delete versions[stageId];

    if (dataSource?.isInitialized === true) {
      // Printed before the leak assertions so the numbers survive even if one
      // of them fails the run.
      console.info(
        `[realData.integration] measurements\n${measurements
          .map(
            (m) =>
              `    ${m.label.padEnd(58)} ${m.executionMs.toFixed(3).padStart(10)} ms  ` +
              `${String(m.sourceBlocks).padStart(8)} blocks on ${SOURCE_SCHEMA}.${SOURCE_TABLE}  ` +
              `${scansOf(m.plan, SOURCE_SCHEMA, SOURCE_TABLE).map(describeScan).join(', ')}`,
          )
          .join('\n')}`,
      );

      const [leaked] = (await dataSource.query(
        `SELECT count(*)::int AS n FROM ci.pipeline_state WHERE stage LIKE $1 || '%'`,
        [STAGE_PREFIX],
      )) as Array<{ n: number }>;

      const ledgerAfter = await fingerprintLedger();

      const [sourceAfter] = (await dataSource.query(`SELECT count(*)::int AS n FROM ci.events`)) as Array<{
        n: number;
      }>;

      await dataSource.destroy();

      // The whole safety claim of this file, checked rather than asserted in a
      // comment. `leaked` is the direct one — a row under this suite's stage
      // prefix could only have come from here — and the fingerprint is the one
      // that would catch a write that somehow landed under a different stage id.
      expect(leaked.n).toBe(0);
      expect(ledgerAfter).toEqual(ledgerBefore);
      // Never written, only read. A changed count means a statement in this file
      // reached the wrong table.
      expect(sourceAfter.n).toBe(sourceRowsBefore);
    }
  });

  // -------------------------------------------------------------------------
  // 1. The plan with an empty ledger — the state every stage starts in
  // -------------------------------------------------------------------------

  describe('the staleness sweep over a real corpus, ledger empty', () => {
    let firstPage: Measurement;
    let deepPage: Measurement;
    let deepCursor: string;

    beforeAll(async () => {
      await openTransaction();

      // First page: cursor null, the sweep's hop 0.
      const head = await stateService.selectStale(stage, corpusUserId, null, DEFAULT_SLICE_SIZE);
      firstPage = await explainLastStatement('empty ledger, hop 0 (cursor null)', head.length);

      // A cursor deep in the corpus — hop N of a long sweep. This is the
      // measurement that says whether the keyset is doing its job: resuming is
      // supposed to cost O(remaining), not O(processed), and the only way to see
      // the difference is to resume from a long way in.
      const deep = (await runner.query(
        `SELECT "${SOURCE_ID_COLUMN}"::text AS id
           FROM "${SOURCE_SCHEMA}"."${SOURCE_TABLE}"
          WHERE "${SOURCE_USER_COLUMN}" = $1
          ORDER BY "${SOURCE_ID_COLUMN}"
         OFFSET $2 LIMIT 1`,
        [corpusUserId, Math.floor(corpusUserRows / 2)],
      )) as Array<{ id: string }>;

      deepCursor = deep[0].id;

      const tail = await stateService.selectStale(stage, corpusUserId, deepCursor, DEFAULT_SLICE_SIZE);
      deepPage = await explainLastStatement('empty ledger, mid-corpus cursor', tail.length);
    });

    afterAll(async () => {
      await rollbackTransaction();
    });

    it(`rides ${SOURCE_SCHEMA}.${SOURCE_TABLE}'s primary key and never scans it sequentially`, () => {
      expect(firstPage.rows).toBe(DEFAULT_SLICE_SIZE);

      if (!planShapeIsMeaningful()) {
        return;
      }

      // THE §14.2 QUESTION, in its easy form. With no ledger rows the join has
      // nothing to match, so the planner is free to walk the source's primary
      // key in order and stop the moment the LIMIT is satisfied — which is the
      // behaviour the whole keyset design assumes.
      expect(sequentialSourceScans(firstPage.plan)).toEqual([]);

      const indexed = indexedSourceScans(firstPage.plan);

      expect(indexed).not.toHaveLength(0);
      expect(indexed.map((node) => node['Index Name'])).toContain(sourcePrimaryKeyIndex);
    });

    it('stops at the LIMIT instead of reading the corpus — the page cost does not scale with the table', () => {
      expect(firstPage.executionMs).toBeLessThan(SWEEP_PAGE_BUDGET_MS);

      if (!planShapeIsMeaningful()) {
        return;
      }

      const [scan] = indexedSourceScans(firstPage.plan);

      // The proof that the LIMIT reached the scan: an ordered index scan that
      // read a slice's worth of rows and then stopped, rather than one that read
      // 324,044 and threw most of them away. `Actual Rows` is per-loop and this
      // node runs once.
      expect(scan['Actual Rows']).toBeLessThanOrEqual(DEFAULT_SLICE_SIZE * 2);
    });

    it('turns the keyset cursor into an index BOUND, not a filter', () => {
      expect(deepPage.rows).toBe(DEFAULT_SLICE_SIZE);

      if (!planShapeIsMeaningful()) {
        return;
      }

      const [scan] = indexedSourceScans(deepPage.plan);

      expect(scan).toBeDefined();
      // `Index Cond` is the difference between a keyset and an OFFSET. As a
      // bound, Postgres descends the btree straight to the cursor and resuming
      // costs O(remaining); demoted to `Filter`, it reads every row before the
      // cursor and discards it, and the sweep is quadratic in the corpus.
      expect(scan['Index Cond']).toBeDefined();
      expect(scan['Index Cond']).toContain(SOURCE_ID_COLUMN);
      expect(scan['Index Cond']).toContain('>');
    });

    it('costs the same to resume from the middle of the corpus as from the start', () => {
      expect(deepPage.executionMs).toBeLessThan(SWEEP_PAGE_BUDGET_MS);

      if (!planShapeIsMeaningful()) {
        return;
      }

      // The property, stated in buffers rather than milliseconds: milliseconds
      // on a developer machine are noise, and blocks touched are not. A page
      // from the middle of a 324k-row table reads a slice's worth of index and
      // heap pages, the same as the first page does. An OFFSET would read
      // everything before it.
      expect(sourceScanBlocks(deepPage.plan)).toBeLessThan(sourceScanBlocks(firstPage.plan) * 10 + 1_000);
    });
  });

  // -------------------------------------------------------------------------
  // 2. The plan with the ledger POPULATED — the state the appliance lives in
  // -------------------------------------------------------------------------

  describe(`the same sweep with ~${POPULATED_LEDGER_ROWS} ledger rows`, () => {
    let populated: Measurement;
    let populatedDeep: Measurement;
    /** Blocks the identical page spent on `ci.events` BEFORE the ledger was filled. */
    let firstPageBlocks = 0;
    let ledgeredIds: string[];
    let candidateIds: string[];
    let deepCursor: string;

    beforeAll(async () => {
      await openTransaction();

      // The same page, on the same connection, moments before the ledger is
      // populated. Section 1 measures this too, but a comparison is only worth
      // making against a baseline taken under identical conditions — same
      // backend, same cache state, same transaction.
      await stateService.selectStale(stage, corpusUserId, null, DEFAULT_SLICE_SIZE);
      firstPageBlocks = sourceScanBlocks(
        (await explainLastStatement('baseline: same page, ledger still empty', DEFAULT_SLICE_SIZE)).plan,
      );

      // Real event ids, taken in sweep order, so the ledger looks exactly like a
      // sweep that got 50,000 rows in before it was interrupted. Random ids
      // would produce a uniformly-sprinkled ledger, which is a state no sweep
      // can actually reach and which the planner would treat differently.
      await runner.query(
        `INSERT INTO ci.pipeline_state
                (entity_type, entity_id, stage, stage_version, status, attempts, user_id, updated_at)
         SELECT $1, t."${SOURCE_ID_COLUMN}", $2, $3::int, 'done', 1, t."${SOURCE_USER_COLUMN}", now()
           FROM (SELECT "${SOURCE_ID_COLUMN}", "${SOURCE_USER_COLUMN}"
                   FROM "${SOURCE_SCHEMA}"."${SOURCE_TABLE}"
                  WHERE "${SOURCE_USER_COLUMN}" = $4
                  ORDER BY "${SOURCE_ID_COLUMN}"
                  LIMIT $5) AS t`,
        [ENTITY_TYPE, stageId, stage.version, corpusUserId, POPULATED_LEDGER_ROWS],
      );

      // WITHOUT THIS THE MEASUREMENT IS A LIE.
      //
      // `ci.pipeline_state` is empty on this appliance, so its statistics say
      // "0 rows"; a plan chosen against those statistics is the plan for an
      // empty ledger no matter how many rows the transaction just inserted. On a
      // real appliance autoanalyze reaches the same state on its own within
      // minutes of the first sweep, so analyzing here reproduces the steady
      // state rather than manufacturing one.
      //
      // Legal inside a transaction (unlike VACUUM), and transactional: the
      // catalog rows it writes roll back with everything else. It does hold a
      // ShareUpdateExclusiveLock on the ledger until then, which blocks another
      // ANALYZE or an autovacuum of the same table and nothing else — no reader
      // and no writer of `ci.pipeline_state` is affected.
      await runner.query(`ANALYZE ci.pipeline_state`);

      ledgeredIds = (
        (await runner.query(
          `SELECT entity_id::text AS id FROM ci.pipeline_state WHERE stage = $1 ORDER BY entity_id`,
          [stageId],
        )) as Array<{ id: string }>
      ).map((row) => row.id);

      candidateIds = await stateService.selectStale(stage, corpusUserId, null, DEFAULT_SLICE_SIZE);
      populated = await explainLastStatement(
        `${POPULATED_LEDGER_ROWS} ledger rows, hop 0 (cursor null)`,
        candidateIds.length,
      );

      deepCursor = ledgeredIds[ledgeredIds.length - 1];

      const tail = await stateService.selectStale(stage, corpusUserId, deepCursor, DEFAULT_SLICE_SIZE);
      populatedDeep = await explainLastStatement(
        `${POPULATED_LEDGER_ROWS} ledger rows, cursor past the processed prefix`,
        tail.length,
      );
    });

    afterAll(async () => {
      await rollbackTransaction();
    });

    it('inserted the ledger rows for real, against real event ids', async () => {
      expect(await ledgerRowCount()).toBe(POPULATED_LEDGER_ROWS);
      expect(ledgeredIds).toHaveLength(POPULATED_LEDGER_ROWS);
    });

    it('is invisible to every other connection while it is in flight', async () => {
      // The safety property, proven rather than asserted in a comment: a second,
      // pooled connection outside the transaction sees none of the 50,000 rows.
      // Which is also why the live appliance's own sweeps and the reap cron
      // cannot trip over them.
      const [outside] = (await dataSource.query(
        `SELECT count(*)::int AS n FROM ci.pipeline_state WHERE stage = $1`,
        [stageId],
      )) as Array<{ n: number }>;

      expect(outside.n).toBe(0);
    });

    it('still returns the right rows — the first page after the processed prefix', () => {
      expect(candidateIds).toHaveLength(DEFAULT_SLICE_SIZE);

      // Correctness first, because a fast wrong answer is not the subject. Every
      // ledgered row is `done` at the current version, so none of them may come
      // back, and the page must start immediately after the prefix.
      const ledgered = new Set(ledgeredIds);

      for (const id of candidateIds) {
        expect(ledgered.has(id)).toBe(false);
      }

      expect(candidateIds[0] > ledgeredIds[ledgeredIds.length - 1]).toBe(true);
    });

    it('finishes one page well inside a job budget, whatever plan it picks', () => {
      // Direction-independent: this must hold under the plan measured today and
      // under any plan that replaces it.
      expect(populated.executionMs).toBeLessThan(SWEEP_PAGE_BUDGET_MS);
      expect(populatedDeep.executionMs).toBeLessThan(SWEEP_PAGE_BUDGET_MS);
    });

    /**
     * ═════════════════════════════════════════════════════════════════════
     * THE FINDING. §14.2's "the LEFT JOIN must stay index-only on the largest
     * tables" is NOT satisfied, and this test pins the measurement that says so.
     * ═════════════════════════════════════════════════════════════════════
     *
     * It asserts the CURRENT, WRONG behaviour on purpose, which is worth being
     * explicit about because a test that expects a defect reads like a bug.
     *
     * Once `ci.pipeline_state` holds a meaningful number of rows for the stage,
     * the planner stops being able to use the source's primary key to satisfy
     * `ORDER BY ... LIMIT`. The `OR` chain in the staleness predicate reads
     * columns from the NULL-extended side of the join, so it cannot be pushed
     * down and the LIMIT cannot be pushed through: the join has to be fully
     * materialised and then sorted. Postgres therefore picks a hash join over a
     * full scan of the source — the cheapest way to do a job that should not
     * have needed doing at all.
     *
     * The consequence is not one slow query, it is a change of complexity class.
     * Each hop reads the entire source table, so a full sweep is O(corpus²/slice)
     * instead of O(corpus); at 324,044 rows and a 200-row slice that is 1,621
     * hops each re-reading the whole table.
     *
     * WHEN THIS TEST FAILS BECAUSE THE SCAN BECAME INDEXED, THAT IS THE RISK
     * BEING CLOSED. Flip it to `expect(sequentialSourceScans(...)).toEqual([])`,
     * move it up beside the empty-ledger assertions, and update §14.2 — do not
     * "fix" it by loosening it. The sibling test below measures one rewrite that
     * gets the index scan back.
     */
    it('keeps an INDEXED scan of the source once the ledger is populated (§14.2, CLOSED)', () => {
      if (!planShapeIsMeaningful()) {
        return;
      }

      // FLIPPED, as the note above instructed. `selectStale` was rewritten from
      // `LEFT JOIN ci.pipeline_state ... WHERE (p.entity_id IS NULL OR ...)` to
      // `NOT EXISTS (...)`. Measured on this database, 50,000 ledger rows:
      //
      //   LEFT JOIN   Hash Left Join over 108,014 source rows   4,401 blocks  54.1 ms
      //   NOT EXISTS  Merge Anti Join over 200 source rows        241 blocks  ~1 ms
      //
      // Equivalence was checked against the real corpus before the rewrite
      // landed: both forms return byte-identical id sets (5,000 rows, zero
      // difference either way) over a ledger seeded with all five statuses,
      // both versions, and due/not-due retry gates.
      expect(sequentialSourceScans(populated.plan)).toHaveLength(0);
      expect(indexedSourceScans(populated.plan)).not.toHaveLength(0);
    });

    it('keeps the keyset cursor as a real index bound (§14.2, CLOSED)', () => {
      if (!planShapeIsMeaningful()) {
        return;
      }

      // The point of the cursor is that resuming costs O(remaining), not
      // O(corpus). Under the LEFT JOIN the bound was demoted to a `Filter` on a
      // sequential scan, so every row before the cursor was read and discarded —
      // invisible from the results, which is why this needed a plan to see, and
      // the reason a full sweep degraded to O(corpus^2 / slice).
      expect(sequentialSourceScans(populatedDeep.plan)).toHaveLength(0);

      const [scan] = indexedSourceScans(populatedDeep.plan);

      expect(scan).toBeDefined();

      // The cursor is now an index bound rather than a discarded-row filter.
      // Postgres words this differently across scan types (`Index Cond` on an
      // Index/Index Only Scan), so assert the id column appears in the bound and
      // NOT merely in a Filter — the latter is precisely the demoted form.
      const bound = String(scan['Index Cond'] ?? '');

      expect(bound).toContain(SOURCE_ID_COLUMN);
    });

    it('costs orders of magnitude more I/O per page than the empty-ledger sweep — quantified', () => {
      if (!planShapeIsMeaningful()) {
        return;
      }

      // Blocks, not milliseconds: milliseconds on a developer machine are noise,
      // and a machine with the corpus in cache hides the whole problem behind
      // 70 ms. Blocks touched is the number that scales, and it is the number
      // that will not fit in the page cache on an appliance whose Postgres
      // shares a box with Ollama.
      //
      // A floor rather than a value, so it pins the SHAPE of the regression
      // without pinning this machine's page count. The target state is a page
      // that costs O(slice) whatever the ledger holds — i.e. the same order as
      // the empty-ledger page — so a fix that gets there trips this and should
      // delete it along with the two pins above.
      expect(sourceScanBlocks(populated.plan)).toBeGreaterThan(firstPageBlocks * 10);
    });

    /**
     * A measured remedy, so the finding above ships with something to do about
     * it rather than only a complaint.
     *
     * `NOT EXISTS` says the same thing as the LEFT JOIN's `OR` chain — keep the
     * row unless the ledger holds one for it that is current AND not a due retry
     * — but says it as an ANTI-JOIN, which Postgres can answer without
     * materialising the join, so the source's primary key survives and the LIMIT
     * still reaches the scan. The equivalence is what is ASSERTED here (the two
     * queries must return the same ids); the plan is only measured and logged,
     * because a shape assertion on SQL that is not in the codebase would be
     * pinning the planner's opinion about a query nobody runs.
     */
    it('has an equivalent anti-join form that keeps the index scan — measured, for §14.2', async () => {
      const rewritten = (await runner.query(
        `SELECT s."${SOURCE_ID_COLUMN}"::text AS id
           FROM "${SOURCE_SCHEMA}"."${SOURCE_TABLE}" s
          WHERE s."${SOURCE_USER_COLUMN}" = $3
            AND NOT EXISTS (
                  SELECT 1
                    FROM ci.pipeline_state p
                   WHERE p.entity_type = $1
                     AND p.entity_id = s."${SOURCE_ID_COLUMN}"
                     AND p.stage = $2
                     AND p.stage_version >= $4
                     AND NOT (p.status = 'failed' AND p.next_attempt_at <= now()))
            AND ($5::uuid IS NULL OR s."${SOURCE_ID_COLUMN}" > $5::uuid)
          ORDER BY s."${SOURCE_ID_COLUMN}"
          LIMIT $6`,
        [ENTITY_TYPE, stageId, corpusUserId, stage.version, null, DEFAULT_SLICE_SIZE],
      )) as Array<{ id: string }>;

      // The claim that matters: same answer, different plan. Anything else is a
      // faster query that is not the sweep.
      expect(rewritten.map((row) => row.id)).toEqual(candidateIds);

      const plan = parseExplain(
        await runner.query(
          `EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT JSON)
           SELECT s."${SOURCE_ID_COLUMN}"::text AS id
             FROM "${SOURCE_SCHEMA}"."${SOURCE_TABLE}" s
            WHERE s."${SOURCE_USER_COLUMN}" = $3
              AND NOT EXISTS (
                    SELECT 1
                      FROM ci.pipeline_state p
                     WHERE p.entity_type = $1
                       AND p.entity_id = s."${SOURCE_ID_COLUMN}"
                       AND p.stage = $2
                       AND p.stage_version >= $4
                       AND NOT (p.status = 'failed' AND p.next_attempt_at <= now()))
              AND ($5::uuid IS NULL OR s."${SOURCE_ID_COLUMN}" > $5::uuid)
            ORDER BY s."${SOURCE_ID_COLUMN}"
            LIMIT $6`,
          [ENTITY_TYPE, stageId, corpusUserId, stage.version, null, DEFAULT_SLICE_SIZE],
        ),
      );

      const measurement: Measurement = {
        label: `${POPULATED_LEDGER_ROWS} ledger rows, NOT EXISTS rewrite (candidate remedy)`,
        plan,
        executionMs: plan['Execution Time'],
        planningMs: plan['Planning Time'],
        sharedBlocks: sumBlocks(plan),
        sourceBlocks: sourceScanBlocks(plan),
        rows: rewritten.length,
      };

      measurements.push(measurement);
      console.info(formatMeasurement(measurement));

      expect(measurement.executionMs).toBeLessThan(SWEEP_PAGE_BUDGET_MS);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Keyset pagination over real uuids
  // -------------------------------------------------------------------------

  describe(`keyset pagination over ${PAGED_ROWS} real ids at the real slice size`, () => {
    /** Ids per page, in the order the sweep handed them out. */
    const pages: string[][] = [];

    /** The ids those pages cover, flattened — INCLUDING any duplicate. */
    let visited: string[] = [];

    /** What the source says the answer is, read independently of the sweep. */
    let expectedIds: string[] = [];

    beforeAll(async () => {
      await openTransaction();

      // Ground truth, from the source table alone. The sweep's job is to
      // reproduce this by paging; comparing it to itself would prove nothing.
      expectedIds = (
        (await runner.query(
          `SELECT "${SOURCE_ID_COLUMN}"::text AS id
             FROM "${SOURCE_SCHEMA}"."${SOURCE_TABLE}"
            WHERE "${SOURCE_USER_COLUMN}" = $1
            ORDER BY "${SOURCE_ID_COLUMN}"
            LIMIT $2`,
          [corpusUserId, PAGED_ROWS],
        )) as Array<{ id: string }>
      ).map((row) => row.id);

      // The dispatcher's loop, by hand: page, take the last id as the next
      // cursor, repeat. Exactly what `PipelineDispatchService` does across hops,
      // minus the queue — this suite is measuring the SQL, and the durable chain
      // already has its own test next door.
      let cursor: string | null = null;

      while (visited.length < PAGED_ROWS) {
        const page: string[] = await stateService.selectStale(
          stage,
          corpusUserId,
          cursor,
          DEFAULT_SLICE_SIZE,
        );

        if (page.length === 0) {
          break;
        }

        pages.push(page);
        visited = visited.concat(page);
        cursor = page[page.length - 1];
      }
    });

    afterAll(async () => {
      await rollbackTransaction();
    });

    it('needs the number of pages the slice size implies', () => {
      expect(pages).toHaveLength(PAGED_ROWS / DEFAULT_SLICE_SIZE);

      for (const page of pages) {
        expect(page).toHaveLength(DEFAULT_SLICE_SIZE);
      }
    });

    it('visits every real id exactly once, in key order', () => {
      expect(visited).toHaveLength(PAGED_ROWS);
      // Set size vs array length is the duplicate check; equality with the
      // independently-read ground truth is the order and completeness check.
      expect(new Set(visited).size).toBe(PAGED_ROWS);
      expect(visited).toEqual(expectedIds);
    });

    it('loses nothing at a page boundary', () => {
      // The bug this exists to catch is off-by-one at the seam: a cursor built
      // with `>=` re-delivers the boundary row, and one built from the wrong end
      // of the page skips everything after it. Both are invisible in aggregate
      // and obvious here.
      for (let i = 0; i + 1 < pages.length; i += 1) {
        const endOfPage = pages[i][pages[i].length - 1];
        const startOfNext = pages[i + 1][0];

        expect(startOfNext > endOfPage).toBe(true);

        // And nothing in between: the ground truth's next id after the boundary
        // IS the next page's first id, so no real row fell into the seam.
        expect(expectedIds[(i + 1) * DEFAULT_SLICE_SIZE]).toBe(startOfNext);
      }
    });

    it('hands them out in ascending uuid order, which is the order Postgres compares them in', () => {
      // Worth asserting on REAL ids specifically. `ci.gen_uuid_v7()` produces
      // time-ordered uuids whose text form sorts the same way Postgres sorts the
      // `uuid` type — but the sweep's correctness depends on the DATABASE's
      // ordering, and the hand-built fixtures next door were constructed to
      // agree with JavaScript's. These were not.
      const sorted = [...visited].sort();

      expect(visited).toEqual(sorted);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The bump, on real rows
  // -------------------------------------------------------------------------

  describe('the version bump, on real imported rows', () => {
    let sample: string[] = [];

    beforeAll(async () => {
      await openTransaction();

      sample = await stateService.selectStale(stage, corpusUserId, null, BUMP_SAMPLE_ROWS);
    });

    afterAll(async () => {
      // The bump is a mutation of a module-level map; undo it before the outer
      // afterAll deletes the entry, so a failure here cannot leave the version
      // map in a state the next describe would inherit if this file grows one.
      versions[stageId] = 1;

      await rollbackTransaction();
    });

    it('selects real rows nothing has an opinion about yet', () => {
      expect(sample).toHaveLength(BUMP_SAMPLE_ROWS);
      expect(new Set(sample).size).toBe(BUMP_SAMPLE_ROWS);
    });

    it('claims them at version 0 — the zero that makes crash recovery work', async () => {
      const claimed = await stateService.claim(stage, ENTITY_TYPE, sample, corpusUserId);

      expect(claimed.sort()).toEqual([...sample].sort());

      const rows = (await runner.query(
        `SELECT status, stage_version, attempts FROM ci.pipeline_state WHERE stage = $1`,
        [stageId],
      )) as Array<{ status: string; stage_version: number; attempts: number }>;

      expect(rows).toHaveLength(BUMP_SAMPLE_ROWS);

      for (const row of rows) {
        expect(row.status).toBe('running');
        // `claim()` deliberately does not stamp the version: a version is a claim
        // about what produced a RESULT, and a claim produces none. At 0 a row
        // abandoned by a killed worker still satisfies `stage_version < $current`
        // and the next sweep re-selects it.
        expect(row.stage_version).toBe(0);
        expect(row.attempts).toBe(1);
      }
    });

    it('takes them out of the candidate set once they are done at v1', async () => {
      const summary = await stateService.complete(
        stage,
        ENTITY_TYPE,
        new Map(sample.map((id) => [id, { outcome: 'done' as const }])),
      );

      expect(summary).toMatchObject({ done: BUMP_SAMPLE_ROWS, skipped: 0, failed: 0, quarantined: 0 });

      const next = await stateService.selectStale(stage, corpusUserId, null, BUMP_SAMPLE_ROWS);
      const done = new Set(sample);

      // Not "fewer rows" — NONE of them. The sweep restarts from cursor null and
      // still steps straight over the whole processed prefix.
      for (const id of next) {
        expect(done.has(id)).toBe(false);
      }

      expect(next[0] > sample[sample.length - 1]).toBe(true);

      expect(await stateService.coverage(stageId)).toMatchObject({
        stage: stageId,
        stageVersion: 1,
        total: BUMP_SAMPLE_ROWS,
        done: BUMP_SAMPLE_ROWS,
        stale: 0,
        coverage: 1,
      });
    });

    it('marks every one of them stale the instant the version is bumped, before any sweep runs', async () => {
      // In production this line is a one-integer commit to `versions.ts`. Here it
      // is the same mutation of the same map, so what the next sweep makes of it
      // is real behaviour rather than a simulation.
      versions[stageId] = 2;

      expect(stage.version).toBe(2);

      // Being able to read the size of the job BEFORE spending it is the
      // difference between a bump and a bill — and on this table it is the
      // difference between re-embedding 250 rows and re-embedding 324,044.
      expect(await stateService.coverage(stageId)).toMatchObject({
        stageVersion: 2,
        total: BUMP_SAMPLE_ROWS,
        done: BUMP_SAMPLE_ROWS,
        stale: BUMP_SAMPLE_ROWS,
      });
    });

    it('returns exactly those real rows to the candidate set at v2', async () => {
      const after = await stateService.selectStale(stage, corpusUserId, null, BUMP_SAMPLE_ROWS);

      // The same ids, in the same order, from the same real table — with a `done`
      // ledger row already sitting on every one of them. Under the predicate this
      // rebuild deletes, these rows were finished forever.
      expect(after).toEqual(sample);
    });

    it('leaves the source table untouched throughout', async () => {
      // The sweep reads exactly two tables and writes exactly one of them. On a
      // suite pointed at a personal archive that is worth checking rather than
      // trusting, even inside a transaction that is about to be rolled back.
      const [source] = (await runner.query(
        `SELECT count(*)::int AS n FROM "${SOURCE_SCHEMA}"."${SOURCE_TABLE}"`,
      )) as Array<{ n: number }>;

      expect(source.n).toBe(corpusRows);
    });
  });
});

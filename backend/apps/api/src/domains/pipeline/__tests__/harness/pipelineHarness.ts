import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import dotenv from 'dotenv';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  DEFAULT_JOB_PRIORITY,
  EventService,
  type EventPayloads,
  type EventRegistry,
  type EventSendOptions,
} from '@ci/domains/events';

import { PIPELINE_QUEUES, type PipelineQueue } from '../../constants';
import { PipelineSliceEvent, PipelineSweepEvent } from '../../events';
import { PipelineSliceListener } from '../../listeners/PipelineSliceListener';
import { PipelineDispatchService } from '../../services/PipelineDispatchService';
import { PipelineStateService } from '../../services/PipelineStateService';
import { STAGE_REGISTRY, StageRegistry } from '../../services/StageRegistry';
import type { Stage, StageCoverage, StageResult } from '../../types';
import { STAGE_VERSIONS } from '../../versions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PIPELINE INTEGRATION HARNESS — the thing this repo has never had.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every existing pipeline spec is a unit test against a fake `DataSource`:
 * `theOneRule.spec.ts` re-implements the staleness sweep in TypeScript,
 * `PipelineStateService.spec.ts` asserts which parameters get bound, and
 * `PipelineSliceListener.spec.ts` records the order of ledger calls. Those are
 * good tests and they cover things this file cannot. What none of them can
 * cover is the part that actually breaks:
 *
 *  - the SQL is valid Postgres and means what the TypeScript double pretended
 *    it meant — `ON CONFLICT ... WHERE`, `unnest()` over parallel arrays,
 *    `make_interval(secs => ...)`, the `power(2, attempts - 1)` backoff;
 *  - a keyset sweep over MORE ROWS THAN ONE SLICE hands every id out exactly
 *    once, across a self-requeuing chain of hops;
 *  - a second sweep at an unchanged version does ZERO work — the idempotence
 *    property that makes "is my import finished?" answerable;
 *  - bumping the integer in `versions.ts` makes the same rows candidates again
 *    even though the stage's OUTPUT COLUMN is already populated. That is the
 *    entire reason the rebuild exists, and it cannot be demonstrated against a
 *    mock, because a mock will agree with whatever the sweep asks it.
 *
 * ── What is real and what is not ───────────────────────────────────────────
 *
 * REAL: Postgres. `PipelineStateService` (every statement, unmodified),
 * `StageRegistry` (including its resolution guards), `PipelineDispatchService`
 * (the keyset chain and its cursor-advance assertion), `PipelineSliceListener`
 * (claim → run → reconcile → complete, and the throw path that writes
 * `ci.pipeline_dead_letters`), `versions.ts` (`stageVersion`, and the bump).
 *
 * FAKE: pg-boss, replaced by {@link HarnessQueue} — an in-memory queue that
 * records jobs and hands them back in pg-boss's own fetch order
 * (`priority DESC, created_on`). Deliberately NOT `LocalEventService`: that one
 * executes listeners inline at the call site, so the dispatcher's self-requeue
 * becomes direct recursion (see the note on `PipelineDispatchService`) and the
 * FIFO-behind-the-slices ordering the pipeline's backpressure rests on never
 * exists to be observed. A queue drained explicitly reproduces that ordering
 * AND lets a test count hops, count slices, and see which ids each slice
 * carried.
 *
 * FAKE: the stage. One synthetic stage over one synthetic source table, whose
 * per-id decisions the test supplies. Nothing here needs sharp, ffprobe,
 * Ollama, Minio or the worker container — which is the point, since
 * `.github/workflows/e2e.yml` boots none of them.
 *
 * ── How it avoids polluting the dev database ───────────────────────────────
 *
 * The source table lives in a THROWAWAY SCHEMA (`pipeline_harness_<hex>`)
 * created at setup and dropped at teardown, so no real table is ever read or
 * written.
 *
 * The ledger cannot be relocated the same way: `PipelineStateService` writes
 * the literal `ci.pipeline_state`, which is correct (it is THE ledger) and
 * means an integration test necessarily writes real rows. Isolation therefore
 * comes from the KEY instead of the schema. Each harness invents a stage id
 * (`test.harness_<hex>`) that nothing else in the system writes, and
 * `ci.pipeline_state`'s primary key is `(entity_type, entity_id, stage)`. Rows
 * are deleted by that stage id at teardown, and anything left behind by a
 * killed run is reaped on the next setup. The unique stage id is also what
 * makes `PipelineStateService.coverage()` assertable at all: coverage counts by
 * stage across ALL users, so a harness sharing `enrich.media_dimensions` with
 * the live appliance would be counting the operator's own files.
 *
 * ── Skipping when there is no database ─────────────────────────────────────
 *
 * {@link databaseAvailability} answers "can this suite run?" SYNCHRONOUSLY, so
 * a spec can choose `describe` vs `describe.skip` at collection time. Jest has
 * no way to skip a suite from inside an async `beforeAll`, and a suite that
 * "passes" by returning early from every test is worse than one honestly
 * skipped. See the README beside this file.
 */

// The rest of the toolchain (`yarn test`, `yarn dev`, `yarn dbmate`) runs with
// DOTENV_CONFIG_PATH pointing at the repo-root .env, and `src/bootstrap.ts` is
// what turns that into process.env for the running app. Test files never import
// bootstrap, so the same load happens here, at module scope, BEFORE anything
// reads process.env — otherwise the connection would resolve to nothing on a
// developer machine whose credentials live only in .env.
dotenv.config({ path: path.resolve(process.cwd(), process.env.DOTENV_CONFIG_PATH ?? '.env') });

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

/** Where the harness will connect. Never carries a hardcoded credential. */
export interface HarnessConnection {
  /** Present when a full URL was supplied; the discrete fields are parsed from it. */
  url?: string;
  host: string;
  port: number;
  username: string;
  database: string;
  /** Read from the environment. Never defaulted — an absent password means "no database". */
  password: string;
}

/**
 * Defaults that are NOT secrets.
 *
 * `config/default.json` says host `database` because the app runs inside the
 * compose network; jest runs on the host, where the published port is what is
 * reachable — which is why `.env` sets `DATABASE_HOST=localhost`. Defaulting to
 * localhost means a developer with a running stack needs no extra setup, while
 * the password is only ever read, never assumed.
 */
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 5432;
const DEFAULT_USERNAME = 'companion';
const DEFAULT_DATABASE = 'companion';

/**
 * The connection, or `null` when the environment does not describe one.
 *
 * Precedence: an explicit test URL, then the URL the dev-stack supervisor
 * exports, then the discrete `DATABASE_*` variables `config/` already maps.
 * `PIPELINE_TEST_DATABASE_URL` exists so this suite can be pointed at a scratch
 * database without moving the whole app off the dev one.
 */
export function resolveConnection(): HarnessConnection | null {
  const url = process.env.PIPELINE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  if (url != null && url.trim().length > 0) {
    try {
      const parsed = new URL(url);

      return {
        url,
        host: parsed.hostname,
        port: parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_PORT,
        username: decodeURIComponent(parsed.username) || DEFAULT_USERNAME,
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, '') || DEFAULT_DATABASE,
      };
    } catch {
      // A malformed URL is a configuration mistake, not an absent database, but
      // it is reported as unavailable (with the reason) rather than thrown so
      // the suite skips legibly instead of failing every test on a parse error.
      return null;
    }
  }

  const password = process.env.DATABASE_PASSWORD;

  // The one field with no default. Everything else about this database is
  // public knowledge living in config/default.json; the password lives in .env,
  // and its absence is precisely the signal "there is no database here".
  if (password == null || password.length === 0) {
    return null;
  }

  return {
    host: process.env.DATABASE_HOST ?? DEFAULT_HOST,
    port: Number(process.env.DATABASE_PORT ?? DEFAULT_PORT),
    username: process.env.DATABASE_USERNAME ?? DEFAULT_USERNAME,
    database: process.env.DATABASE_NAME ?? DEFAULT_DATABASE,
    password,
  };
}

/** Answer to "can this suite run?", computed without any I/O the caller must await. */
export interface DatabaseAvailability {
  available: boolean;
  /** Human-readable explanation, printed by the spec when it skips. */
  reason: string;
  /** `host:port/database`, never including the password. */
  target: string;
}

/** How long the connectivity probe waits. Overridable for slow or loaded machines. */
const PROBE_TIMEOUT_MS = Number(process.env.PIPELINE_TEST_PROBE_TIMEOUT_MS ?? 2_000);

/**
 * TCP reachability, SYNCHRONOUSLY.
 *
 * A jest suite must choose `describe` vs `describe.skip` while the module is
 * being evaluated, and this file compiles to CommonJS (`jest.config.mjs` →
 * `@swc/jest`), so there is no top-level `await` to reach for. A short-lived
 * child process doing one `net.connect` is the only way to get a real answer at
 * that moment. It costs one process spawn per test file and depends on nothing
 * but a node builtin — notably not `pg`, which the child would have to resolve
 * through Yarn PnP.
 *
 * A TCP handshake proves something is listening, not that it is Postgres with
 * the migrations applied. That split is deliberate: "nothing is listening" is
 * an absent database and must SKIP, whereas "something is listening but the
 * schema is wrong" is a broken setup and must FAIL, with the message from
 * {@link PipelineHarness.start} naming the command that fixes it.
 *
 * Exported for `scratchDatabase.ts`, which needs the same synchronous answer
 * about a server it reaches with different (administrative) credentials.
 */
export function isPortOpen(host: string, port: number, timeoutMs: number): boolean {
  const script =
    "const net = require('node:net');" +
    'const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });' +
    'socket.setTimeout(Number(process.argv[3]));' +
    "socket.on('connect', () => { socket.destroy(); process.exit(0); });" +
    "socket.on('timeout', () => { socket.destroy(); process.exit(1); });" +
    "socket.on('error', () => { process.exit(1); });";

  const probe = spawnSync(process.execPath, ['-e', script, host, String(port), String(timeoutMs)], {
    // Generous relative to the socket's own timeout: this bounds process
    // startup, not the connection, so a merely slow spawn is never misread as
    // an unreachable database.
    timeout: timeoutMs + 5_000,
    stdio: 'ignore',
  });

  return probe.status === 0;
}

let cachedAvailability: DatabaseAvailability | null = null;

/**
 * Whether a Postgres is reachable for this test run. Cached — the probe spawns
 * a process, and a suite may consult it more than once.
 */
export function databaseAvailability(): DatabaseAvailability {
  if (cachedAvailability != null) {
    return cachedAvailability;
  }

  const connection = resolveConnection();

  if (connection == null) {
    cachedAvailability = {
      available: false,
      reason:
        'no database configured — set PIPELINE_TEST_DATABASE_URL or DATABASE_URL, or DATABASE_PASSWORD ' +
        '(plus optional DATABASE_HOST / DATABASE_PORT / DATABASE_USERNAME / DATABASE_NAME). ' +
        '`yarn test` already points DOTENV_CONFIG_PATH at the repo-root .env.',
      target: '(unset)',
    };

    return cachedAvailability;
  }

  const target = `${connection.host}:${connection.port}/${connection.database}`;

  if (!isPortOpen(connection.host, connection.port, PROBE_TIMEOUT_MS)) {
    cachedAvailability = {
      available: false,
      reason: `nothing accepting connections at ${target} (probe timeout ${PROBE_TIMEOUT_MS} ms)`,
      target,
    };

    return cachedAvailability;
  }

  cachedAvailability = { available: true, reason: `Postgres reachable at ${target}`, target };

  return cachedAvailability;
}

// ---------------------------------------------------------------------------
// The in-memory queue
// ---------------------------------------------------------------------------

/** One enqueued job, as pg-boss would hold it. */
export interface QueuedJob {
  queue: string;
  name: string;
  data: Record<string, unknown>;
  priority: number;
  /** Insertion order — pg-boss's `created_on` tiebreak, without the clock. */
  seq: number;
}

/**
 * pg-boss, minus pg-boss.
 *
 * `send`/`sendMany` only ENQUEUE; nothing runs until the harness drains. That
 * is what pg-boss does, and it is what `LocalEventService` does not — the local
 * bus executes the listener inline at the call site, so a dispatcher that
 * re-enqueues itself recurses instead of yielding, and the
 * FIFO-behind-the-slices ordering the pipeline's whole backpressure story rests
 * on never exists to be observed.
 *
 * Fetch order is pg-boss's: `ORDER BY priority DESC, created_on`. Every job the
 * pipeline sends carries `BACKFILL_JOB_PRIORITY`, so in practice this is FIFO —
 * which is exactly the property being relied on, and now a property under test
 * rather than an assumption.
 */
export class HarnessQueue extends EventService {
  private readonly pending: QueuedJob[] = [];

  /** Every job ever enqueued, in insertion order. Never drained; for assertions. */
  private readonly log: QueuedJob[] = [];

  private seq = 0;

  /**
   * @deprecated Present only for parity with the base class's deprecated overload.
   */
  async send<E extends keyof EventPayloads>(
    name: E,
    event: EventPayloads[E],
    options?: EventSendOptions,
  ): Promise<string[]>;

  async send<E extends keyof EventRegistry>(
    name: E,
    event: EventRegistry[E],
    options?: EventSendOptions,
  ): Promise<string[]>;

  async send<E extends string>(
    name: E,
    event: EventRegistry[keyof EventRegistry] | EventPayloads[keyof EventPayloads],
    options?: EventSendOptions,
  ): Promise<string[]> {
    // The pipeline ALWAYS names its queue: a stage's sweep and its slices must
    // ride the queue the stage declares, because that is where the resource
    // isolation and the backpressure come from. A send with no queue would fan
    // out in production; here it means the caller forgot, and guessing would
    // hide it.
    if (options?.queue == null) {
      throw new Error(
        `HarnessQueue.send("${name}") was called without options.queue. Every pipeline send names the ` +
          `stage's queue; a fan-out send would mean the dispatcher lost track of which resource pool ` +
          `the work belongs to.`,
      );
    }

    const job = this.enqueue(options.queue, name, event as unknown as Record<string, unknown>, options);

    return [String(job.seq)];
  }

  /**
   * Deferred completion is the external-executor path: a listener calls
   * `ack.defer()` and something out-of-band (the /functions/run webhook)
   * completes the job later.
   *
   * No pipeline stage defers — a stage returns a StageResult synchronously and
   * the slice listener records it — so reaching either of these from a pipeline
   * test means the code under test grew a completion path the ledger knows
   * nothing about. Throwing makes that visible; a silent no-op would let a
   * deferred job look completed while `ci.pipeline_state` still says `running`.
   */
  async completeJob(queue: string, jobId: string): Promise<void> {
    throw new Error(
      `HarnessQueue.completeJob(${queue}, ${jobId}) — no pipeline stage defers its job. ` +
        `If a stage now completes out-of-band, the ledger needs a deferred state before this can be stubbed.`,
    );
  }

  async failJob(queue: string, jobId: string): Promise<void> {
    throw new Error(
      `HarnessQueue.failJob(${queue}, ${jobId}) — no pipeline stage defers its job. ` +
        `Stage failure is recorded through PipelineStateService.fail, not the queue.`,
    );
  }

  async sendMany(
    queue: string,
    events: Array<{ name: string; data: Record<string, unknown> }>,
    options?: Omit<EventSendOptions, 'queue'>,
  ): Promise<void> {
    for (const event of events) {
      this.enqueue(queue, event.name, event.data, options);
    }
  }

  /** Jobs still waiting to be worked. */
  depth(): number {
    return this.pending.length;
  }

  /** Every job ever enqueued, in insertion order. */
  history(): readonly QueuedJob[] {
    return this.log;
  }

  /** Jobs of one event name, in insertion order. */
  historyOf(eventName: string): QueuedJob[] {
    return this.log.filter((job) => job.name === eventName);
  }

  /** Forget the history. The pending queue is untouched. */
  clearHistory(): void {
    this.log.length = 0;
  }

  /**
   * The next job a worker would fetch: highest priority first, then oldest.
   * `null` when the queue is empty.
   */
  fetch(): QueuedJob | null {
    if (this.pending.length === 0) {
      return null;
    }

    let bestIndex = 0;

    for (let i = 1; i < this.pending.length; i += 1) {
      const candidate = this.pending[i];
      const best = this.pending[bestIndex];
      const higherPriority = candidate.priority > best.priority;
      const sameAgeButOlder = candidate.priority === best.priority && candidate.seq < best.seq;

      if (higherPriority || sameAgeButOlder) {
        bestIndex = i;
      }
    }

    return this.pending.splice(bestIndex, 1)[0];
  }

  private enqueue(
    queue: string,
    name: string,
    data: Record<string, unknown>,
    options?: Omit<EventSendOptions, 'queue'>,
  ): QueuedJob {
    this.seq += 1;

    const job: QueuedJob = {
      queue,
      name,
      // Copied, and stamped with `jobId` — the envelope key the real bus adds
      // when it hands `pgboss.job.data` to a listener. Carrying it is not
      // cosmetic: it is what exercises the payload schemas' non-strictness,
      // the property that lets a new field ship without old workers rejecting
      // new jobs.
      data: { ...data, jobId: `harness-job-${this.seq}` },
      priority: options?.priority ?? DEFAULT_JOB_PRIORITY,
      seq: this.seq,
    };

    this.pending.push(job);
    this.log.push(job);

    return job;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * A silent `LoggerService`.
 *
 * Not fastidiousness about test output: the real one builds a pino logger with
 * a `pino-pretty` TRANSPORT outside production, and a transport is a worker
 * thread. Jest reports it as an open handle and holds the run open past the
 * last assertion. The logger is not what this suite tests, so it is replaced
 * wholesale.
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

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** What the fake stage does with a slice. Supplied per test. */
export type StageBehaviour = (
  ctx: UserServiceContext,
  ids: string[],
) => Promise<Map<string, StageResult>> | Map<string, StageResult>;

/** One recorded call into the fake stage. */
export interface StageInvocation {
  ids: string[];
  userId: string;
}

/** A row seeded into the harness's source table. */
export interface SeedRow {
  id: string;
  userId: string;
  /** Drives the stage's applicability predicate (`image/*` is in scope). */
  contentType: string;
  /** The stage's OUTPUT column. The sweep must never look at it. */
  width: number | null;
}

/** One `ci.pipeline_state` row, as the ledger stores it. */
export interface LedgerRow {
  entity_type: string;
  entity_id: string;
  stage: string;
  stage_version: number;
  status: string;
  reason: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  user_id: string | null;
  updated_at: Date;
}

/** One `ci.pipeline_dead_letters` row. */
export interface DeadLetterRow {
  queue: string;
  event_name: string;
  stage: string | null;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  error: string;
}

/** What one `drain()` did. Everything a test needs to assert about dispatch. */
export interface DrainReport {
  /** Sweep hops worked — how many links the self-requeuing chain had. */
  hops: number;
  /** Slice jobs worked. */
  slices: number;
  /** Every id dispatched, in slice order, INCLUDING duplicates if any occurred. */
  dispatchedIds: string[];
  /** Ids per slice, in the order the slices were worked. */
  sliceIds: string[][];
  /** Errors thrown by slices. The drain continues, exactly as a queue would. */
  errors: Error[];
  /** Total jobs worked, sweeps and slices alike. */
  jobsWorked: number;
}

export interface HarnessOptions {
  /** Queue the synthetic stage rides. Defaults to `pipeline-enrich`. */
  queue?: PipelineQueue;
  /** Initial per-slice behaviour. Defaults to {@link markAllDone}. */
  behaviour?: StageBehaviour;
}

/** Ledger `entity_type` for every row a harness writes. */
const HARNESS_ENTITY_TYPE = 'harness_source_row';

/** Source table name inside the throwaway schema. */
const HARNESS_TABLE = 'harness_source';

/** Only a name matching this is ever interpolated into a CREATE/DROP SCHEMA. */
const HARNESS_SCHEMA_PATTERN = /^pipeline_harness_[0-9a-f]{8}$/;

/** Stage-id prefix. Greppable, and the key the teardown and reap DELETEs use. */
const HARNESS_STAGE_PREFIX = 'test.harness_';

/** Leftovers older than this are reaped at setup, on the assumption their run was killed. */
const ORPHAN_REAP_AGE_MS = 60 * 60 * 1000;

/**
 * The mutable views of the two declaration maps.
 *
 * `STAGE_REGISTRY` and `STAGE_VERSIONS` are keyed by the `StageId` union, so a
 * synthetic id needs a cast to be written — the same cast `StageRegistry.spec`
 * uses. Registering at RUNTIME rather than shipping a permanent fake stage is
 * the point: the boot guard insists the two maps agree, so a committed test
 * stage would have to be declared in `constants.ts`, and would then appear in
 * `GET /api/pipeline/state` on a real appliance at 0 % coverage forever. Jest
 * gives every test FILE its own module registry, so these mutations are
 * invisible to every other spec.
 */
const REGISTRY = STAGE_REGISTRY as unknown as Record<string, string>;
const VERSIONS = STAGE_VERSIONS as unknown as Record<string, number>;

/** The default behaviour: report `done` for every id and touch nothing else. */
export function markAllDone(): StageBehaviour {
  return (_ctx, ids) => new Map(ids.map((id) => [id, { outcome: 'done' as const }]));
}

/**
 * Ordered, canonical uuids.
 *
 * Lowercase hex uuids compare byte-wise in Postgres and lexically in JavaScript
 * in the SAME order, so a test can predict which ids land in which slice — what
 * makes the keyset assertions meaningful rather than "some partition of the
 * set".
 */
export function sourceId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * One end-to-end pipeline environment: a real Postgres, a throwaway source
 * table, a synthetic stage, and the real dispatcher / worker / ledger wired
 * together with an in-memory queue between them.
 *
 * Construct with {@link PipelineHarness.start}, and always tear down in
 * `afterAll` — the ledger rows live in the real `ci.pipeline_state`.
 */
export class PipelineHarness {
  /** The synthetic stage's id. Unique per harness; nothing else writes it. */
  readonly stageId: string;

  /** Ledger `entity_type` for every row this harness writes. */
  readonly entityType = HARNESS_ENTITY_TYPE;

  readonly queue: PipelineQueue;

  /** Throwaway schema holding the source table. Dropped at teardown. */
  readonly schema: string;

  /** Source table name inside {@link schema}. */
  readonly table = HARNESS_TABLE;

  /** The user everything is seeded under unless a test says otherwise. */
  readonly userId: string;

  /** A second user, seeded but never swept — proof the sweep is user-scoped. */
  readonly otherUserId: string;

  readonly dataSource: DataSource;

  readonly queueDouble: HarnessQueue;

  readonly stateService: PipelineStateService;

  readonly dispatch: PipelineDispatchService;

  readonly listener: PipelineSliceListener;

  /** The stage the registry resolves. Its `version` reads through to STAGE_VERSIONS. */
  readonly stage: Stage;

  private readonly module: TestingModule;

  private readonly invocations: StageInvocation[];

  /**
   * Indirection so `setBehaviour` can be called between slices: the `Stage`
   * object is built before the harness exists and captures this box, not the
   * function.
   */
  private readonly behaviourRef: { current: StageBehaviour };

  private constructor(init: {
    stageId: string;
    schema: string;
    queue: PipelineQueue;
    userId: string;
    otherUserId: string;
    dataSource: DataSource;
    module: TestingModule;
    queueDouble: HarnessQueue;
    stage: Stage;
    invocations: StageInvocation[];
    behaviourRef: { current: StageBehaviour };
  }) {
    this.stageId = init.stageId;
    this.schema = init.schema;
    this.queue = init.queue;
    this.userId = init.userId;
    this.otherUserId = init.otherUserId;
    this.dataSource = init.dataSource;
    this.module = init.module;
    this.queueDouble = init.queueDouble;
    this.stage = init.stage;
    this.invocations = init.invocations;
    this.behaviourRef = init.behaviourRef;

    this.stateService = init.module.get(PipelineStateService);
    this.dispatch = init.module.get(PipelineDispatchService);
    this.listener = init.module.get(PipelineSliceListener);
  }

  /**
   * Build everything: connect, create the throwaway schema and source table,
   * register the synthetic stage, compile the Nest module.
   *
   * Throws — rather than skipping — when the database is reachable but wrong
   * (migrations not applied). Skipping there would turn a setup mistake into a
   * green run, the exact class of silence this subsystem was rebuilt to remove.
   */
  static async start(options: HarnessOptions = {}): Promise<PipelineHarness> {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error(
        'PipelineHarness.start() called with no database configured. Guard the suite with ' +
          'databaseAvailability().available before constructing a harness.',
      );
    }

    const suffix = randomBytes(4).toString('hex');
    const schema = `pipeline_harness_${suffix}`;
    const stageId = `${HARNESS_STAGE_PREFIX}${suffix}`;
    const queue = options.queue ?? PIPELINE_QUEUES.ENRICH;

    const dataSource = new DataSource({
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
      // dangerous pointed at the dev database.
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 4 },
    });

    await dataSource.initialize();

    try {
      await PipelineHarness.assertControlPlanePresent(dataSource);
      await PipelineHarness.reapOrphans(dataSource);
      await PipelineHarness.createSourceSchema(dataSource, schema);
    } catch (err: unknown) {
      await dataSource.destroy();

      throw err;
    }

    // Registered BEFORE the module compiles: `StageRegistry.get()` reads
    // STAGE_REGISTRY and `stageVersion()` reads STAGE_VERSIONS, so a stage that
    // were only a Nest provider would resolve to "Unknown pipeline stage". This
    // is the same two-line declaration a real stage makes across `constants.ts`
    // and `versions.ts`, performed at runtime.
    const token = `PipelineStage:${stageId}`;
    REGISTRY[stageId] = token;
    // Versions start at 1, never 0 — `versions.ts` explains at length why 0
    // would strand any row a killed worker left in `status='running'`.
    VERSIONS[stageId] = 1;

    const invocations: StageInvocation[] = [];
    const behaviourRef = { current: options.behaviour ?? markAllDone() };

    // An object literal rather than a class, so `version` can be a GETTER. The
    // registry caches the resolved instance and checks `stage.version ===
    // STAGE_VERSIONS[id]` once, at first resolve; reading through means a bump
    // mid-suite is visible to the cached instance — exactly how a real stage
    // that reads `stageVersion(...)` behaves.
    const stage: Stage = {
      id: stageId,
      get version(): number {
        return VERSIONS[stageId];
      },
      queue,
      entityTypes: [HARNESS_ENTITY_TYPE],
      source: {
        schema,
        table: HARNESS_TABLE,
        idColumn: 'id',
        userColumn: 'user_id',
        // Applicability, never completion. It names what a row IS (an image)
        // and deliberately says nothing about `width` — the column the stage
        // writes. `width IS NULL` here would rebuild the one-way ratchet inside
        // the mechanism designed to delete it, which is why `StageRegistry`
        // rejects a predicate that reaches into the ledger for the same reason.
        predicate: "s.content_type LIKE 'image/%'",
      },
      async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
        invocations.push({ ids: [...ids], userId: ctx.userId });

        return behaviourRef.current(ctx, ids);
      },
    };

    const queueDouble = new HarnessQueue();

    const module = await Test.createTestingModule({
      providers: [
        PipelineStateService,
        StageRegistry,
        PipelineDispatchService,
        PipelineSliceListener,
        // `@InjectDataSource()` resolves to the `DataSource` class token for the
        // default connection, which is why binding the class works here and in
        // `domains/ingest/__tests__/Routes.e2e.test.ts`.
        { provide: DataSource, useValue: dataSource },
        { provide: EventService, useValue: queueDouble },
        { provide: LoggerService, useValue: silentLogger() },
        { provide: token, useValue: stage },
      ],
    }).compile();

    return new PipelineHarness({
      stageId,
      schema,
      queue,
      userId: randomUUID(),
      otherUserId: randomUUID(),
      dataSource,
      module,
      queueDouble,
      stage,
      invocations,
      behaviourRef,
    });
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  /**
   * Seed `count` applicable rows (`image/jpeg`) for {@link userId} and — by
   * default — one inapplicable row plus one row belonging to another user, so
   * every sweep in the suite implicitly asserts that the applicability
   * predicate and the user scope both still hold.
   *
   * Returns the ids of the APPLICABLE rows, in sweep order.
   */
  async seed(
    count: number,
    options: { withDecoys?: boolean; width?: number | null } = {},
  ): Promise<string[]> {
    const withDecoys = options.withDecoys ?? true;
    const width = options.width ?? null;

    const applicable: SeedRow[] = Array.from({ length: count }, (_, i) => ({
      id: sourceId(i + 1),
      userId: this.userId,
      contentType: 'image/jpeg',
      width,
    }));

    const rows: SeedRow[] = [...applicable];

    if (withDecoys) {
      // Same user, wrong content type: the applicability predicate must exclude
      // it. Ordered AFTER every applicable id so its absence cannot be confused
      // with the sweep simply stopping early.
      rows.push({ id: sourceId(count + 1), userId: this.userId, contentType: 'application/pdf', width });

      // Applicable in every way except ownership.
      rows.push({ id: sourceId(count + 2), userId: this.otherUserId, contentType: 'image/jpeg', width });
    }

    await this.seedRows(rows);

    return applicable.map((row) => row.id);
  }

  /** Insert arbitrary rows. One statement, `unnest` over parallel arrays. */
  async seedRows(rows: SeedRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    await this.dataSource.query(
      `INSERT INTO "${this.schema}"."${this.table}" (id, user_id, content_type, width)
       SELECT t.id, t.user_id, t.content_type, t.width
         FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::int[]) AS t(id, user_id, content_type, width)`,
      [
        rows.map((row) => row.id),
        rows.map((row) => row.userId),
        rows.map((row) => row.contentType),
        rows.map((row) => row.width),
      ],
    );
  }

  /** Read the source table back, in sweep order. */
  async sourceRows(): Promise<SeedRow[]> {
    const rows = await this.dataSource.query<
      Array<{ id: string; user_id: string; content_type: string; width: number | null }>
    >(`SELECT id, user_id, content_type, width FROM "${this.schema}"."${this.table}" ORDER BY id`);

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      contentType: row.content_type,
      width: row.width,
    }));
  }

  /**
   * A behaviour that writes the stage's OUTPUT column and reports `done` — what
   * a real enricher does.
   *
   * Used to set up the version-bump test: after this has run, every row HAS a
   * width, so the old `width IS NULL` predicate would consider the corpus
   * permanently finished. The ledger does not.
   */
  widthWriter(width: number): StageBehaviour {
    return async (_ctx, ids) => {
      await this.dataSource.query(
        `UPDATE "${this.schema}"."${this.table}" SET width = $2 WHERE id = ANY($1::uuid[])`,
        [ids, width],
      );

      return new Map(ids.map((id) => [id, { outcome: 'done' as const }]));
    };
  }

  // -------------------------------------------------------------------------
  // Driving the pipeline
  // -------------------------------------------------------------------------

  /** Replace what the stage decides. Takes effect on the next slice. */
  setBehaviour(behaviour: StageBehaviour): void {
    this.behaviourRef.current = behaviour;
  }

  /** Every call into the stage since the last {@link resetInvocations}. */
  invocationLog(): readonly StageInvocation[] {
    return this.invocations;
  }

  /** Ids handed to the stage since the last reset, flattened in call order. */
  processedIds(): string[] {
    return this.invocations.flatMap((invocation) => invocation.ids);
  }

  resetInvocations(): void {
    this.invocations.length = 0;
  }

  /**
   * Start a sweep and work the queue to exhaustion — one full pipeline run.
   *
   * `startSweep` only enqueues hop 0; {@link drain} does the rest, so what this
   * exercises is the whole durable chain: a hop enqueues slices and re-enqueues
   * ITSELF behind them, the slices are worked, the next hop runs, and so on
   * until the source is drained.
   */
  async sweep(options: { sliceSize?: number; userId?: string; maxJobs?: number } = {}): Promise<DrainReport> {
    await this.dispatch.startSweep({
      stage: this.stageId,
      userId: options.userId ?? this.userId,
      sliceSize: options.sliceSize,
    });

    return this.drain({ maxJobs: options.maxJobs });
  }

  /**
   * Work every queued job, in pg-boss's fetch order, until the queue is empty.
   *
   * A slice that throws is RECORDED and the drain continues, because that is
   * what a queue does: the job fails, the listener's catch block has already
   * written the ledger and the dead-letter row, and the next job is fetched.
   * Aborting here would hide the state the failure left behind — which is the
   * state worth asserting.
   */
  async drain(options: { maxJobs?: number } = {}): Promise<DrainReport> {
    const maxJobs = options.maxJobs ?? 2_000;

    const report: DrainReport = {
      hops: 0,
      slices: 0,
      dispatchedIds: [],
      sliceIds: [],
      errors: [],
      jobsWorked: 0,
    };

    for (;;) {
      const job = this.queueDouble.fetch();

      if (job == null) {
        return report;
      }

      report.jobsWorked += 1;

      // A fuel gauge, not a limit anyone should reach. The dispatcher already
      // asserts its cursor strictly advances and stops at MAX_SWEEP_HOPS; this
      // catches the case where those guards are what broke, turning an infinite
      // loop into a legible failure.
      if (report.jobsWorked > maxJobs) {
        throw new Error(
          `PipelineHarness.drain() worked more than ${maxJobs} jobs without emptying the queue. The ` +
            `sweep is not converging — check the cursor advance and the staleness predicate.`,
        );
      }

      if (job.name === PipelineSweepEvent) {
        report.hops += 1;
        await this.dispatch.runSweepHop(job.data);
        continue;
      }

      if (job.name === PipelineSliceEvent) {
        report.slices += 1;

        const ids = Array.isArray(job.data.ids) ? (job.data.ids as string[]) : [];
        report.sliceIds.push(ids);
        report.dispatchedIds.push(...ids);

        try {
          await this.listener.handleSlice(job.queue, job.data);
        } catch (err: unknown) {
          report.errors.push(err instanceof Error ? err : new Error(String(err)));
        }

        continue;
      }

      throw new Error(`HarnessQueue received an unexpected event "${job.name}" on queue "${job.queue}".`);
    }
  }

  // -------------------------------------------------------------------------
  // Reading the control plane
  // -------------------------------------------------------------------------

  /** Every `ci.pipeline_state` row this harness's stage owns, in entity order. */
  async ledgerRows(): Promise<LedgerRow[]> {
    return this.dataSource.query<LedgerRow[]>(
      `SELECT entity_type, entity_id, stage, stage_version, status, reason, attempts,
              next_attempt_at, user_id, updated_at
         FROM ci.pipeline_state
        WHERE stage = $1
        ORDER BY entity_id`,
      [this.stageId],
    );
  }

  /** The ledger keyed by entity id, for point assertions. */
  async ledgerById(): Promise<Map<string, LedgerRow>> {
    const rows = await this.ledgerRows();

    return new Map(rows.map((row) => [row.entity_id, row]));
  }

  /** The real coverage query, over a stage id nothing else in the system writes. */
  async coverage(): Promise<StageCoverage> {
    return this.stateService.coverage(this.stageId);
  }

  /** Dead letters recorded for this harness's stage, oldest first. */
  async deadLetters(): Promise<DeadLetterRow[]> {
    return this.dataSource.query<DeadLetterRow[]>(
      `SELECT queue, event_name, stage, entity_type, entity_id, payload, error
         FROM ci.pipeline_dead_letters
        WHERE stage = $1
        ORDER BY failed_at, id`,
      [this.stageId],
    );
  }

  /** The stage's current version, as `STAGE_VERSIONS` holds it. */
  stageVersion(): number {
    return VERSIONS[this.stageId];
  }

  /**
   * THE BUMP — the one operation the whole rebuild exists for.
   *
   * Incrementing this integer is, in production, a one-line commit to
   * `versions.ts`. Here it is the same mutation of the same map, so what the
   * next sweep makes of it is the real behaviour rather than a simulation.
   */
  bumpStageVersion(): number {
    VERSIONS[this.stageId] += 1;

    return VERSIONS[this.stageId];
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Drop everything this harness created.
   *
   * The throwaway schema first (the only thing holding fake source rows), then
   * the ledger and dead-letter rows keyed by this harness's stage id, then the
   * runtime registry entries, then the connection. The `finally` runs even if a
   * DELETE fails, because a leaked registry entry would break every later spec
   * in the same file while a leaked row is reaped an hour later.
   */
  async teardown(): Promise<void> {
    try {
      if (HARNESS_SCHEMA_PATTERN.test(this.schema)) {
        await this.dataSource.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
      }

      await this.dataSource.query(`DELETE FROM ci.pipeline_state WHERE stage = $1`, [this.stageId]);
      await this.dataSource.query(`DELETE FROM ci.pipeline_dead_letters WHERE stage = $1`, [this.stageId]);
    } finally {
      delete REGISTRY[this.stageId];
      delete VERSIONS[this.stageId];

      await this.module.close();
      await this.dataSource.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Fail fast, and legibly, when the database is reachable but not migrated.
   *
   * `relation "ci.pipeline_state" does not exist`, repeated once per test, is a
   * worse diagnostic than one sentence naming the command that fixes it.
   */
  private static async assertControlPlanePresent(dataSource: DataSource): Promise<void> {
    const rows = await dataSource.query<Array<{ table_name: string }>>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'ci'
          AND table_name IN ('pipeline_state', 'pipeline_dead_letters')`,
    );

    if (rows.length < 2) {
      throw new Error(
        'The pipeline control plane is missing from this database (ci.pipeline_state / ' +
          'ci.pipeline_dead_letters). Run `yarn workspace @ci/be-api migrate` and try again.',
      );
    }
  }

  /**
   * Delete leftovers from a harness whose process was killed before teardown.
   *
   * Bounded three ways so it can never touch anything real: only stages under
   * the `test.harness_` prefix, only rows older than {@link ORPHAN_REAP_AGE_MS},
   * and — for schemas — only names matching {@link HARNESS_SCHEMA_PATTERN} that
   * still carry the marker comment this harness wrote when it created them.
   */
  private static async reapOrphans(dataSource: DataSource): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_REAP_AGE_MS);

    await dataSource.query(`DELETE FROM ci.pipeline_state WHERE stage LIKE $1 || '%' AND updated_at < $2`, [
      HARNESS_STAGE_PREFIX,
      cutoff,
    ]);

    await dataSource.query(
      `DELETE FROM ci.pipeline_dead_letters WHERE stage LIKE $1 || '%' AND failed_at < $2`,
      [HARNESS_STAGE_PREFIX, cutoff],
    );

    const schemas = await dataSource.query<Array<{ nspname: string; description: string | null }>>(
      `SELECT n.nspname, obj_description(n.oid, 'pg_namespace') AS description
         FROM pg_namespace n
        WHERE n.nspname LIKE 'pipeline\\_harness\\_%'`,
    );

    for (const row of schemas) {
      const created = PipelineHarness.parseMarker(row.description);

      // No marker, or an unparseable one: leave it alone. A schema this harness
      // did not create is not this harness's to drop.
      if (created == null || created.getTime() > cutoff.getTime()) {
        continue;
      }

      if (HARNESS_SCHEMA_PATTERN.test(row.nspname)) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
      }
    }
  }

  /** Create the throwaway schema and the synthetic source table. */
  private static async createSourceSchema(dataSource: DataSource, schema: string): Promise<void> {
    if (!HARNESS_SCHEMA_PATTERN.test(schema)) {
      throw new Error(`Refusing to create schema "${schema}": it is not a harness schema name.`);
    }

    await dataSource.query(`CREATE SCHEMA "${schema}"`);

    // The marker is what makes the orphan reap safe: it records both that the
    // schema is disposable and when it became so.
    await dataSource.query(
      `COMMENT ON SCHEMA "${schema}" IS 'ci pipeline test harness; created ${new Date().toISOString()}; safe to drop'`,
    );

    // Shaped like `ci.files`, the first real conversion's source: a uuid pk, a
    // user column, an applicability column, and `width` — the stage's OUTPUT
    // column, present for exactly one reason, which is to prove that a row that
    // already HAS a width is still selected once the ledger says the stage is
    // behind.
    await dataSource.query(
      `CREATE TABLE "${schema}"."${HARNESS_TABLE}" (
         id           UUID PRIMARY KEY,
         user_id      UUID NOT NULL,
         content_type TEXT NOT NULL,
         width        INTEGER
       )`,
    );
  }

  /** Pull the ISO timestamp back out of a schema marker comment. */
  private static parseMarker(description: string | null): Date | null {
    if (description == null) {
      return null;
    }

    const match = /created (\S+);/.exec(description);

    if (match == null) {
      return null;
    }

    const parsed = new Date(match[1]);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

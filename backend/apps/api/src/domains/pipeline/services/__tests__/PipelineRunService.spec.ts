import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import {
  BACKFILL_JOB_PRIORITY,
  EventListenerRegistry,
  EventService,
  type EventSendOptions,
} from '@ci/domains/events';

import { DEAD_LETTER_QUEUE, STAGE_ID_LIST } from '../../constants';
import { stageVersion } from '../../versions';
import {
  DEAD_LETTER_REPLAY_KEY_PREFIX,
  DEFAULT_DEAD_LETTER_PAGE,
  MAX_DEAD_LETTER_PAGE,
  MAX_SHARDS_PER_RUN,
  PipelineRunService,
} from '../PipelineRunService';

// `isWrite`, not `startsWith('UPDATE')`: the writes are CTE-wrapped so TypeORM
// returns plain rows instead of `[rows, rowCount]`, which means the outer command
// is a SELECT. Matching the leading keyword silently stopped identifying them —
// the mock fell through to the read branch and the 409 paths went untested.
const isWrite = (sql: string): boolean => /\bUPDATE\s+ci\./i.test(sql);
/**
 * The run lifecycle and the operator's read/control plane.
 *
 * What is worth testing here is NOT "the service issues a query". It is the
 * three properties that, if wrong, wedge an appliance in a way nobody can see:
 *
 * 1. **A second run for a user is a normal outcome, not a 500.**
 *    `pipeline_runs_active_uniq` makes concurrent runs a database error on
 *    purpose — an operator double-clicking "reprocess" gets SQLSTATE 23505
 *    instead of two workers racing over the same rows. The service has to read
 *    that as "one is already going" and hand back the run that IS going.
 *
 * 2. **Finalization always stamps `finished_at`, including on cancel.** That
 *    column IS the index's predicate, so a terminal run that never gets it stays
 *    "active" forever and its user can never start another run — silently, with
 *    no error anywhere and no repair short of SQL. Cancel is the case most
 *    likely to get this wrong, because it feels like a different kind of ending.
 *
 * 3. **A replay either re-emits the payload verbatim or leaves `replayed_at`
 *    alone.** A letter marked replayed that was never re-emitted is worse than
 *    one that was never touched: the payload is frequently the only surviving
 *    copy of the record, and the flag is what removes it from the replay queue.
 *
 * No Postgres. The `DataSource` double records every statement and answers from
 * a per-test responder, in the style of `PipelineStateService.spec.ts` — the
 * semantics under test are in this file's control flow and in which parameters
 * it binds, both of which a real database would only obscure.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const RUN_ID = '00000000-0000-7000-8000-0000000000c1';
const LETTER_ID = '00000000-0000-7000-8000-0000000000d1';

const CTX: UserServiceContext = { userId: USER };

/** One statement the service issued, whitespace-collapsed for matching. */
interface Statement {
  sql: string;
  params: unknown[];
}

/**
 * Answers a statement. Returning rows resolves the query; throwing rejects it,
 * which is how the unique-violation paths are driven.
 */
type Responder = (statement: Statement, nth: number) => unknown[];

interface Harness {
  service: PipelineRunService;
  statements: Statement[];
  send: jest.Mock;
  logger: { warn: jest.Mock; error: jest.Mock; log: jest.Mock; debug: jest.Mock };
  /** Statements whose collapsed SQL matches. */
  matching(pattern: RegExp): Statement[];
}

function makeHarness(respond: Responder = () => [], sendResult: string[] = ['job-1']): Harness {
  const statements: Statement[] = [];

  const query = jest.fn(async (raw: string, params: unknown[] = []) => {
    const statement: Statement = { sql: raw.replace(/\s+/g, ' ').trim(), params };

    statements.push(statement);

    return respond(statement, statements.length - 1);
  });

  const dataSource = { query } as unknown as DataSource;

  const send = jest.fn(async () => sendResult);
  const eventService = { send } as unknown as EventService;

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  return {
    service: new PipelineRunService(dataSource, eventService, logger as unknown as LoggerService),
    statements,
    send,
    logger,
    matching: (pattern) => statements.filter((statement) => pattern.test(statement.sql)),
  };
}

/** A `ci.pipeline_runs` row as the projection returns it. */
function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    kind: 'reprocess',
    desired_state: 'running',
    status: 'queued',
    started_at: new Date('2026-08-09T10:00:00Z'),
    finished_at: null,
    detail: {},
    shard_count: 0,
    shards_by_status: null,
    ...overrides,
  };
}

/** The error node-postgres raises when `pipeline_runs_active_uniq` is violated. */
function activeRunConflict(constraint: string | undefined = 'pipeline_runs_active_uniq') {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

// ---------------------------------------------------------------------------
// startRun — the 23505 that is not an error
// ---------------------------------------------------------------------------

describe('PipelineRunService.startRun', () => {
  it('inserts a run and reports it as created', async () => {
    const harness = makeHarness(() => [runRow()]);

    const result = await harness.service.startRun(CTX, { kind: 'reprocess', detail: { trigger: 'ui' } });

    expect(result.created).toBe(true);
    expect(result.run.id).toBe(RUN_ID);
    expect(result.run.active).toBe(true);

    const [insert] = harness.matching(/INSERT INTO ci\.pipeline_runs/);

    expect(insert).toBeDefined();
    // desired_state starts at 'running': the control channel's default is "go".
    expect(insert.sql).toContain("'running'");
    expect(insert.params[0]).toBe(USER);
    expect(insert.params[1]).toBe('reprocess');
    expect(JSON.parse(insert.params[2] as string)).toEqual({ trigger: 'ui' });
  });

  it('treats a unique violation on pipeline_runs_active_uniq as "a run is already going"', async () => {
    // The whole point: the index makes a concurrent run a DATABASE error so two
    // workers can never race over one user's rows. The service must read that as
    // an answer, not an exception — an operator double-clicking "reprocess"
    // wants to know which run is going, not to see a 500.
    const existing = runRow({ status: 'running', shard_count: 3, shards_by_status: { running: 3 } });

    const harness = makeHarness((statement) => {
      if (/INSERT INTO ci\.pipeline_runs/.test(statement.sql)) {
        throw activeRunConflict();
      }

      return [existing];
    });

    const result = await harness.service.startRun(CTX, { kind: 'reprocess' });

    expect(result.created).toBe(false);
    expect(result.run.id).toBe(RUN_ID);
    expect(result.run.status).toBe('running');
    expect(result.run.shardCount).toBe(3);
    expect(result.run.shardsByStatus).toEqual({ running: 3 });

    // Exactly one insert attempt: the existing run was readable, so there is
    // nothing to retry.
    expect(harness.matching(/INSERT INTO ci\.pipeline_runs/)).toHaveLength(1);
  });

  it('reads the conflict from driverError when TypeORM wraps the driver failure', async () => {
    const harness = makeHarness((statement) => {
      if (/INSERT INTO ci\.pipeline_runs/.test(statement.sql)) {
        throw Object.assign(new Error('QueryFailedError'), {
          driverError: { code: '23505', constraint: 'pipeline_runs_active_uniq' },
        });
      }

      return [runRow()];
    });

    await expect(harness.service.startRun(CTX, { kind: 'import' })).resolves.toMatchObject({
      created: false,
    });
  });

  it('accepts a 23505 whose constraint name did not survive the driver', async () => {
    // Some poolers do not propagate the constraint field. A 23505 on this table
    // can only be the active-run index (the PK defaults to gen_uuid_v7), so an
    // absent name is read as the conflict rather than as an unknown failure.
    const harness = makeHarness((statement) => {
      if (/INSERT INTO ci\.pipeline_runs/.test(statement.sql)) {
        throw activeRunConflict(undefined);
      }

      return [runRow()];
    });

    await expect(harness.service.startRun(CTX, { kind: 'import' })).resolves.toMatchObject({
      created: false,
    });
  });

  it('rethrows a unique violation on some OTHER constraint', async () => {
    // "Some unique constraint broke" reported as "a run is already going" is a
    // lie that would survive every test but this one.
    const harness = makeHarness((statement) => {
      if (/INSERT INTO ci\.pipeline_runs/.test(statement.sql)) {
        throw activeRunConflict('some_other_uniq');
      }

      return [runRow()];
    });

    await expect(harness.service.startRun(CTX, { kind: 'import' })).rejects.toThrow(
      'duplicate key value violates unique constraint',
    );
  });

  it('rethrows a non-unique failure untouched', async () => {
    const harness = makeHarness((statement) => {
      if (/INSERT INTO ci\.pipeline_runs/.test(statement.sql)) {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }

      return [];
    });

    await expect(harness.service.startRun(CTX, { kind: 'import' })).rejects.toThrow('deadlock detected');
  });

  it('retries the insert once when the blocking run finishes mid-flight', async () => {
    // The narrow race: our insert loses to a run that is finalized before we can
    // read it back. Retrying once turns that into a successful start rather than
    // a spurious conflict.
    let inserts = 0;

    const harness = makeHarness((statement) => {
      if (/INSERT INTO ci\.pipeline_runs/.test(statement.sql)) {
        inserts += 1;

        if (inserts === 1) {
          throw activeRunConflict();
        }

        return [runRow()];
      }

      // The active-run read finds nothing: the blocker just finished.
      return [];
    });

    const result = await harness.service.startRun(CTX, { kind: 'import' });

    expect(result.created).toBe(true);
    expect(inserts).toBe(2);
  });

  it('gives up with a conflict when the blocking run is never readable', async () => {
    const harness = makeHarness((statement) => {
      if (/INSERT INTO ci\.pipeline_runs/.test(statement.sql)) {
        throw activeRunConflict();
      }

      return [];
    });

    await expect(harness.service.startRun(CTX, { kind: 'import' })).rejects.toBeInstanceOf(ConflictException);

    // Bounded: two attempts, not a spin.
    expect(harness.matching(/INSERT INTO ci\.pipeline_runs/)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// finishRun — the column that unwedges the user
// ---------------------------------------------------------------------------

describe('PipelineRunService.finishRun', () => {
  it.each([
    ['completed', 'the ordinary ending'],
    ['failed', 'the unhappy ending'],
    ['cancelled', 'the ending most likely to be special-cased'],
  ])('stamps finished_at for status %s (%s)', async (status) => {
    // `finished_at IS NULL` is the ENTIRE predicate of pipeline_runs_active_uniq.
    // A terminal run that keeps a NULL there blocks its user from ever starting
    // another one — no error, no log line, no way out but SQL.
    const harness = makeHarness(() => [runRow({ status, finished_at: new Date('2026-08-09T11:00:00Z') })]);

    const run = await harness.service.finishRun(RUN_ID, status);

    expect(run?.finishedAt).toEqual(new Date('2026-08-09T11:00:00Z'));
    expect(run?.active).toBe(false);

    const [update] = harness.matching(/UPDATE ci\.pipeline_runs/);

    // Unconditional, and not predicated on the status: nothing in this statement
    // can decide NOT to finalize.
    expect(update.sql).toMatch(/finished_at\s*=\s*COALESCE\(finished_at, now\(\)\)/i);
    expect(update.sql).not.toMatch(/WHERE .*finished_at IS NULL/i);
    expect(update.params[1]).toBe(status);
  });

  it('keeps the first finalization timestamp when called twice', async () => {
    // COALESCE, not `now()`: a retried control tick must not extend the run's
    // measured duration, and must not re-open a window where the row looks
    // freshly finished.
    const harness = makeHarness(() => [runRow({ finished_at: new Date('2026-08-09T11:00:00Z') })]);

    await harness.service.finishRun(RUN_ID, 'cancelled');

    expect(harness.matching(/UPDATE ci\.pipeline_runs/)[0].sql).toContain('COALESCE(finished_at, now())');
  });

  it('merges detail rather than replacing it', async () => {
    const harness = makeHarness(() => [runRow({ finished_at: new Date() })]);

    await harness.service.finishRun(RUN_ID, 'completed', { processed: 12 });

    const [update] = harness.matching(/UPDATE ci\.pipeline_runs/);

    expect(update.sql).toContain('detail = detail || $3::jsonb');
    expect(JSON.parse(update.params[2] as string)).toEqual({ processed: 12 });
  });

  it('returns null for a run that does not exist', async () => {
    const harness = makeHarness(() => []);

    await expect(harness.service.finishRun(RUN_ID, 'completed')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setDesiredState — the control channel, and only the control channel
// ---------------------------------------------------------------------------

describe('PipelineRunService.setDesiredState', () => {
  it.each(['paused', 'running', 'cancelled'] as const)('writes desired_state = %s', async (desired) => {
    const harness = makeHarness(() => [runRow({ desired_state: desired })]);

    const run = await harness.service.setDesiredState(CTX, RUN_ID, desired);

    expect(run.desiredState).toBe(desired);

    const [update] = harness.matching(/UPDATE ci\.pipeline_runs/);

    expect(update.params).toEqual([USER, RUN_ID, desired]);
  });

  it('never writes status', async () => {
    // desired_state is what the operator WANTS; status is what the workers
    // REPORT. Writing both from a request would report an observation nobody
    // made — the pause would read as applied the instant the request returned,
    // while a worker was still mid-batch.
    const harness = makeHarness(() => [runRow({ desired_state: 'paused' })]);

    await harness.service.setDesiredState(CTX, RUN_ID, 'paused');

    const [update] = harness.matching(/UPDATE ci\.pipeline_runs/);

    expect(update.sql).not.toMatch(/SET[\s\S]*\bstatus\s*=/i);
    expect(update.sql).not.toMatch(/finished_at\s*=/i);
  });

  it('is user-scoped and refuses a finalized run in the statement itself', async () => {
    const harness = makeHarness(() => [runRow()]);

    await harness.service.setDesiredState(CTX, RUN_ID, 'paused');

    const [update] = harness.matching(/UPDATE ci\.pipeline_runs/);

    expect(update.sql).toContain('user_id = $1::uuid');
    expect(update.sql).toContain('finished_at IS NULL');
    // Cancel is one-way while a run is active.
    expect(update.sql).toContain("(desired_state <> 'cancelled' OR $3 = 'cancelled')");
  });

  it('404s a run that does not exist or belongs to someone else', async () => {
    const harness = makeHarness(() => []);

    await expect(harness.service.setDesiredState(CTX, RUN_ID, 'paused')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s a run that has already finished', async () => {
    const finished = runRow({ finished_at: new Date('2026-08-09T11:00:00Z'), status: 'completed' });

    const harness = makeHarness((statement) => (isWrite(statement.sql) ? [] : [finished]));

    await expect(harness.service.setDesiredState(CTX, RUN_ID, 'paused')).rejects.toThrow(/no longer accepts/);
  });

  it('409s an attempt to resume a cancelled run', async () => {
    const cancelled = runRow({ desired_state: 'cancelled' });

    const harness = makeHarness((statement) => (isWrite(statement.sql) ? [] : [cancelled]));

    await expect(harness.service.setDesiredState(CTX, RUN_ID, 'running')).rejects.toThrow(
      /cancelled run cannot be resumed/,
    );
  });

  it('is idempotent for cancel → cancel', async () => {
    // The statement's guard allows cancel over cancel, so a retried request (or
    // a second click) returns the run rather than erroring.
    const harness = makeHarness(() => [runRow({ desired_state: 'cancelled' })]);

    await expect(harness.service.setDesiredState(CTX, RUN_ID, 'cancelled')).resolves.toMatchObject({
      desiredState: 'cancelled',
    });
  });
});

// ---------------------------------------------------------------------------
// Run reads
// ---------------------------------------------------------------------------

describe('PipelineRunService.listRuns', () => {
  it('scopes to the user, orders newest first and clamps the page', async () => {
    const harness = makeHarness(() => [runRow()]);

    await harness.service.listRuns(CTX, { limit: 10_000, offset: 5 });

    const [select] = harness.statements;

    expect(select.sql).toContain('r.user_id = $1::uuid');
    expect(select.sql).toContain('ORDER BY r.started_at DESC, r.id DESC');
    expect(select.params[2]).toBe(200);
    expect(select.params[3]).toBe(5);
  });

  it('passes activeOnly through as the finished_at filter', async () => {
    const harness = makeHarness(() => []);

    await harness.service.listRuns(CTX, { activeOnly: true });

    // `$2` is "include finished runs", so activeOnly inverts it.
    expect(harness.statements[0].params[1]).toBe(false);

    const other = makeHarness(() => []);

    await other.service.listRuns(CTX);

    expect(other.statements[0].params[1]).toBe(true);
  });

  it('reports a run with no shards as zero rather than as absent', async () => {
    // jsonb_object_agg over zero rows is NULL, not {}. The shape must not change
    // just because the runner has not planned the run yet.
    const harness = makeHarness(() => [runRow({ shard_count: 0, shards_by_status: null })]);

    const [run] = await harness.service.listRuns(CTX);

    expect(run.shardCount).toBe(0);
    expect(run.shardsByStatus).toEqual({});
  });

  it('passes an unknown shard status through instead of dropping it', async () => {
    // ci.pipeline_shards.status has no CHECK; its vocabulary belongs to the
    // runner. Fixed buckets here would lose rows, and a progress view that loses
    // rows reads better than reality.
    const harness = makeHarness(() => [
      runRow({ shard_count: 4, shards_by_status: { running: '1', leased: '3' } }),
    ]);

    const [run] = await harness.service.listRuns(CTX);

    expect(run.shardsByStatus).toEqual({ running: 1, leased: 3 });
  });
});

describe('PipelineRunService.getRun', () => {
  const shardRow = (overrides: Record<string, unknown> = {}) => ({
    id: '00000000-0000-7000-8000-0000000000e1',
    stage: 'enrich.geocode',
    shard_key: 'events',
    cursor: '00000000-0000-7000-8000-0000000000f1',
    status: 'running',
    lease_owner: 'worker-1',
    lease_expires_at: new Date('2026-08-09T10:10:00Z'),
    lease_expired: false,
    ...overrides,
  });

  it('returns the run with its shards and their cursors', async () => {
    const harness = makeHarness((statement) =>
      /pipeline_shards s/.test(statement.sql) ? [shardRow()] : [runRow()],
    );

    const detail = await harness.service.getRun(CTX, RUN_ID);

    expect(detail.id).toBe(RUN_ID);
    expect(detail.shardsTruncated).toBe(false);
    expect(detail.shards).toEqual([
      {
        id: '00000000-0000-7000-8000-0000000000e1',
        stage: 'enrich.geocode',
        shardKey: 'events',
        cursor: '00000000-0000-7000-8000-0000000000f1',
        status: 'running',
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date('2026-08-09T10:10:00Z'),
        leaseExpired: false,
      },
    ]);
  });

  it('computes lease expiry in SQL, against the database clock', async () => {
    const harness = makeHarness((statement) =>
      /pipeline_shards s/.test(statement.sql) ? [shardRow({ lease_expired: true })] : [runRow()],
    );

    const detail = await harness.service.getRun(CTX, RUN_ID);

    expect(detail.shards[0].leaseExpired).toBe(true);
    expect(harness.matching(/pipeline_shards s/)[0].sql).toContain('s.lease_expires_at < now()');
  });

  it('flags truncation instead of silently returning a short list', async () => {
    const many = Array.from({ length: MAX_SHARDS_PER_RUN + 1 }, (_, index) =>
      shardRow({ id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}` }),
    );

    const harness = makeHarness((statement) => (/pipeline_shards s/.test(statement.sql) ? many : [runRow()]));

    const detail = await harness.service.getRun(CTX, RUN_ID);

    expect(detail.shards).toHaveLength(MAX_SHARDS_PER_RUN);
    expect(detail.shardsTruncated).toBe(true);
    // Asked for one more than the ceiling, which is how a full page is
    // distinguishable from a page that lands exactly on it.
    expect(harness.matching(/pipeline_shards s/)[0].params[1]).toBe(MAX_SHARDS_PER_RUN + 1);
  });

  it("404s another user's run rather than leaking it", async () => {
    const harness = makeHarness(() => []);

    await expect(harness.service.getRun({ userId: OTHER_USER }, RUN_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(harness.statements[0].params[0]).toBe(OTHER_USER);
    expect(harness.statements[0].sql).toContain('r.user_id = $1::uuid');
  });
});

// ---------------------------------------------------------------------------
// stageState — "is my import finished?"
// ---------------------------------------------------------------------------

describe('PipelineRunService.stageState', () => {
  it('reports every declared stage, zero-filled, in one round trip', async () => {
    const harness = makeHarness(() => []);

    const stages = await harness.service.stageState(CTX);

    // A stage with no ledger rows must appear at 0. An absent stage reads as
    // "not applicable"; the truth is "never run", which is the opposite answer
    // to the question this endpoint exists for.
    expect(stages.map((stage) => stage.stage)).toEqual([...STAGE_ID_LIST]);
    expect(stages.every((stage) => stage.total === 0 && stage.coverage === 0)).toBe(true);
    expect(harness.statements).toHaveLength(1);
  });

  it('carries the current version per stage into the query, and reports it', async () => {
    const harness = makeHarness(() => []);

    const stages = await harness.service.stageState(CTX);

    const [select] = harness.statements;

    expect(select.params[0]).toBe(USER);
    expect(select.params[1]).toEqual([...STAGE_ID_LIST]);
    expect(select.params[2]).toEqual(STAGE_ID_LIST.map((stage) => stageVersion(stage)));

    for (const stage of stages) {
      expect(stage.stageVersion).toBe(stageVersion(stage.stage));
    }
  });

  it('is user-scoped', async () => {
    // Unlike PipelineStateService.coverage(), which asks the same question
    // appliance-wide and takes no user parameter.
    const harness = makeHarness(() => []);

    await harness.service.stageState(CTX);

    expect(harness.statements[0].sql).toContain('p.user_id = $1::uuid');
  });

  it('buckets each ledger status and derives coverage from done + skipped', async () => {
    const stageId = STAGE_ID_LIST[0];

    const harness = makeHarness(() => [
      { stage: stageId, status: 'done', count: '6', stale: '1' },
      { stage: stageId, status: 'skipped', count: '2', stale: '0' },
      { stage: stageId, status: 'failed', count: '1', stale: '0' },
      { stage: stageId, status: 'quarantined', count: '1', stale: '0' },
    ]);

    const [coverage] = await harness.service.stageState(CTX);

    expect(coverage).toMatchObject({
      stage: stageId,
      total: 10,
      done: 6,
      skipped: 2,
      failed: 1,
      quarantined: 1,
      stale: 1,
      coverage: 0.8,
    });
  });

  it('counts an unrecognised status into total, so coverage can only read LOW', async () => {
    const stageId = STAGE_ID_LIST[0];

    const harness = makeHarness(() => [
      { stage: stageId, status: 'done', count: '1', stale: '0' },
      { stage: stageId, status: 'invented', count: '1', stale: '0' },
    ]);

    const [coverage] = await harness.service.stageState(CTX);

    expect(coverage.total).toBe(2);
    expect(coverage.coverage).toBe(0.5);
    expect(harness.logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------

describe('PipelineRunService.listDeadLetters', () => {
  const letterRow = (overrides: Record<string, unknown> = {}) => ({
    id: LETTER_ID,
    queue: 'pipeline-enrich',
    event_name: 'pipeline.slice',
    stage: 'enrich.geocode',
    entity_type: 'event',
    entity_id: null,
    user_id: USER,
    payload: { ids: ['a'], userId: USER },
    error: 'boom',
    failed_at: new Date('2026-08-09T09:00:00Z'),
    replayed_at: null,
    ...overrides,
  });

  it('orders newest first and binds the queue and stage filters as parameters', async () => {
    const harness = makeHarness(() => [letterRow()]);

    await harness.service.listDeadLetters(CTX, { queue: 'pipeline-embed', stage: 'index.embed' });

    const [select] = harness.statements;

    expect(select.sql).toContain('ORDER BY d.failed_at DESC, d.id DESC');
    expect(select.params[1]).toBe('pipeline-embed');
    expect(select.params[2]).toBe('index.embed');
  });

  it('includes letters with no attributable user and excludes other users', async () => {
    // NULL user_id means "not attributable" — maintenance sweeps, telemetry, a
    // payload too malformed to read a user out of. Those are frequently the most
    // important rows in the table, and hiding them would make the appliance's
    // own failures invisible on the one screen built to show failures.
    const harness = makeHarness(() => [letterRow({ user_id: null })]);

    const letters = await harness.service.listDeadLetters(CTX);

    expect(letters[0].userId).toBeNull();
    expect(harness.statements[0].sql).toContain('(d.user_id = $1::uuid OR d.user_id IS NULL)');
  });

  it('treats an absent `replayed` filter as "both"', async () => {
    const harness = makeHarness(() => []);

    await harness.service.listDeadLetters(CTX);

    expect(harness.statements[0].params[3]).toBeNull();

    const unreplayed = makeHarness(() => []);

    await unreplayed.service.listDeadLetters(CTX, { replayed: false });

    expect(unreplayed.statements[0].params[3]).toBe(false);
  });

  it('clamps the page, because every row carries a verbatim payload', async () => {
    const harness = makeHarness(() => []);

    await harness.service.listDeadLetters(CTX, { limit: 5000 });

    expect(harness.statements[0].params[4]).toBe(200);
  });

  it('returns the payload untouched', async () => {
    const payload = { ids: ['x'], nested: { deep: [1, 2, 3] } };
    const harness = makeHarness(() => [letterRow({ payload })]);

    const [letter] = await harness.service.listDeadLetters(CTX);

    expect(letter.payload).toEqual(payload);
  });
});

describe('PipelineRunService.replayDeadLetter', () => {
  const claimRow = (overrides: Record<string, unknown> = {}) => ({
    id: LETTER_ID,
    queue: 'pipeline-enrich',
    event_name: 'pipeline.slice',
    payload: { stage: 'enrich.geocode', ids: ['a', 'b'], userId: USER },
    replayed_at: new Date('2026-08-09T12:00:00Z'),
    ...overrides,
  });

  it('re-emits the payload verbatim onto the queue the job died on', async () => {
    // Payload fidelity is the entire reason the reaper stores `j.data`
    // untouched. This is the method that cashes it in.
    const payload = { stage: 'enrich.geocode', ids: ['a', 'b'], userId: USER, weird: { keys: true } };
    const harness = makeHarness(() => [claimRow({ payload })], ['job-9']);

    const result = await harness.service.replayDeadLetter(CTX, LETTER_ID);

    expect(harness.send).toHaveBeenCalledWith('pipeline.slice', payload, {
      queue: 'pipeline-enrich',
      priority: BACKFILL_JOB_PRIORITY,
      singletonKey: `${DEAD_LETTER_REPLAY_KEY_PREFIX}${LETTER_ID}`,
    });
    expect(result.jobIds).toEqual(['job-9']);
    expect(result.queue).toBe('pipeline-enrich');
  });

  it('routes a reaped letter by listener registration, never back onto the dead-letter queue', async () => {
    // pg-boss's `dead-letter` queue has no worker. Naming it would enqueue the
    // job where nothing will ever pick it up — a replay that reports success and
    // does nothing.
    const harness = makeHarness(() => [claimRow({ queue: DEAD_LETTER_QUEUE })]);

    const result = await harness.service.replayDeadLetter(CTX, LETTER_ID);

    expect(harness.send).toHaveBeenCalledWith('pipeline.slice', expect.any(Object), {
      priority: BACKFILL_JOB_PRIORITY,
      singletonKey: `${DEAD_LETTER_REPLAY_KEY_PREFIX}${LETTER_ID}`,
    });
    expect(result.queue).toBeNull();
  });

  it('claims replayed_at before emitting, and only while it is still NULL', async () => {
    const harness = makeHarness(() => [claimRow()]);

    await harness.service.replayDeadLetter(CTX, LETTER_ID);

    const [claim] = harness.matching(/UPDATE ci\.pipeline_dead_letters/);

    expect(claim.sql).toContain('SET replayed_at = now()');
    expect(claim.sql).toContain('replayed_at IS NULL');
    expect(claim.params).toEqual([USER, LETTER_ID]);
  });

  it('409s a letter that was already replayed, and emits nothing', async () => {
    // replayed_at is the idempotency flag that keeps "replay all" from looping.
    const harness = makeHarness((statement) =>
      isWrite(statement.sql) ? [] : [{ replayed_at: new Date('2026-08-09T08:00:00Z') }],
    );

    await expect(harness.service.replayDeadLetter(CTX, LETTER_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('404s a letter that does not exist or belongs to another user', async () => {
    const harness = makeHarness(() => []);

    await expect(harness.service.replayDeadLetter(CTX, LETTER_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('refuses a letter with no event name, and releases the claim', async () => {
    // The reaper records 'unknown' for a job whose payload carries no `name` —
    // one inserted by something other than EventService. There is nothing to
    // re-emit it as, and stamping it replayed would quietly retire the row.
    const harness = makeHarness(() => [claimRow({ event_name: 'unknown' })]);

    await expect(harness.service.replayDeadLetter(CTX, LETTER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const releases = harness.matching(/SET replayed_at = NULL/);

    expect(releases).toHaveLength(1);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('releases the claim when the emit throws', async () => {
    // A letter marked replayed that was never re-emitted is worse than one never
    // touched: the payload is often the only surviving copy of the record, and
    // the flag is what removes it from the replay queue.
    const harness = makeHarness(() => [claimRow()]);

    harness.send.mockRejectedValueOnce(new Error('pg-boss is down'));

    await expect(harness.service.replayDeadLetter(CTX, LETTER_ID)).rejects.toThrow('pg-boss is down');

    expect(harness.matching(/SET replayed_at = NULL/)).toHaveLength(1);
  });

  it('treats an empty send() result as a failed replay and releases the claim', async () => {
    // `send()` does not throw for an unknown queue or an event with no
    // listener — it warns and returns []. Swallowing that would leave the letter
    // reading as replayed with nothing enqueued.
    const harness = makeHarness(() => [claimRow()], []);

    await expect(harness.service.replayDeadLetter(CTX, LETTER_ID)).rejects.toBeInstanceOf(ConflictException);

    expect(harness.matching(/SET replayed_at = NULL/)).toHaveLength(1);
  });

  it('does not mask the original error when the release itself fails', async () => {
    const harness = makeHarness((statement) => {
      if (/SET replayed_at = NULL/.test(statement.sql)) {
        throw new Error('release failed');
      }

      return [claimRow()];
    });

    harness.send.mockRejectedValueOnce(new Error('pg-boss is down'));

    await expect(harness.service.replayDeadLetter(CTX, LETTER_ID)).rejects.toThrow('pg-boss is down');
    expect(harness.logger.error).toHaveBeenCalled();
  });
});

describe('PipelineRunService.replayDeadLetters (bulk)', () => {
  const LETTER_2 = '00000000-0000-7000-8000-0000000000d2';
  const LETTER_3 = '00000000-0000-7000-8000-0000000000d3';

  const claimRow = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    queue: DEAD_LETTER_QUEUE,
    event_name: 'infer.question.answer',
    payload: { questionId: 'q-1', ownerId: USER },
    replayed_at: new Date('2026-08-18T12:00:00Z'),
    ...overrides,
  });

  it('claims the whole batch in ONE statement, and only rows still un-replayed', async () => {
    // This is the double-submit guard. It has to be the database's, not the
    // caller's: two operators pressing the button at once are the case a
    // client-side check cannot cover.
    const harness = makeHarness(() => [claimRow(LETTER_ID), claimRow(LETTER_2)]);

    await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID, LETTER_2] });

    const claims = harness.matching(/UPDATE ci\.pipeline_dead_letters/);

    expect(claims).toHaveLength(1);
    expect(claims[0].sql).toContain('SET replayed_at = now()');
    expect(claims[0].sql).toContain('replayed_at IS NULL');
    // Locked for the claim, and skipped rather than blocked when another caller
    // already holds the row.
    expect(claims[0].sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claims[0].params[0]).toBe(USER);
    expect(claims[0].params[1]).toEqual([LETTER_ID, LETTER_2]);
  });

  it('a double submit claims nothing the second time and re-emits nothing', async () => {
    // First call claims both; second call's claim matches zero rows because
    // `replayed_at IS NULL` no longer holds. Nothing goes back on the bus twice.
    let call = 0;
    const harness = makeHarness(() => (call++ === 0 ? [claimRow(LETTER_ID), claimRow(LETTER_2)] : []));

    const first = await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID, LETTER_2] });
    const second = await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID, LETTER_2] });

    expect(first.replayed).toHaveLength(2);
    expect(second.claimed).toBe(0);
    expect(second.replayed).toHaveLength(0);
    expect(second.skipped).toEqual([LETTER_ID, LETTER_2]);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('reports named ids that claimed nothing as skipped, not as an error', async () => {
    // "Already replayed" is the guard working. A 409 for the batch would strand
    // the letters that DID claim.
    const harness = makeHarness(() => [claimRow(LETTER_ID)]);

    const result = await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID, LETTER_2, LETTER_3] });

    expect(result.requested).toBe(3);
    expect(result.claimed).toBe(1);
    expect(result.skipped).toEqual([LETTER_2, LETTER_3]);
    expect(result.failed).toHaveLength(0);
  });

  it('scans every named id — the page size is not a second, quieter cap', async () => {
    // The controller accepts up to MAX_DEAD_LETTER_PAGE ids, but the claim used
    // to default its LIMIT to DEFAULT_DEAD_LETTER_PAGE (50). A 60-id request
    // therefore replayed 50 and reported the other 10 as `skipped`, which the
    // Jobs card renders as "10 already replayed" — the one reading under which
    // an operator would never retry them.
    const ids = Array.from(
      { length: DEFAULT_DEAD_LETTER_PAGE + 10 },
      (_unused, index) => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    );
    const harness = makeHarness(() => []);

    const result = await harness.service.replayDeadLetters(CTX, { ids });

    // The LIMIT bind is the last parameter of the claim statement.
    const claim = harness.matching(/UPDATE ci\.pipeline_dead_letters/)[0];

    expect(claim.params[claim.params.length - 1]).toBe(ids.length);
    expect(result.limit).toBe(ids.length);
    expect(result.notAttempted).toEqual([]);
    expect(result.skipped).toHaveLength(ids.length);
  });

  it('reports ids beyond an explicit smaller limit as not attempted, never as skipped', async () => {
    // `skipped` means "looked at, nothing to claim" — settled. An id the ceiling
    // cut off is unsettled and the caller must ask again. Collapsing the two
    // loses exactly the distinction the operator acts on.
    const harness = makeHarness(() => [claimRow(LETTER_ID)]);

    const result = await harness.service.replayDeadLetters(CTX, {
      ids: [LETTER_ID, LETTER_2, LETTER_3],
      limit: 1,
    });

    expect(result.limit).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.notAttempted).toEqual([LETTER_2, LETTER_3]);
  });

  it('deduplicates ids so one letter cannot be requested twice in a batch', async () => {
    const harness = makeHarness(() => [claimRow(LETTER_ID)]);

    const result = await harness.service.replayDeadLetters(CTX, {
      ids: [LETTER_ID, LETTER_ID, LETTER_ID],
    });

    expect(harness.statements[0].params[1]).toEqual([LETTER_ID]);
    expect(result.requested).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('binds the eventName and failedAfter selectors, leaving ids NULL', async () => {
    // The "replay this one failure class" form: 36 of the live appliance's 94
    // letters were a single bad model id under infer.question.answer.
    const failedAfter = new Date('2026-08-18T00:00:00Z');
    const harness = makeHarness(() => []);

    await harness.service.replayDeadLetters(CTX, {
      eventName: 'infer.question.answer',
      failedAfter,
    });

    expect(harness.statements[0].params).toEqual([
      USER,
      null,
      'infer.question.answer',
      failedAfter,
      DEFAULT_DEAD_LETTER_PAGE,
    ]);
  });

  it('scopes to the caller, including the NULL-user letters the list shows', async () => {
    const harness = makeHarness(() => []);

    await harness.service.replayDeadLetters(CTX, { eventName: 'file.uploaded' });

    expect(harness.statements[0].sql).toContain('user_id = $1::uuid OR user_id IS NULL');
    expect(harness.statements[0].params[0]).toBe(USER);
  });

  it('clamps the batch ceiling, because every claimed letter re-emits a verbatim payload', async () => {
    const harness = makeHarness(() => []);

    await harness.service.replayDeadLetters(CTX, { eventName: 'file.uploaded', limit: 5000 });

    expect(harness.statements[0].params[4]).toBe(MAX_DEAD_LETTER_PAGE);
  });

  it('re-emits each claimed payload verbatim, at backfill priority', async () => {
    const payload = { questionId: 'q-9', ownerId: USER, nested: { deep: [1, 2] } };
    const harness = makeHarness(() => [claimRow(LETTER_ID, { payload })], ['job-7']);

    const result = await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID] });

    // `dead-letter` is pg-boss's parking queue: routed by listener registration
    // instead, exactly as the single-id path does it.
    expect(harness.send).toHaveBeenCalledWith('infer.question.answer', payload, {
      priority: BACKFILL_JOB_PRIORITY,
      singletonKey: `${DEAD_LETTER_REPLAY_KEY_PREFIX}${LETTER_ID}`,
    });
    expect(result.replayed[0]).toMatchObject({ id: LETTER_ID, jobIds: ['job-7'], queue: null });
  });

  it('one letter that cannot be re-emitted does not strand the rest of the batch', async () => {
    const harness = makeHarness(() => [claimRow(LETTER_ID), claimRow(LETTER_2), claimRow(LETTER_3)]);

    harness.send
      .mockResolvedValueOnce(['job-1'])
      .mockRejectedValueOnce(new Error('pg-boss is down'))
      .mockResolvedValueOnce(['job-3']);

    const result = await harness.service.replayDeadLetters(CTX, {
      ids: [LETTER_ID, LETTER_2, LETTER_3],
    });

    expect(result.claimed).toBe(3);
    expect(result.replayed.map((entry) => entry.id)).toEqual([LETTER_ID, LETTER_3]);
    expect(result.failed).toEqual([
      { id: LETTER_2, eventName: 'infer.question.answer', reason: 'pg-boss is down' },
    ]);
  });

  it('releases the claim on every letter that failed, so it stays replayable', async () => {
    // A letter marked replayed that was never re-emitted is worse than one never
    // touched — the payload is frequently the only surviving copy.
    const harness = makeHarness(() => [claimRow(LETTER_ID), claimRow(LETTER_2)]);

    harness.send.mockRejectedValueOnce(new Error('pg-boss is down')).mockResolvedValueOnce(['job-2']);

    await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID, LETTER_2] });

    const releases = harness.matching(/SET replayed_at = NULL/);

    expect(releases).toHaveLength(1);
    expect(releases[0].params).toEqual([LETTER_ID]);
  });

  it('treats an empty send() as a failure for that letter, not as a replay', async () => {
    // `send()` returns [] — it does not throw — for an event with no registered
    // listener. Counting that as success would retire the row having run nothing.
    const harness = makeHarness(() => [claimRow(LETTER_ID)], []);

    const result = await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID] });

    expect(result.replayed).toHaveLength(0);
    expect(result.failed[0].reason).toMatch(/nothing in this process listens/);
    expect(harness.matching(/SET replayed_at = NULL/)).toHaveLength(1);
  });

  it('refuses an unattributable letter and releases it, without failing the batch', async () => {
    const harness = makeHarness(() => [claimRow(LETTER_ID, { event_name: 'unknown' }), claimRow(LETTER_2)]);

    const result = await harness.service.replayDeadLetters(CTX, { ids: [LETTER_ID, LETTER_2] });

    expect(result.failed[0]).toMatchObject({ id: LETTER_ID });
    expect(result.failed[0].reason).toMatch(/carries no event name/);
    expect(result.replayed.map((entry) => entry.id)).toEqual([LETTER_2]);
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('emits nothing at all when the claim matched nothing', async () => {
    const harness = makeHarness(() => []);

    const result = await harness.service.replayDeadLetters(CTX, { eventName: 'nothing.matches' });

    expect(result).toMatchObject({ requested: null, claimed: 0, skipped: [] });
    expect(harness.send).not.toHaveBeenCalled();
  });
});

/**
 * Bulk replay against the de-duplication a real queue performs.
 *
 * The mock above answers every `send` with a job id, so it cannot observe what a
 * `policy: 'short'` queue does to a batch: pg-boss's `job_i1` is UNIQUE on
 * `(name, COALESCE(singleton_key,''))` over jobs still in `created`, and the
 * insert is ON CONFLICT DO NOTHING — so N keyless sends onto one such queue
 * create ONE job and hand back N-1 null ids, which `send()` reports as `[]`.
 * That is a bulk replay dropping every letter but the first, and it stayed green
 * for exactly as long as a mock stood in for the index.
 *
 * So the double below is an `EventService` — the real one, inheriting the real
 * routing (`getQueuesForEvent` / `getRegisteredQueues`) and reading the real
 * `EventListenerRegistry` queue policy — whose only invented part is the index
 * predicate itself, reproduced verbatim.
 */
describe('PipelineRunService.replayDeadLetters against a de-duplicating queue', () => {
  const REPLAY_QUEUE = 'planning';
  const REPLAY_EVENT = 'planning.inbox_scan';
  const LETTERS = [1, 2, 3].map((index) => `00000000-0000-7000-8000-00000000e00${index}`);

  /** A job in `created` — the rows pg-boss's partial unique index covers. */
  interface CreatedJob {
    queue: string;
    singletonKey: string;
  }

  class IndexedQueueEventService extends EventService {
    constructor(private readonly created: CreatedJob[]) {
      super();
    }

    async send(name: string, _event: unknown, options?: EventSendOptions): Promise<string[]> {
      const queues = options?.queue
        ? this.getRegisteredQueues().has(options.queue)
          ? [options.queue]
          : []
        : [...this.getQueuesForEvent(name)];

      const jobIds: string[] = [];

      for (const queue of queues) {
        const singletonKey = options?.singletonKey ?? '';
        const policy = EventListenerRegistry.getQueueOptions(queue)?.policy ?? 'standard';
        const conflicts =
          policy === 'short' &&
          this.created.some((job) => job.queue === queue && job.singletonKey === singletonKey);

        // ON CONFLICT DO NOTHING: pg-boss returns a null id rather than throwing,
        // and `send()` drops the null instead of reporting a job.
        if (conflicts) {
          continue;
        }

        this.created.push({ queue, singletonKey });
        jobIds.push(`job-${this.created.length}`);
      }

      return jobIds;
    }

    async sendMany(): Promise<void> {}

    async completeJob(): Promise<void> {}

    async failJob(): Promise<boolean> {
      return false;
    }

    async getJob(): Promise<null> {
      return null;
    }
  }

  interface QueueHarness {
    service: PipelineRunService;
    created: CreatedJob[];
    releases: Statement[];
  }

  /**
   * @param seeded singletonKeys already held by a `created` job on the queue.
   * @param registerListener false leaves the event unroutable, exactly as a
   *   listener module that never loaded in this process does.
   */
  function makeQueueHarness(
    claimed: Array<Record<string, unknown>>,
    { seeded = [] as string[], registerListener = true } = {},
  ): QueueHarness {
    EventListenerRegistry.clear();

    if (registerListener) {
      EventListenerRegistry.register(REPLAY_EVENT, 'InboxScanListener', 'scan', REPLAY_QUEUE, {
        policy: 'short',
      });
    }

    const created: CreatedJob[] = seeded.map((singletonKey) => ({ queue: REPLAY_QUEUE, singletonKey }));
    const statements: Statement[] = [];

    const query = jest.fn(async (raw: string, params: unknown[] = []) => {
      statements.push({ sql: raw.replace(/\s+/g, ' ').trim(), params });

      return /replayed_at = now\(\)/.test(raw) ? claimed : [];
    });

    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    return {
      service: new PipelineRunService(
        { query } as unknown as DataSource,
        new IndexedQueueEventService(created) as unknown as EventService,
        logger as unknown as LoggerService,
      ),
      created,
      releases: statements.filter((statement) => /SET replayed_at = NULL/.test(statement.sql)),
    };
  }

  const letterRow = (id: string) => ({
    id,
    queue: REPLAY_QUEUE,
    event_name: REPLAY_EVENT,
    payload: { userId: USER, letter: id },
    replayed_at: new Date('2026-08-20T12:00:00Z'),
  });

  afterEach(() => {
    EventListenerRegistry.clear();
  });

  it('enqueues EVERY letter of a batch onto one de-duplicating queue', async () => {
    const harness = makeQueueHarness(LETTERS.map(letterRow));

    const result = await harness.service.replayDeadLetters(CTX, { ids: LETTERS });

    expect(result.replayed.map((entry) => entry.id)).toEqual(LETTERS);
    expect(result.failed).toEqual([]);
    expect(harness.created.map((job) => job.singletonKey)).toEqual(
      LETTERS.map((id) => `${DEAD_LETTER_REPLAY_KEY_PREFIX}${id}`),
    );
  });

  it("does not collide with the live producer's key, in either direction", async () => {
    // The producer keys on the WORK; a replay keys on the letter. Sharing a
    // namespace would either swallow the replay or suppress the live job.
    const harness = makeQueueHarness([letterRow(LETTERS[0])], { seeded: [`inbox-scan:${USER}`] });

    const result = await harness.service.replayDeadLetters(CTX, { ids: [LETTERS[0]] });

    expect(result.replayed).toHaveLength(1);
    expect(harness.created).toHaveLength(2);
  });

  it('reports a real singleton conflict as one, never as a missing listener', async () => {
    // An earlier replay of this same letter is still sitting in `created`, so
    // the insert is refused. Reading that as "the listener module is not loaded"
    // sends an operator hunting a module-loading problem that does not exist,
    // mid-incident.
    const harness = makeQueueHarness([letterRow(LETTERS[0])], {
      seeded: [`${DEAD_LETTER_REPLAY_KEY_PREFIX}${LETTERS[0]}`],
    });

    const result = await harness.service.replayDeadLetters(CTX, { ids: [LETTERS[0]] });

    expect(result.replayed).toHaveLength(0);
    expect(result.failed[0].reason).toMatch(/singletonKey duplicates a job still in "created"/);
    expect(result.failed[0].reason).not.toMatch(/module/);
  });

  it('still names an unloaded listener module when nothing consumes the event', async () => {
    const harness = makeQueueHarness([letterRow(LETTERS[0])], { registerListener: false });

    const result = await harness.service.replayDeadLetters(CTX, { ids: [LETTERS[0]] });

    expect(result.replayed).toHaveLength(0);
    expect(result.failed[0].reason).toMatch(/nothing in this process listens/);
    expect(result.failed[0].reason).toMatch(/module is probably not loaded/);
    expect(harness.created).toEqual([]);
  });
});

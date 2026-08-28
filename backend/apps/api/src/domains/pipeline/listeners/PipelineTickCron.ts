import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { BackpressureService, type QueueAdmissions } from '../services/BackpressureService';

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/**
 * Tick cadence: every five minutes, at second 20.
 *
 * Off the top of the minute on purpose — `SyncOrchestrator`,
 * `AnswerInferenceCron` and `McpController` all fire at second 0, and the
 * dead-letter reaper took second 40 for the same reason. Stacking a fourth and
 * fifth scheduled job on the same second turns a quiet appliance into a
 * periodic spike.
 *
 * Five minutes, NOT thirty seconds. The tick itself is cheap — an advisory lock
 * and a due-check — but what it GUARDS is not: enrichment shares one Ollama
 * process with interactive chat, and two of the twelve stages egress to a
 * metered provider. A perpetual half-minute tick makes enrichment a permanent
 * background tenant of the appliance and a metered stage a recurring bill with
 * no natural stopping point.
 *
 * Cadence is decided in two places instead: ENRICHMENT_WINDOW says WHEN the
 * appliance is willing to spend, and STAGE_CADENCE says how often each stage
 * is due within it. This cron only has to fire often enough to notice the
 * window opening and to resume promptly after a restart.
 */
export const PIPELINE_TICK_CRON = '20 */5 * * * *';

// ---------------------------------------------------------------------------
// The cluster lock
// ---------------------------------------------------------------------------

/**
 * `classid` half of every advisory lock this domain takes. `0x6369` is ASCII
 * `ci`.
 *
 * Postgres advisory locks live in ONE flat namespace shared by every session on
 * the database, and nothing warns about a collision — two unrelated components
 * picking the same key silently exclude each other forever. A declared class id
 * plus a small per-cron object id keeps the key reviewable in a diff, which
 * `hashtext('pipeline.tick')` would not: a hash is opaque, cannot be checked
 * for collisions by reading, and is not contractually stable across Postgres
 * major versions.
 *
 * That namespace is already shared, so the collision risk above is live rather
 * than hypothetical. Three other components lock today:
 * `PipelineControlService` takes `(0x6369, 0x7443)` around the tick body — same
 * class, different object id, by agreement; `PGBossEventService` takes the
 * single-argument `804_551_297` around queue provisioning, which Postgres keys
 * separately from the two-int form; and `AccountPurgeService` takes
 * `pg_try_advisory_lock(hashtext('ci.account_purge'), hashtext(userId))`, which
 * lands in this same two-int space under keys nobody can check by reading. Any
 * new lock under this class must take an unused object id and be listed here.
 */
export const PIPELINE_ADVISORY_LOCK_CLASS = 0x6369;

/** Object id of the pipeline control tick. */
export const PIPELINE_TICK_LOCK_ID = 1;

// ---------------------------------------------------------------------------
// What the tick drives
// ---------------------------------------------------------------------------

/**
 * DI token for the thing this cron drives.
 *
 * A token rather than a class import so the timer and the tick body can land
 * independently, and so anything else (a test double, an operator route, a
 * future run-scoped planner) can be driven by the same schedule without this
 * file changing. `PipelineControlService` binds to it:
 *
 * ```ts
 * { provide: PIPELINE_TICK, useExisting: PipelineControlService },
 * ```
 *
 * With nothing bound the cron does nothing and SAYS SO — see
 * {@link PipelineTickCron.tickOnce}. Silence there would recreate the exact
 * defect this component exists to close: complete machinery that nothing calls.
 *
 * Note what the type system will NOT catch: a `tick()` taking no parameters is
 * assignable to {@link PipelineTick}, so an implementation that ignores
 * {@link PipelineTickInput.admissions} binds silently and reads as wired. The
 * admission snapshot is handed down as a convenience for a planner that wants
 * one already measured; a planner that intends to respect backpressure should
 * inject `BackpressureService` itself, where the compiler can see it.
 */
export const PIPELINE_TICK = 'PipelineTick';

/** What one tick was told about the appliance when it was asked to run. */
export interface PipelineTickInput {
  /**
   * Admission per resource class, measured ONCE for this tick.
   *
   * Handed down rather than re-measured per stage so every decision in a tick
   * is made from the same instant, and so the tick can be reasoned about from
   * its input instead of from whatever the queue happened to be doing between
   * two of its own queries.
   */
  admissions: QueueAdmissions;
}

/**
 * The tick contract. Deliberately one method.
 *
 * An implementation is expected to ENQUEUE and RECONCILE — read desired state,
 * reap expired leases, finalize runs, plan the next slices — and to return
 * promptly. It must not process work itself: the lock below is held for as long
 * as `tick()` runs, and a tick that does the work is a tick that stops every
 * other replica from ticking while it does it.
 */
export interface PipelineTick {
  tick(input: PipelineTickInput): Promise<unknown>;
}

/** What one call to {@link PipelineTickCron.tickOnce} did. */
export interface PipelineTickOutcome {
  /** The tick body ran in THIS process. */
  ran: boolean;

  /** Why it did not, when it did not. */
  skipped: 'lock_held' | 'no_target' | null;

  /** Wall time, including lock acquisition. */
  durationMs: number;
}

interface LockRow {
  locked: boolean;
}

interface UnlockRow {
  released: boolean;
}

/**
 * Ticks with no target before the cron says so again. The first tick always
 * warns, so an unbound tick is discovered immediately; 120 ticks at five
 * minutes is the reminder after it, roughly twice a day, quiet enough that it
 * is not the whole log.
 */
const UNBOUND_WARN_EVERY = 120;

/**
 * The timer that starts the pipeline — and the only cluster-safe one in this
 * repository.
 *
 * ── What was missing ───────────────────────────────────────────────────────
 *
 * Twelve stages resolve, `PipelineDispatchService.startSweep()` works,
 * `PipelineRunService` manages runs and `PipelineSliceListener` executes
 * slices. Nothing called any of it: no cron, no scheduled caller and no
 * controller route reached the dispatcher, the only `@Cron` in the domain was
 * the dead-letter reaper, and `ci.pipeline_runs` had never held a row. The
 * enrichment machinery was complete and inert — a pipeline that could not
 * start.
 *
 * ── Cluster safety, which is not optional here ─────────────────────────────
 *
 * `@Cron` is `@nestjs/schedule`, which is IN-PROCESS: every replica has its own
 * timer and every schedule fires once per replica. That is why the Phase 5
 * worker split is blocked on this file — splitting first would double-fire
 * every cron in the appliance, and a doubled pipeline tick means two planners
 * enqueueing the same slices against the same ledger.
 *
 * The guard is therefore a DURABLE lock and not an in-memory flag: a boolean on
 * the instance is per-process, so under two replicas it is two booleans that
 * both say "no tick is running" while two ticks run.
 *
 * `pg_try_advisory_lock(classid, objid)` is taken for the duration of the tick
 * and released after it. `try`, never the blocking form: a tick that cannot get
 * the lock has nothing to do — another node is already doing exactly this work
 * — so it returns immediately rather than queueing up a thundering herd of
 * ticks behind whichever node is slow.
 *
 * Three properties fall out of it, and the third is free:
 *
 *  1. **Cross-process.** The lock lives in the database every replica shares.
 *  2. **Self-releasing on death.** A session-level advisory lock is released
 *     when its session ends, so a `kill -9` mid-tick costs one tick, not a
 *     permanently stuck pipeline. This is why the lock is not written to a
 *     table: a row would have to be reaped by something, and that something
 *     would need a lock.
 *  3. **Re-entrancy, for free.** Each tick takes its own `QueryRunner` and
 *     therefore its own session, so a tick that overruns its five-minute cadence
 *     blocks the NEXT tick on the same node exactly as it blocks another node's.
 *     No separate "already running" flag, and no way for the two mechanisms to
 *     disagree.
 *
 * ── Why a QueryRunner, and why that is load-bearing ────────────────────────
 *
 * A session-level advisory lock belongs to the CONNECTION that took it.
 * `dataSource.query()` borrows an arbitrary connection from the pool per
 * statement, so acquiring through it and releasing through it would frequently
 * unlock on a different session: `pg_advisory_unlock` returns false with a
 * warning, and the real lock stays held on a pooled connection until the
 * process restarts — a pipeline stopped forever, with nothing in the logs but
 * one line nobody reads. The runner pins both statements to one session, and
 * the `finally` releases both the lock and the connection on every path.
 *
 * The transaction-scoped variant (`pg_try_advisory_xact_lock`) would make
 * release automatic, and is rejected on purpose: it requires an open
 * transaction for the whole tick, and an open transaction holds a snapshot,
 * which holds back vacuum on the busiest tables on the appliance for as long as
 * the tick runs. A tick is not worth pinning `xmin` for.
 *
 * ── Why a rejected tick must not escape ────────────────────────────────────
 *
 * `@nestjs/schedule` builds `CronJob.from({ onTick: target })` without
 * `waitForCompletion`, and `cron` only awaits — and therefore only catches —
 * the callback when that flag is set. Nothing awaits a `@Cron` method, so an
 * async tick that rejects is an UNHANDLED REJECTION, and `application.ts`
 * answers those with `process.exit(1)`. On a repeating timer that is a crash
 * loop: the API dies because the pipeline could not plan a slice.
 * `DeadLetterReaperListener` had exactly this bug and fixed it the same way, so
 * {@link runOnSchedule} catches and logs while {@link tickOnce} — the on-demand
 * entry point — still propagates, because a caller that can see an error should
 * get one.
 *
 * ── One lock here, a different lock inside the tick ────────────────────────
 *
 * `PipelineControlService` takes an advisory lock of its OWN, under the same
 * class id and a different object id, around the body of `tick()`. The two are
 * deliberately different keys and they guard different things:
 *
 *  - this one serialises the DRIVER — one appliance-wide ticker, and no
 *    re-entry from the next scheduled fire while a slow tick is still running;
 *  - that one serialises the tick BODY across every caller, including an
 *    operator route or a replay that never went through a timer.
 *
 * The nesting is always outer-here, inner-there, and both are `try` rather than
 * blocking, so they cannot deadlock. They MUST NOT be collapsed onto one key:
 * the inner lock is taken on its own session, so sharing a key would mean this
 * cron holds the lock its own callee then fails to acquire, and every tick
 * would report skipped while the pipeline sat still. If the control service
 * ever stops locking internally, this key becomes the only guard and nothing
 * here changes.
 *
 * Two schedules driving one tick is redundant, not unsafe — whichever fires
 * first takes the inner lock and the other returns having done nothing — but
 * only one of them should ship. See the registration note in the change that
 * introduces this file.
 */
@Injectable()
export class PipelineTickCron {
  /**
   * The advisory lock key, as fields rather than as constants read directly.
   *
   * The default IS {@link PIPELINE_ADVISORY_LOCK_CLASS} /
   * {@link PIPELINE_TICK_LOCK_ID} and a spec pins that. They are overridable
   * only so a test can exercise the real acquire/release cycle against a key
   * that a live appliance's own tick is not holding at that moment.
   */
  protected readonly lockClassId: number = PIPELINE_ADVISORY_LOCK_CLASS;

  protected readonly lockObjectId: number = PIPELINE_TICK_LOCK_ID;

  /** Consecutive ticks that found no {@link PIPELINE_TICK} bound. */
  private unboundTicks = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly backpressure: BackpressureService,
    private readonly logger: LoggerService,
    @Optional() @Inject(PIPELINE_TICK) private readonly target?: PipelineTick,
  ) {
    this.logger.setContext(PipelineTickCron.name);
  }

  /**
   * The scheduled tick.
   *
   * Swallows everything. The next tick is five minutes away and retries; an
   * unhandled rejection here would exit the process, which is a strictly worse
   * outcome than one missed planning pass.
   */
  @Cron(PIPELINE_TICK_CRON, { name: 'PipelineTickCron.runOnSchedule' })
  async runOnSchedule(): Promise<void> {
    try {
      await this.tickOnce();
    } catch (err: unknown) {
      this.logger.error(
        'Pipeline tick failed; will retry on the next tick',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * One tick, on demand — for an operator route, a test, or anything that wants
   * an answer instead of a schedule.
   *
   * Propagates. The scheduled path is the one that must not, and the two entry
   * points diverge there deliberately: a caller that can report an error should
   * get one.
   */
  async tickOnce(): Promise<PipelineTickOutcome> {
    const startedAt = Date.now();

    if (this.target == null) {
      this.unboundTicks += 1;

      // Loud on the first tick and roughly hourly after it. A cron wired to
      // nothing is the failure this component exists to delete, so it may not
      // be silent — and it may not be a log line per tick either, or nobody
      // will read the rest of the file.
      if (this.unboundTicks === 1 || this.unboundTicks % UNBOUND_WARN_EVERY === 0) {
        this.logger.warn(
          `The pipeline tick has no "${PIPELINE_TICK}" bound, so nothing is being planned. Bind it in ` +
            `PipelineModule — { provide: PIPELINE_TICK, useExisting: PipelineControlService } — or remove ` +
            `this cron. It has now ticked ${this.unboundTicks} time(s) with nothing to drive.`,
          { ticks: this.unboundTicks },
        );
      }

      // No lock is taken: there is nothing to serialise, and taking one would
      // make an idle appliance's `pg_locks` look like a pipeline that is
      // running.
      return { ran: false, skipped: 'no_target', durationMs: Date.now() - startedAt };
    }

    this.unboundTicks = 0;

    const runner = this.dataSource.createQueryRunner();
    let held = false;

    try {
      await runner.connect();

      // `QueryRunner.query` is untyped (`Promise<any>`), unlike
      // `DataSource.query`, so the row shape is asserted at the call site.
      const lockRows = (await runner.query(`SELECT pg_try_advisory_lock($1::int, $2::int) AS locked`, [
        this.lockClassId,
        this.lockObjectId,
      ])) as LockRow[] | undefined;

      held = lockRows?.[0]?.locked === true;

      if (!held) {
        // Normal on a multi-replica appliance, and normal on one replica whose
        // previous tick has overrun. Debug, not warn: this is the mechanism
        // working.
        this.logger.debug('Pipeline tick skipped: another session holds the tick lock', {
          lockClassId: this.lockClassId,
          lockObjectId: this.lockObjectId,
        });

        return { ran: false, skipped: 'lock_held', durationMs: Date.now() - startedAt };
      }

      // Measured once, inside the lock, and handed to the tick. `snapshot()`
      // never throws — an unmeasurable queue comes back CLOSED — so backpressure
      // can stop work being admitted but can never stop the tick from running.
      // That distinction matters: the tick also reads operator intent and reaps
      // leases, and a cancel must be honoured on a saturated appliance, which is
      // exactly when somebody is most likely to be pressing cancel.
      const admissions: QueueAdmissions = await this.backpressure.snapshot();

      await this.target.tick({ admissions });

      const durationMs = Date.now() - startedAt;

      this.logger.debug('Pipeline tick complete', {
        durationMs,
        admitted: [...admissions.values()]
          .filter((admission) => admission.admitted)
          .map((admission) => admission.queue),
        closed: [...admissions.values()]
          .filter((admission) => !admission.admitted)
          .map((admission) => `${admission.queue}:${admission.reason}`),
      });

      return { ran: true, skipped: null, durationMs };
    } finally {
      // Both halves of the teardown run on every path — a throw from the tick,
      // a throw from the lock statement, an early return. Releasing the lock is
      // what keeps a failing tick from stopping the pipeline permanently;
      // releasing the runner is what keeps a failing tick from leaking the
      // connection pool one connection per tick.
      if (held) {
        await this.releaseLock(runner);
      }

      try {
        await runner.release();
      } catch (err: unknown) {
        this.logger.error(
          'Failed to release the pipeline tick query runner',
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  /**
   * Release the tick lock on the SAME session that took it.
   *
   * Never throws: this runs in a `finally`, and an error thrown here would
   * replace whatever the tick failed with — hiding the real failure behind the
   * cleanup. A lock that genuinely could not be released is one whose session is
   * gone, and Postgres has already released it in that case.
   */
  private async releaseLock(runner: QueryRunner): Promise<void> {
    try {
      const rows = (await runner.query(`SELECT pg_advisory_unlock($1::int, $2::int) AS released`, [
        this.lockClassId,
        this.lockObjectId,
      ])) as UnlockRow[] | undefined;

      if (rows?.[0]?.released !== true) {
        // Postgres answers false when this session did not hold the lock, which
        // cannot happen on this path — reaching it means the acquire and the
        // release ran on different sessions, i.e. the runner stopped pinning
        // the connection. That is the failure that stops the pipeline forever,
        // so it is reported at error level with the key in it.
        this.logger.error(
          `pg_advisory_unlock(${this.lockClassId}, ${this.lockObjectId}) reported that this session did ` +
            `not hold the pipeline tick lock. The lock may now be held by a pooled connection until this ` +
            `process restarts, and no replica will tick until then.`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        'Failed to release the pipeline tick advisory lock',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}

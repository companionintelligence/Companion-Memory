import { Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronTime } from 'cron';
import { Repository } from 'typeorm';

import { RequestContext } from '@ci/common/context';
import { JobControlStore } from '@ci/common/job-controls';
import { processRole, serves, type ServedRole } from '@ci/common/roles';
import { type CronDeclaration, CronRegistry, CronRunStore } from '@ci/common/schedule';

import { DEAD_LETTER_QUEUE } from '../constants';
import { PgBossArchiveEntity } from '../entities/PgBossArchiveEntity';
import { PgBossJobEntity } from '../entities/PgBossJobEntity';
import { PgBossQueueEntity } from '../entities/PgBossQueueEntity';
import { PgBossScheduleEntity } from '../entities/PgBossScheduleEntity';

/** Why a job failed, lifted out of `pgboss.job.output`. */
export interface JobFailureDto {
  readonly message: string;
  readonly stack?: string;
  readonly failedAt?: string;
}

/**
 * One job, as the dashboard is allowed to see it.
 *
 * This deliberately does NOT carry `data` or `output` verbatim. A job payload is
 * user content — `graph.person.created` carries name, email, phone and bio;
 * `graph.node.upserted` carries a node's name, description and searchable text —
 * and the dashboard
 * endpoint is guarded only by "some user is authenticated", with no owner
 * predicate on the rows it returns. Serialising the payloads therefore handed
 * any signed-in user the most recent 25 jobs of whoever happened to generate
 * them, which is the one invariant the rest of this codebase enforces
 * everywhere.
 *
 * The projection below is what the UI actually reads — the event name, the smart
 * rotation work type, and a failure's message/stack — so nothing on screen is
 * lost. `payloadBytes` keeps the one genuinely useful property of the raw blob
 * (spotting a job carrying a megabyte of data) without disclosing it.
 */
export interface JobRecordDto {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly priority: number;
  readonly retryLimit: number;
  readonly retryCount: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly createdOn: string;
  readonly startAfter: string;
  readonly startedOn?: string;
  readonly completedOn?: string;
  readonly deadLetter?: string | null;
  readonly policy?: string | null;
  /** The event name this job dispatches on (`data->>'name'`). */
  readonly event: string | null;
  /** `smart.rotation.work` payloads only — which kind of rotation work this is. */
  readonly workType: string | null;
  /** Size of the withheld payload, so an oversized job is still visible as one. */
  readonly payloadBytes: number;
  readonly failure: JobFailureDto | null;
}

export interface ArchivedJobRecordDto extends JobRecordDto {
  readonly archivedOn: string;
}

export interface JobScheduleDto {
  readonly name: string;
  readonly cron: string;
  readonly timezone?: string | null;
  readonly createdOn: string;
  readonly updatedOn: string;
  readonly data: Record<string, unknown> | null;
  readonly options: Record<string, unknown> | null;
}

/**
 * A recurring job as this codebase actually schedules them.
 *
 * The `schedules` field above reads `pgboss.schedule`, and that table is empty
 * on every appliance ever shipped: nothing calls `boss.schedule()`, because all
 * recurring work is declared with the NestJS `@Cron` decorator instead. So the
 * dashboard's "Schedules — Recurring system jobs" column has never had a row to
 * show, while ~34 real schedules ran invisibly beside it.
 *
 * These come from Nest's own `SchedulerRegistry`, which is the live registry the
 * scheduler fires from — so what the dashboard lists is exactly what is
 * registered in THIS process, including the `role` gating that keeps
 * worker-only crons out of the web process.
 *
 * `lastRunAt` is read from `ci.cron_runs` (durable across restarts), not from
 * the in-memory SchedulerRegistry `lastDate()` alone — otherwise a two-week
 * outage would look like "never run" after boot.
 */
export interface CronScheduleDto {
  /** Registration key — `ClassName.methodName` unless the cron was named. */
  readonly name: string;
  /** The cron expression as registered. */
  readonly cron: string;
  readonly timezone?: string | null;
  /**
   * Whether the scheduler currently has this job started.
   *
   * NOT health. The `@Cron` wrapper catches, logs and returns, so a schedule
   * whose body throws on every tick stays started forever. Read this with
   * {@link lastSuccessAt} and {@link overdue}, never alone.
   *
   * `null` when {@link servedHere} is false: the scheduler holding this job is
   * in the other process and this one cannot see it. Distinct from `false`,
   * which means the local scheduler has it and has it stopped — the card
   * renders that as "stopped", which is exactly wrong for a schedule ticking
   * normally one process over.
   */
  readonly running: boolean | null;
  /** Next fire time, ISO-8601, or null if the job is stopped. */
  readonly nextRunAt: string | null;
  /**
   * Last *attempt*, ISO-8601, or null if none has ever been recorded. Stamped
   * before the body runs, so it stays fresh for a tick that threw.
   */
  readonly lastRunAt: string | null;
  /**
   * Last tick whose body returned without throwing, ISO-8601, or null if none
   * has. "Returned" is the whole claim: a cron that exits on a feature gate
   * counts. What it rules out is the schedule that has been failing for weeks
   * while {@link lastRunAt} stayed two minutes old.
   */
  readonly lastSuccessAt: string | null;
  /**
   * The schedule's own expression says it should have fired by now, and no
   * attempt was recorded for that fire.
   *
   * False when nothing has ever been recorded: a freshly installed appliance
   * cannot tell "never fired in three weeks" from "booted a minute ago", and
   * lighting up all 40 rows on first boot would teach operators to ignore the
   * column.
   *
   * Also false when {@link disabled} — a schedule the operator switched off is
   * not late, and reporting it as overdue would turn every deliberate choice
   * into an alarm.
   */
  readonly overdue: boolean;
  /**
   * The operator switched this schedule off (`ci.job_settings`, kind `cron`).
   *
   * The scheduler still has it registered and still ticks it — the gate is
   * inside the `@Cron` wrapper — so `running` stays true and `nextRunAt` keeps
   * advancing. Without this flag the row would look perfectly healthy while
   * doing nothing, which is precisely the "silent failure" a disable is
   * supposed not to be.
   */
  readonly disabled: boolean;
  /** Which process runs it. Every schedule in the build is listed, both roles. */
  readonly role: ServedRole;
  /**
   * Whether the process that answered is the one whose scheduler holds it.
   *
   * False only under the web/worker split, and it is what makes the rest of the
   * row readable: `running`, `nextRunAt` and `overdue` are live scheduler state
   * this process does not have, so they are null/false rather than claimed.
   * `lastRunAt`, `lastSuccessAt` and `disabled` are durable and mean the same
   * either way.
   */
  readonly servedHere: boolean;
}

export interface JobQueueDto {
  readonly name: string;
  readonly policy?: string | null;
  /**
   * Null when the queue never set its own — pg-boss resolves retries as
   * COALESCE(job, queue, constructor default), so a NULL here means "inherits
   * the client default", not "no retries". Typed nullable because it genuinely
   * is: declaring it `number` made the UI print the string "null".
   */
  readonly retryLimit: number | null;
  readonly retryDelay: number | null;
  readonly retryBackoff: boolean | null;
  readonly expireInSeconds?: number | null;
  readonly retentionMinutes?: number | null;
  readonly deadLetter?: string | null;
  readonly createdOn: string;
  readonly updatedOn?: string;
}

export interface JobDistributionDto {
  readonly jobName: string;
  readonly count: number;
}

export interface JobQueueDistributionDto {
  readonly queue: string;
  readonly count: number;
}

export interface SmartRotationWorkDistributionDto {
  readonly workType: string;
  readonly count: number;
}

export interface JobDashboardDto {
  readonly summary: {
    /** Queued work waiting to run. EXCLUDES dead letters (see `deadLettered`). */
    readonly pending: number;
    readonly active: number;
    /** Failed once and waiting on its retry delay — still live work. */
    readonly retry: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    /**
     * Jobs that exhausted their retries and were copied to the dead-letter
     * queue. Counted separately because pg-boss inserts them in state
     * `created`, so a naive "pending" count reports them as a live backlog —
     * while the same jobs are ALSO counted under `failed` on their own queue.
     */
    readonly deadLettered: number;
    readonly scheduled: number;
  };
  /** Lifetime completed/failed jobs grouped by handler (from archive). */
  readonly archiveDistribution: readonly JobDistributionDto[];
  /** Currently pending/in-flight jobs grouped by handler. */
  readonly activeDistribution: readonly JobDistributionDto[];
  /** Active jobs grouped by queue name. */
  readonly queueDistribution: readonly JobQueueDistributionDto[];
  /** Smart rotation meta-jobs broken down by workType in payload. */
  readonly smartRotationDistribution: readonly SmartRotationWorkDistributionDto[];
  readonly jobs: readonly JobRecordDto[];
  readonly archive: readonly ArchivedJobRecordDto[];
  /** pg-boss's own schedules. Always empty here — see {@link CronScheduleDto}. */
  readonly schedules: readonly JobScheduleDto[];
  /** The recurring jobs this appliance actually runs, from Nest's scheduler. */
  readonly crons: readonly CronScheduleDto[];
  readonly queues: readonly JobQueueDto[];
}

@Injectable()
export class JobMonitorService {
  private readonly recentLimit = 25;

  constructor(
    @InjectRepository(PgBossJobEntity)
    private readonly jobRepository: Repository<PgBossJobEntity>,
    @InjectRepository(PgBossArchiveEntity)
    private readonly archiveRepository: Repository<PgBossArchiveEntity>,
    @InjectRepository(PgBossScheduleEntity)
    private readonly scheduleRepository: Repository<PgBossScheduleEntity>,
    @InjectRepository(PgBossQueueEntity)
    private readonly queueRepository: Repository<PgBossQueueEntity>,
    /**
     * Optional on purpose. `ScheduleModule.forRoot()` is registered globally in
     * `application.ts`, so the real app always has this — but EventsModule does
     * not import it, and a module compiled in isolation (the files e2e suite
     * pulls EventsModule in transitively) therefore cannot resolve it. Marking
     * it optional keeps this module standalone-compilable, and the degraded
     * behaviour is honest rather than approximate: no scheduler in the process
     * means there genuinely are no recurring jobs to report.
     */
    @Optional() private readonly schedulerRegistry?: SchedulerRegistry,
  ) {}

  private readonly logger = new Logger(JobMonitorService.name);

  async getDashboard(context: RequestContext): Promise<JobDashboardDto> {
    if (!context.userId) {
      throw new UnauthorizedException('A user context is required.');
    }

    const [
      jobs,
      archive,
      schedules,
      queues,
      summary,
      archiveDistribution,
      activeDistribution,
      queueDistribution,
      smartRotationDistribution,
      crons,
    ] = await Promise.all([
      this.jobRepository.find({
        order: { createdOn: 'DESC' },
        take: this.recentLimit,
      }),
      this.archiveRepository.find({
        order: { archivedOn: 'DESC' },
        take: this.recentLimit,
      }),
      this.scheduleRepository.find({ order: { name: 'ASC' } }),
      this.queueRepository.find({ order: { name: 'ASC' } }),
      this.getSummary(),
      this.getArchiveDistribution(),
      this.getActiveDistribution(),
      this.getQueueDistribution(),
      this.getSmartRotationDistribution(),
      this.getCronSchedules().catch((err: unknown) => {
        this.logger.warn(
          `Cron schedule panel unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );

        return [];
      }),
    ]);

    return {
      crons,
      summary,
      archiveDistribution,
      activeDistribution,
      queueDistribution,
      smartRotationDistribution,
      jobs: jobs.map((job) => this.toJobRecord(job)),
      archive: archive.map((job) => this.toArchivedJobRecord(job)),
      schedules: schedules.map((schedule) => this.toScheduleDto(schedule)),
      queues: queues.map((queue) => this.toQueueDto(queue)),
    } satisfies JobDashboardDto;
  }

  /**
   * Kick registered Nest cron jobs once (same path the scheduler uses).
   *
   * Useful after downtime or a deploy so operators do not wait for every
   * cadence. Each tick still stamps `ci.cron_runs` via the `@Cron` wrapper.
   *
   * `fireOnTick` does not await async cron bodies; work continues in the
   * background and lands on pg-boss like a normal tick.
   *
   * **A name this process cannot fire is reported, not dropped.** Under the
   * split, the process serving HTTP is `CI_ROLE=web`, which holds none of the
   * eleven worker schedules. Asking it for one walked a registry the name was
   * not in, matched nothing, and returned `{fired: [], skipped: [], errors: []}`
   * — a success-shaped answer to a request that did nothing, for the one
   * operation whose whole purpose is making something happen now. Firing across
   * processes is not possible (`fireOnTick` is a handle on a live job), so the
   * honest outcome is an error naming the process that can.
   */
  fireCronJobs(names?: readonly string[]): {
    fired: string[];
    skipped: string[];
    errors: { name: string; error: string }[];
  } {
    const fired: string[] = [];
    const skipped: string[] = [];
    const errors: { name: string; error: string }[] = [];

    if (!this.schedulerRegistry) {
      return {
        fired,
        skipped,
        errors: [{ name: '*', error: 'SchedulerRegistry is not available in this process' }],
      };
    }

    const allow = names && names.length > 0 ? new Set(names) : null;
    const jobs = this.schedulerRegistry.getCronJobs();

    for (const requested of allow ?? []) {
      if (jobs.has(requested)) {
        continue;
      }

      const declared = CronRegistry.get(requested);

      errors.push({
        name: requested,
        error: declared
          ? `"${requested}" runs in the ${declared.role} process (this one is ${processRole()}), so its ` +
            `scheduler is not here to fire. Run it from that process, or switch it off and on from the ` +
            `Jobs page if you only need the setting to change.`
          : `"${requested}" is not a schedule in this build.`,
      });
    }

    for (const [name, job] of jobs) {
      if (allow && !allow.has(name)) {
        skipped.push(name);
        continue;
      }

      try {
        job.fireOnTick();
        fired.push(name);
      } catch (err: unknown) {
        errors.push({
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { fired, skipped, errors };
  }

  /**
   * Every recurring job on the appliance, whether or not this process runs it.
   *
   * `nextRunAt` comes from the live registry. `lastRunAt` prefers the durable
   * `ci.cron_runs` row (survives restarts) and falls back to in-memory
   * `lastDate()` for the rare tick that has not flushed yet. `lastSuccessAt`
   * has no in-memory equivalent — only the wrapper knows whether the body
   * returned — so it is durable-only.
   *
   * `overdue` is computed here rather than left to the UI because it needs the
   * cron expression evaluated, and the only evaluator is the `CronTime` the
   * registry is holding.
   *
   * ── The schedules this process does not run ────────────────────────────────
   *
   * Under the Procfile's split the API is `CI_ROLE=web` and the eleven
   * `role: 'worker'` schedules never register with its scheduler, so this
   * reported 42 of 53. #2539 moved the switches into the Schedules table and
   * #2546 gave the controls payload the complete list, so the card now fills the
   * gap by appending the names the controls endpoint knows and this one does not
   * — but it can only invent a row, and it invents `running: false`, which the
   * status badge renders as **stopped**. Eleven schedules ticking normally in
   * the worker therefore read as stopped on the page an operator opens to find
   * out what stopped, with dashes where their history should be.
   *
   * The durable half of the answer was already in hand here: `ci.cron_runs` is
   * written by whichever process ticks, `runsByName()` loads all of it, and
   * those eleven rows were being fetched and thrown away for want of a registry
   * entry. That is also why the page's `never-succeeded` verdict — its only
   * critical schedule signal — could not fire for a worker schedule however long
   * one had been broken: it reads `lastRunAt`/`lastSuccessAt` off this list.
   *
   * So they are listed here, from {@link CronRegistry}, carrying exactly what
   * durable state supports: last run, last success, and the operator's own
   * on/off. What they deliberately do NOT carry is `running`, `nextRunAt` or
   * `overdue` — facts about a process, not about the build. This process cannot
   * know whether the worker is up, and no cron evaluator is resolvable here to
   * compute a fire time for an expression nothing local has parsed. `running` is
   * `null` rather than `false` so the badge can tell "elsewhere" from "stopped".
   */
  private async getCronSchedules(): Promise<CronScheduleDto[]> {
    const schedules: CronScheduleDto[] = [];
    const persisted = await CronRunStore.runsByName();
    const registered = new Set<string>();

    const now = Date.now();

    for (const [name, job] of this.schedulerRegistry?.getCronJobs() ?? []) {
      registered.add(name);
      let nextRunAt: string | null = null;
      let memoryLastRunAt: string | null = null;
      const durable = persisted.get(name);

      try {
        nextRunAt = job.nextDate()?.toISO() ?? null;
      } catch {
        // A stopped job throws rather than returning nothing. Not an error —
        // the dashboard just shows no next run for it.
      }

      try {
        memoryLastRunAt = job.lastDate()?.toISOString() ?? null;
      } catch {
        // Never fired since boot.
      }

      const times = [
        durable?.lastRunAt.getTime(),
        memoryLastRunAt ? Date.parse(memoryLastRunAt) : Number.NaN,
      ].filter((value): value is number => Number.isFinite(value));

      const lastRunAt = times.length > 0 ? Math.max(...times) : null;

      const disabled = JobControlStore.cronMode(name) === 'disabled';

      schedules.push({
        name,
        cron: String(job.cronTime?.source ?? ''),
        timezone: job.cronTime?.timeZone ?? null,
        running: Boolean(job.isActive),
        nextRunAt,
        lastRunAt: lastRunAt == null ? null : new Date(lastRunAt).toISOString(),
        lastSuccessAt: durable?.lastSuccessAt?.toISOString() ?? null,
        overdue: !disabled && isOverdue(job.cronTime, lastRunAt, now),
        disabled,
        // The DECLARED role, which is a fact about the build. Deriving it from
        // the process role was wrong under CI_ROLE=all, where every worker
        // schedule registers locally and so reported itself as `web` — the
        // preview fixture models role as a declaration for exactly this reason.
        // The fallback covers a job registered without the decorator.
        role: CronRegistry.get(name)?.role ?? (serves('web') ? 'web' : 'worker'),
        servedHere: true,
      });
    }

    for (const declaration of CronRegistry.all()) {
      if (registered.has(declaration.name)) {
        continue;
      }

      const durable = persisted.get(declaration.name);
      const disabled = JobControlStore.cronMode(declaration.name) === 'disabled';
      const lastRunAtMs = durable?.lastRunAt.getTime() ?? null;

      schedules.push({
        name: declaration.name,
        cron: declaration.cron,
        timezone: declaration.timeZone,
        // Not `false`, which the card renders as "stopped".
        running: null,
        nextRunAt: null,
        // The whole reason this loop exists: written by whichever process ticks,
        // and discarded here until now.
        lastRunAt: durable?.lastRunAt.toISOString() ?? null,
        lastSuccessAt: durable?.lastSuccessAt?.toISOString() ?? null,
        // Derived from durable state alone: the declaration carries the
        // expression and timezone, ci.cron_runs carries the last attempt, and
        // `cron` is a direct dependency so the expression can be evaluated here.
        // This is the one signal that catches a dead worker process — a daily
        // schedule whose last attempt is three days old — and it is the signal
        // listing these rows was meant to restore. Hardcoding it false left the
        // dashboard unable to say anything had gone wrong in the other process.
        overdue: !disabled && isOverdue(cronTimeFor(declaration), lastRunAtMs, now),
        disabled,
        role: declaration.role,
        servedHere: false,
      });
    }

    return schedules.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The headline counters.
   *
   * Two grouped scans, not seven `COUNT(*)`s. `pgboss.job` is partitioned by
   * queue name, so every count over it is an Append of a sequential scan across
   * every partition; the previous implementation paid that five times over
   * (created/active/completed/failed) plus two full scans of `pgboss.archive`,
   * on a 15-second poll, per open dashboard tab. `pgboss.archive` is created as
   * `CREATE TABLE archive (LIKE job)` and carries only an index on
   * `archived_on`, so a `WHERE state = …` count there is always a full scan —
   * measured at 16 ms over 88k rows and growing linearly. Grouping collapses
   * each table to a single pass.
   *
   * The dead-letter queue is excluded from `pending` on purpose: pg-boss inserts
   * a dead-lettered job in state `created`, which is indistinguishable by state
   * alone from work that is waiting to run. Counting it as pending reported
   * 1,191 dead jobs as a live backlog on a real appliance — while the SAME jobs
   * were also counted under `failed` on their original queue. They get their own
   * counter instead.
   */
  private async getSummary(): Promise<JobDashboardDto['summary']> {
    const [jobRows, archiveRows] = await Promise.all([
      this.jobRepository
        .createQueryBuilder('job')
        .select('job.state', 'state')
        .addSelect(`COUNT(*) FILTER (WHERE job.name = :deadLetter)::int`, 'deadLettered')
        .addSelect('COUNT(*)::int', 'count')
        .setParameter('deadLetter', DEAD_LETTER_QUEUE)
        .groupBy('job.state')
        .getRawMany<{ state: string; count: number; deadLettered: number }>(),
      this.archiveRepository
        .createQueryBuilder('archive')
        .select('archive.state', 'state')
        .addSelect('COUNT(*)::int', 'count')
        .groupBy('archive.state')
        .getRawMany<{ state: string; count: number }>(),
    ]);

    const job = (state: string) => Number(jobRows.find((row) => row.state === state)?.count ?? 0);
    const archived = (state: string) => Number(archiveRows.find((row) => row.state === state)?.count ?? 0);

    // Dead letters live in state `created`, so subtract them from pending
    // rather than filtering the whole query — one pass still answers both.
    const deadLettered = jobRows.reduce((total, row) => total + Number(row.deadLettered ?? 0), 0);

    return {
      pending: Math.max(job('created') - deadLettered, 0),
      active: job('active'),
      retry: job('retry'),
      completed: job('completed') + archived('completed'),
      failed: job('failed') + archived('failed'),
      cancelled: job('cancelled') + archived('cancelled'),
      deadLettered,
      scheduled: await this.scheduleRepository.count(),
    };
  }

  private jobHandlerGroupExpression(entityAlias: 'job' | 'archive'): string {
    const dataRef = `${entityAlias}.data`;
    const nameRef = `${entityAlias}.name`;

    return `CASE WHEN ${dataRef}->>'name' = 'smart.rotation.work' THEN CONCAT('smart.rotation.work · ', COALESCE(${dataRef}->>'workType', 'unknown')) ELSE COALESCE(${dataRef}->>'name', ${nameRef}) END`;
  }

  private async getArchiveDistribution(): Promise<JobDistributionDto[]> {
    const groupExpr = this.jobHandlerGroupExpression('archive');
    const rows = await this.archiveRepository
      .createQueryBuilder('archive')
      .select(groupExpr, 'jobName')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy(groupExpr)
      .orderBy('count', 'DESC')
      .limit(15)
      .getRawMany<{ jobName: string | null; count: number }>();

    return this.mapDistributionRows(rows);
  }

  /**
   * Live work by handler. Excludes the dead-letter queue — its rows are in state
   * `created`, so without the filter the chart of "what the appliance is working
   * on" is topped by jobs that already gave up.
   */
  private async getActiveDistribution(): Promise<JobDistributionDto[]> {
    const groupExpr = this.jobHandlerGroupExpression('job');
    const rows = await this.jobRepository
      .createQueryBuilder('job')
      .select(groupExpr, 'jobName')
      .addSelect('COUNT(*)::int', 'count')
      .where('job.state IN (:...states)', { states: ['created', 'active', 'retry'] })
      .andWhere('job.name != :deadLetter', { deadLetter: DEAD_LETTER_QUEUE })
      .groupBy(groupExpr)
      .orderBy('count', 'DESC')
      .limit(15)
      .getRawMany<{ jobName: string | null; count: number }>();

    return this.mapDistributionRows(rows);
  }

  /** Live work by queue. Excludes the dead-letter queue, for the reason above. */
  private async getQueueDistribution(): Promise<JobQueueDistributionDto[]> {
    const rows = await this.jobRepository
      .createQueryBuilder('job')
      .select('job.name', 'queue')
      .addSelect('COUNT(*)::int', 'count')
      .where('job.state IN (:...states)', { states: ['created', 'active', 'retry'] })
      .andWhere('job.name != :deadLetter', { deadLetter: DEAD_LETTER_QUEUE })
      .groupBy('job.name')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany<{ queue: string | null; count: number }>();

    return rows
      .map((row) => ({
        queue: row.queue ?? 'unknown',
        count: Number(row.count) || 0,
      }))
      .filter((item) => item.count > 0);
  }

  /** Live smart.rotation.work by workType. Excludes the dead-letter queue, for the reason above. */
  private async getSmartRotationDistribution(): Promise<SmartRotationWorkDistributionDto[]> {
    const rows = await this.jobRepository
      .createQueryBuilder('job')
      .select("COALESCE(job.data->>'workType', 'unknown')", 'workType')
      .addSelect('COUNT(*)::int', 'count')
      .where('job.state IN (:...states)', { states: ['created', 'active', 'retry'] })
      .andWhere("job.data->>'name' = :eventName", { eventName: 'smart.rotation.work' })
      .andWhere('job.name != :deadLetter', { deadLetter: DEAD_LETTER_QUEUE })
      .groupBy("COALESCE(job.data->>'workType', 'unknown')")
      .orderBy('count', 'DESC')
      .getRawMany<{ workType: string | null; count: number }>();

    return rows
      .map((row) => ({
        workType: row.workType ?? 'unknown',
        count: Number(row.count) || 0,
      }))
      .filter((item) => item.count > 0);
  }

  private mapDistributionRows(rows: Array<{ jobName: string | null; count: number }>): JobDistributionDto[] {
    return rows
      .map((row) => ({
        jobName: row.jobName ?? 'unknown',
        count: Number(row.count) || 0,
      }))
      .filter((item) => item.count > 0);
  }

  private toJobRecord(job: PgBossJobEntity | PgBossArchiveEntity): JobRecordDto {
    return {
      id: job.id,
      queue: job.name,
      state: job.state,
      priority: job.priority,
      retryLimit: job.retryLimit,
      retryCount: job.retryCount,
      retryDelay: job.retryDelay,
      retryBackoff: job.retryBackoff,
      createdOn: job.createdOn.toISOString(),
      startAfter: job.startAfter.toISOString(),
      startedOn: job.startedOn ? job.startedOn.toISOString() : undefined,
      completedOn: job.completedOn ? job.completedOn.toISOString() : undefined,
      deadLetter: job.deadLetter,
      policy: job.policy,
      ...this.projectPayload(job.data),
      failure: this.toFailure(job.output),
    };
  }

  /**
   * The non-sensitive shape of a job payload: what it is, not what it contains.
   * See {@link JobRecordDto} for why the payload itself does not leave here.
   */
  private projectPayload(
    data: Record<string, unknown> | null | undefined,
  ): Pick<JobRecordDto, 'event' | 'workType' | 'payloadBytes'> {
    if (!data || typeof data !== 'object') {
      return { event: null, workType: null, payloadBytes: 0 };
    }

    return {
      event: typeof data['name'] === 'string' ? data['name'] : null,
      workType: typeof data['workType'] === 'string' ? data['workType'] : null,
      payloadBytes: this.byteLength(data),
    };
  }

  /**
   * Lift a failure out of `output`.
   *
   * `output` is an untyped jsonb column: the worker writes
   * `{ message, stack, failedAt }` on failure, but deferred completions write
   * deliberate SUCCESS payloads there too, and those can carry user data. Only
   * the three known failure fields are copied out, and only when a message is
   * actually present — so a success payload projects to `null` rather than
   * leaking through this path.
   */
  private toFailure(output: Record<string, unknown> | null | undefined): JobFailureDto | null {
    if (!output || typeof output !== 'object') {
      return null;
    }

    const message = typeof output['message'] === 'string' ? output['message'].trim() : '';

    if (!message) {
      return null;
    }

    return {
      message,
      stack: typeof output['stack'] === 'string' ? output['stack'] : undefined,
      failedAt: typeof output['failedAt'] === 'string' ? output['failedAt'] : undefined,
    };
  }

  private byteLength(data: Record<string, unknown>): number {
    try {
      return Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8');
    } catch {
      // Circular or otherwise unserialisable — the size is not worth throwing a
      // 500 over on a monitoring endpoint.
      return 0;
    }
  }

  private toArchivedJobRecord(job: PgBossArchiveEntity): ArchivedJobRecordDto {
    return {
      ...this.toJobRecord(job),
      archivedOn: job.archivedOn.toISOString(),
    };
  }

  private toScheduleDto(schedule: PgBossScheduleEntity): JobScheduleDto {
    return {
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone,
      createdOn: schedule.createdOn.toISOString(),
      updatedOn: schedule.updatedOn.toISOString(),
      data: schedule.data ?? null,
      options: schedule.options ?? null,
    };
  }

  private toQueueDto(queue: PgBossQueueEntity): JobQueueDto {
    return {
      name: queue.name,
      policy: queue.policy,
      retryLimit: queue.retryLimit,
      retryDelay: queue.retryDelay,
      retryBackoff: queue.retryBackoff,
      expireInSeconds: queue.expireInSeconds,
      retentionMinutes: queue.retentionMinutes,
      deadLetter: queue.deadLetter,
      createdOn: queue.createdOn.toISOString(),
      updatedOn: queue.updatedOn ? queue.updatedOn.toISOString() : undefined,
    };
  }
}

/**
 * The slice of the `cron` library's `CronTime` this file uses.
 *
 * Kept structural even though `cron` is now a direct dependency (pinned to the
 * exact version `@nestjs/schedule` resolves, so there is one copy): the value
 * arrives two ways — the live instance the registry hands back on
 * `job.cronTime` for schedules this process runs, and one built by
 * {@link cronTimeFor} for schedules it does not — and the verdict logic must not
 * care which.
 */
interface CronTimeLike {
  readonly timeZone?: string | null;
  sendAt?: (count: number) => unknown;
  getNextDateFrom?: (start: Date, timeZone?: string) => unknown;
}

/**
 * A `CronTime` for a schedule this process did not register, built from its
 * declaration. `undefined` when `cron` rejects the expression: a bad expression
 * must not take the dashboard down, and `isOverdue` reads `undefined` as
 * "cannot say", which is the honest answer for it.
 */
function cronTimeFor(declaration: CronDeclaration): CronTimeLike | undefined {
  try {
    return new CronTime(declaration.cron, declaration.timeZone ?? undefined);
  } catch {
    return undefined;
  }
}

/** Below a minute, clock skew alone would flip the verdict. */
const MIN_OVERDUE_GRACE_MS = 60_000;

/** Above an hour, "overdue" stops being actionable — daily jobs are the cap case. */
const MAX_OVERDUE_GRACE_MS = 60 * 60_000;

/** A second of slack cannot change an overdue verdict; the grace is minutes at least. */
const OVERDUE_SEARCH_PRECISION_MS = 1_000;

/** How far the search may widen before giving up on finding any past fire time. */
const OVERDUE_LOOKBACK_DOUBLINGS = 6;

/**
 * Has this schedule missed the fire time its own expression asked for?
 *
 * `running` cannot answer that: the `@Cron` wrapper catches and returns, so a
 * schedule stays started whatever its body does, and a scheduler that stopped
 * ticking leaves no dead letters to notice either. The only ground truth is the
 * expression itself against the last recorded attempt.
 *
 * The grace is half a cadence, floored at a minute and capped at an hour, so a
 * two-minute job is late after three minutes and a daily job after an hour —
 * generous enough that a slow tick or a restart never cries wolf.
 */
function isOverdue(cronTime: CronTimeLike | undefined, lastRunAtMs: number | null, nowMs: number): boolean {
  if (!cronTime || lastRunAtMs == null || typeof cronTime.getNextDateFrom !== 'function') {
    return false;
  }

  const cadence = cadenceMs(cronTime);
  if (cadence == null) {
    return false;
  }

  const grace = Math.min(Math.max(cadence / 2, MIN_OVERDUE_GRACE_MS), MAX_OVERDUE_GRACE_MS);

  // The previous fire can never be later than now, so anything recorded within
  // the grace is healthy without evaluating the expression at all — which is
  // the case for all but a handful of the ~40 schedules on every poll.
  if (nowMs - lastRunAtMs <= grace) {
    return false;
  }

  const previousFire = previousExpectedFireAt(cronTime, nowMs, cadence);
  if (previousFire == null) {
    return false;
  }

  return previousFire - lastRunAtMs > grace;
}

/**
 * The gap between the next two fires — the schedule's own idea of how often it
 * should run, which is what both the grace and the search window scale from.
 */
function cadenceMs(cronTime: CronTimeLike): number | null {
  if (typeof cronTime.sendAt !== 'function') {
    return null;
  }

  let upcoming: unknown;
  try {
    upcoming = cronTime.sendAt(2);
  } catch {
    return null;
  }

  if (!Array.isArray(upcoming) || upcoming.length < 2) {
    return null;
  }

  const first = asMillis(upcoming[0]);
  const second = asMillis(upcoming[1]);

  return first != null && second != null && second > first ? second - first : null;
}

/**
 * The most recent fire time at or before `nowMs`.
 *
 * `CronTime` only walks forward, and stepping forward one fire at a time is
 * unbounded for a per-second schedule. `getNextDateFrom` is monotonic, though,
 * so bisecting on "does the next fire from here still land before now" reaches
 * the answer in a couple of dozen evaluations whatever the cadence — and it
 * stays correct for the irregular expressions (weekdays only, day-of-month)
 * where the cadence between the next two fires says nothing about the last one.
 */
function previousExpectedFireAt(cronTime: CronTimeLike, nowMs: number, cadence: number): number | null {
  let lo = nowMs - cadence * 2;

  for (let widened = 0; ; widened++) {
    const fire = nextFireAfter(cronTime, lo);
    if (fire == null) {
      return null;
    }

    if (fire <= nowMs) {
      break;
    }

    if (widened >= OVERDUE_LOOKBACK_DOUBLINGS) {
      return null;
    }

    lo = nowMs - (nowMs - lo) * 2;
  }

  let hi = nowMs;
  while (hi - lo > OVERDUE_SEARCH_PRECISION_MS) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const fire = nextFireAfter(cronTime, mid);
    if (fire == null) {
      return null;
    }

    if (fire <= nowMs) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return nextFireAfter(cronTime, lo);
}

function nextFireAfter(cronTime: CronTimeLike, atMs: number): number | null {
  if (typeof cronTime.getNextDateFrom !== 'function') {
    return null;
  }

  try {
    return asMillis(cronTime.getNextDateFrom(new Date(atMs), cronTime.timeZone ?? undefined));
  } catch {
    return null;
  }
}

/** Luxon `DateTime`s in practice, but a `Date` or an epoch reads the same here. */
function asMillis(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }

  const millis = (value as { toMillis?: () => unknown } | null)?.toMillis?.();

  return typeof millis === 'number' && Number.isFinite(millis) ? millis : null;
}

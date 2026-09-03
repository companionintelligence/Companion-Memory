import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  GLOBAL_CONCURRENCY,
  GLOBAL_NON_INTERACTIVE,
  GLOBAL_PER_QUEUE_CONCURRENCY,
  JobControlStore,
  MAX_CONCURRENCY,
  type CronMode,
  type JobControlKind,
  type JobMode,
} from '@ci/common/job-controls';
import { processRole, serves, type ProcessRole, type ServedRole } from '@ci/common/roles';
import { CronRegistry } from '@ci/common/schedule';
import config from '@ci/configuration';

import { JobSettingEntity } from '../entities/JobSettingEntity';
import {
  effectiveQueueConcurrency,
  maxQueueConcurrency,
  perProcessGlobalConcurrency,
  perQueueDefaultConcurrency,
  queueWorkerProcesses,
} from '../jobConcurrency';
import { protectedCronReason, protectedQueueReason } from '../jobControlPolicy';
import { queueInventory } from '../queueInventory';
import { describeJob, type JobRowCategory } from '../taxonomy';

/**
 * A number an operator can set, with everything the UI needs to render it
 * honestly: what they asked for, what happens if they ask for nothing, the
 * highest value that has any effect, and what the appliance is doing right now.
 *
 * `value` and `effective` differ more often than you would expect, because every
 * ceiling here is a MINIMUM of several constraints — ask for 8 on a queue whose
 * code declares 1 and the answer is 1. A control that echoed back what was typed
 * would be describing a machine that does not exist.
 */
export interface JobControlNumberDto {
  /** The operator's value, or null when they have expressed no opinion. */
  readonly value: number | null;
  /** What the appliance uses when `value` is null. */
  readonly default: number;
  /**
   * The largest value that changes anything. Above it, the request is clamped.
   *
   * On the two global fields this equals `default`, and that is the point: these
   * controls exist to cool a box down, so the shipped figure is both what you
   * get for free and the most you can ask for. More throughput than the build
   * ships with is a config change (`CI_QUEUE_CONCURRENCY`), not a text box on
   * the page you opened because the fans were loud.
   */
  readonly max: number;
  /** What the appliance is using right now. */
  readonly effective: number;
}

export interface JobQueueControlDto {
  readonly name: string;
  readonly mode: JobMode;
  /**
   * True when this queue is only quiet because of the global non-interactive
   * pause. Distinguished from a queue the operator paused by name so the UI can
   * say which switch to flip to bring it back.
   */
  readonly pausedByGlobal: boolean;
  /**
   * This queue's in-flight ceiling. `default` and `max` are equal here and that
   * is not an accident: a queue's default ceiling IS the highest one it can
   * usefully be given, because the only inputs are the global per-queue default
   * and the queue's own declared ceiling, and a setting can only lower.
   */
  readonly concurrency: JobControlNumberDto;
  /**
   * The queue's own `localConcurrency`, or null. Non-null and equal to
   * `concurrency.max` means the CODE is the binding constraint, which is the one
   * case where a number an operator types will visibly not take effect — so the
   * UI has to be able to say so.
   */
  readonly declaredConcurrency: number | null;
  readonly role: 'web' | 'worker';
  readonly interactive: boolean;
  readonly categories: readonly JobRowCategory[];
  /** What is actually on this queue, so "what am I switching off?" has an answer. */
  readonly jobTypes: ReadonlyArray<{
    readonly event: string;
    readonly label: string;
    readonly category: JobRowCategory;
    readonly description: string;
  }>;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly skippedCount: number;
  readonly lastSkippedAt: string | null;
}

export interface JobCronControlDto {
  /** Scheduler registry key — the same `Class.method` the Schedules card uses. */
  readonly name: string;
  readonly cron: string;
  readonly mode: CronMode;
  /** Which process runs it. Every schedule in the build is listed, both roles. */
  readonly role: ServedRole;
  /**
   * Whether the process answering this request is the one that runs it.
   *
   * False only under the web/worker split, and it does NOT mean uncontrollable:
   * the mode is a `ci.job_settings` row every process polls, so switching a
   * worker schedule off from the web process works. It means the row is here for
   * completeness rather than because this process would ever fire it — which the
   * card has to say, or a `false` row looks like a schedule that is not running.
   */
  readonly servedHere: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly skippedCount: number;
  readonly lastSkippedAt: string | null;
}

export interface JobControlsDto {
  readonly global: {
    /**
     * APPLIANCE-wide in-flight ceiling. `effective` is the appliance figure; the
     * per-process share the semaphores are actually sized to is in `topology`.
     */
    readonly concurrency: JobControlNumberDto;
    /** Default ceiling for any one queue. Not divided — one process serves each queue. */
    readonly perQueueConcurrency: JobControlNumberDto;
    /** `paused` stops the workers on every non-interactive queue. Nothing is dropped. */
    readonly nonInteractive: JobMode;
  };
  /**
   * What "appliance-wide" means on this deployment.
   *
   * The Hub caps the CONTAINER's CPU; these numbers cap the QUEUE. Both are
   * needed and neither substitutes for the other — see docs/operations/job-controls.md.
   */
  readonly topology: {
    readonly role: ProcessRole;
    readonly queueWorkerProcesses: number;
    /** The per-process semaphore size the appliance cap divides down to. */
    readonly perProcessConcurrency: number;
  };
  readonly queues: readonly JobQueueControlDto[];
  readonly crons: readonly JobCronControlDto[];
  /** Ceiling the API will accept for any concurrency field. */
  readonly maxConcurrency: number;
}

/** One field of the update request. Absent = leave alone; null = reset to the shipped default. */
export type ControlPatch<T> = T | null | undefined;

export interface UpdateJobControlsInput {
  readonly global?: {
    readonly concurrency?: ControlPatch<number>;
    readonly perQueueConcurrency?: ControlPatch<number>;
    readonly nonInteractive?: 'enabled' | 'paused';
  };
  readonly queues?: ReadonlyArray<{
    readonly name: string;
    readonly mode?: JobMode;
    readonly concurrency?: ControlPatch<number>;
  }>;
  readonly crons?: ReadonlyArray<{
    readonly name: string;
    readonly mode: CronMode;
  }>;
}

/**
 * Write one setting, touching only the fields the request actually named.
 *
 * The `$5`/`$6` flags are what make "reset this to the default" expressible.
 * Without them a null `mode` in the payload is indistinguishable from an absent
 * one, and a request that only changes a queue's concurrency would silently
 * un-pause it. `skipped_count` is never in the SET list, so the tally survives
 * every edit — including the edit that turns the queue back on, which is exactly
 * when an operator wants to know what being off cost them.
 */
const UPSERT_SETTING = `
  INSERT INTO ci.job_settings (kind, key, mode, concurrency, updated_at, updated_by)
  VALUES ($1, $2, $3, $4, now(), $7)
  ON CONFLICT (kind, key) DO UPDATE SET
    mode        = CASE WHEN $5 THEN EXCLUDED.mode ELSE job_settings.mode END,
    concurrency = CASE WHEN $6 THEN EXCLUDED.concurrency ELSE job_settings.concurrency END,
    updated_at  = now(),
    updated_by  = EXCLUDED.updated_by
`;

/**
 * The persisted operator controls: read them, validate a change, write it, and
 * make the appliance act on it before the response is sent.
 *
 * ── Why the response is the whole state, not an ack ────────────────────────
 *
 * Every number here is a MINIMUM of several things (see `jobConcurrency.ts`), so
 * what an operator asked for and what the appliance will do are routinely
 * different — ask for 8 on a queue that declares 1 and you get 1. Returning the
 * recomputed state means the page shows what actually happened rather than what
 * was typed, without a second round trip that could observe a half-applied
 * write.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * Appliance-wide. There is no user filter and there is no user column beyond
 * `updated_by`, which is provenance, not ownership: any signed-in user of this
 * Memory changes the settings for the box. That is the right model for a
 * single-household appliance and the wrong one for a shared server, and it is
 * called out here rather than left to be discovered.
 */
@Injectable()
export class JobControlsService {
  private readonly logger = new Logger(JobControlsService.name);

  constructor(
    @InjectRepository(JobSettingEntity)
    private readonly repository: Repository<JobSettingEntity>,
    /**
     * Optional for the same reason `JobMonitorService` takes it that way:
     * `ScheduleModule.forRoot()` is registered on the root module, so a module
     * compiled in isolation cannot resolve it. No scheduler in the process
     * honestly means no schedules to control.
     */
    @Optional() private readonly schedulerRegistry?: SchedulerRegistry,
  ) {}

  async get(): Promise<JobControlsDto> {
    // Read through the store rather than the repository so the page reports the
    // snapshot the WORKER is enforcing, not a fresher one the worker has not
    // picked up yet. If those two ever disagree, the honest thing to show is the
    // one that is deciding what runs.
    await JobControlStore.refresh();

    return this.snapshot();
  }

  /**
   * Apply a patch and return the resulting state.
   *
   * Validation is total before anything is written: a request naming one unknown
   * queue changes nothing at all rather than applying the half of it that
   * happened to be valid. A partially applied concurrency change is the kind of
   * thing an operator only finds out about when the box is already hot.
   */
  async update(input: UpdateJobControlsInput, userId: string | null): Promise<JobControlsDto> {
    const writes = this.plan(input);

    for (const write of writes) {
      await this.repository.query(UPSERT_SETTING, [
        write.kind,
        write.key,
        write.mode ?? null,
        write.concurrency ?? null,
        write.setsMode,
        write.setsConcurrency,
        userId,
      ]);
    }

    if (writes.length > 0) {
      this.logger.log(
        `Job controls updated by ${userId ?? 'an unidentified caller'}: ` +
          writes.map((write) => `${write.kind}/${write.key}`).join(', '),
      );
    }

    // Refresh before responding so THIS process is already enforcing the change
    // when the page redraws. Every other process converges on its own poll —
    // within five seconds, and the worker's own idle backoff is the same order,
    // so a paused queue stops fetching on its next wake either way.
    await JobControlStore.refresh();

    return this.snapshot();
  }

  /**
   * Turn a patch into the exact list of row writes, rejecting the whole request
   * if any part of it is not applicable.
   */
  private plan(input: UpdateJobControlsInput): PlannedWrite[] {
    const writes: PlannedWrite[] = [];

    if (input.global) {
      const { concurrency, perQueueConcurrency, nonInteractive } = input.global;

      if (concurrency !== undefined) {
        writes.push(numberWrite('global', GLOBAL_CONCURRENCY, this.checkConcurrency(concurrency)));
      }

      if (perQueueConcurrency !== undefined) {
        writes.push(
          numberWrite('global', GLOBAL_PER_QUEUE_CONCURRENCY, this.checkConcurrency(perQueueConcurrency)),
        );
      }

      if (nonInteractive !== undefined) {
        // `disabled` is refused for this key by design: a global switch that
        // DROPPED every non-interactive job would put a silent, appliance-wide
        // hole in the memory system, and the reason anyone reaches for this
        // control is heat, which pausing solves without losing anything.
        if (nonInteractive !== 'enabled' && nonInteractive !== 'paused') {
          throw new BadRequestException(
            'The global non-interactive switch accepts only "enabled" or "paused". Disabling every ' +
              'non-interactive job would drop the work rather than defer it; disable individual queues ' +
              'if that is what you mean.',
          );
        }

        writes.push(modeWrite('global', GLOBAL_NON_INTERACTIVE, nonInteractive));
      }
    }

    const known = new Map(queueInventory().map((entry) => [entry.queue, entry]));

    for (const queue of input.queues ?? []) {
      const entry = known.get(queue.name);

      if (!entry) {
        throw new BadRequestException(
          `Unknown queue "${queue.name}". Queues are discovered from the listeners registered in this ` +
            `build, so a name that is not among them cannot be controlled.`,
        );
      }

      const locked = protectedQueueReason(queue.name);

      if (locked && queue.mode !== undefined && queue.mode !== 'enabled') {
        throw new BadRequestException(`The "${queue.name}" queue cannot be switched off. ${locked}`);
      }

      if (queue.mode !== undefined) {
        writes.push(modeWrite('queue', queue.name, this.checkQueueMode(queue.mode)));
      }

      if (queue.concurrency !== undefined) {
        writes.push(numberWrite('queue', queue.name, this.checkConcurrency(queue.concurrency)));
      }
    }

    const cronNames = this.cronDeclarations();

    for (const cron of input.crons ?? []) {
      if (!cronNames.has(cron.name)) {
        throw new BadRequestException(
          `Unknown schedule "${cron.name}". Schedules are every @Cron declared in this build, both roles, ` +
            `so a name that is not among them is not one this appliance has.`,
        );
      }

      if (cron.mode !== 'enabled' && cron.mode !== 'disabled') {
        throw new BadRequestException(
          `A schedule is either "enabled" or "disabled" — a tick that is not taken is simply not taken, ` +
            `so "paused" has no meaning for "${cron.name}".`,
        );
      }

      const locked = protectedCronReason(cron.name);

      if (locked && cron.mode === 'disabled') {
        throw new BadRequestException(`The "${cron.name}" schedule cannot be switched off. ${locked}`);
      }

      writes.push(modeWrite('cron', cron.name, cron.mode));
    }

    return writes;
  }

  private checkConcurrency(value: number | null): number | null {
    if (value === null) {
      return null;
    }

    if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
      throw new BadRequestException(
        `Concurrency must be a whole number between 1 and ${MAX_CONCURRENCY}. There is deliberately no ` +
          `spelling for "unlimited", and 0 is a disable expressed as a number — use the mode for that.`,
      );
    }

    return value;
  }

  private checkQueueMode(mode: JobMode): JobMode {
    if (mode !== 'enabled' && mode !== 'paused' && mode !== 'disabled') {
      throw new BadRequestException(`Unknown queue mode "${String(mode)}".`);
    }

    return mode;
  }

  /**
   * Every schedule in the BUILD, not every schedule in this process.
   *
   * The scheduler registry holds only what this process registered, and the
   * `@Cron` wrapper deliberately does not register a schedule whose `role` this
   * process does not serve. Under the Procfile's split that is eleven schedules
   * — the derivation pass, the orphan sweep, the import retention purge —
   * invisible to the API, which then offered its list under a plain count as if
   * it were the total. An operator looking for one of them found no row and no
   * hint that a row was missing.
   *
   * So the declarations come first, and the scheduler is consulted only to pick
   * up anything registered without going through the decorator (nothing does
   * today; a `SchedulerRegistry.addCronJob` call would). Those are known to be
   * served here by definition, and their role is whichever this process serves.
   */
  private cronDeclarations(): Map<string, CronFacts> {
    const declarations = new Map<string, CronFacts>();

    for (const declaration of CronRegistry.all()) {
      declarations.set(declaration.name, {
        cron: declaration.cron,
        role: declaration.role,
        servedHere: declaration.servedHere,
      });
    }

    if (!this.schedulerRegistry) {
      return declarations;
    }

    for (const [name, job] of this.schedulerRegistry.getCronJobs()) {
      if (declarations.has(name)) {
        continue;
      }

      declarations.set(name, {
        cron: String(job.cronTime?.source ?? ''),
        role: serves('web') ? 'web' : 'worker',
        servedHere: true,
      });
    }

    return declarations;
  }

  /** Build the whole reportable state from the store's current snapshot. */
  private snapshot(): JobControlsDto {
    const processes = queueWorkerProcesses();

    const globalSetting = JobControlStore.globalConcurrency();
    const perQueueSetting = JobControlStore.perQueueConcurrency();

    // The shipped appliance-wide figure is the per-process config value times
    // the number of processes — which is what the appliance actually allows
    // today, and is why leaving this unset changes nothing.
    const shippedAppliance = config.queues.concurrency * processes;
    const perQueueDefault = perQueueDefaultConcurrency(perQueueSetting, config.queues.perQueueConcurrency);

    const queues = queueInventory().map((entry): JobQueueControlDto => {
      const row = JobControlStore.row('queue', entry.queue);
      const ownMode = row?.mode ?? 'enabled';
      const mode = JobControlStore.queueMode(entry.queue, { interactive: entry.interactive });
      const requested = row?.concurrency ?? null;
      const ceiling = maxQueueConcurrency(perQueueDefault, entry.localConcurrency);
      const locked = protectedQueueReason(entry.queue);

      return {
        name: entry.queue,
        mode,
        pausedByGlobal: ownMode === 'enabled' && mode === 'paused',
        concurrency: {
          value: requested,
          default: ceiling,
          max: ceiling,
          effective: effectiveQueueConcurrency({
            perQueueDefault,
            requested,
            declared: entry.localConcurrency,
          }),
        },
        declaredConcurrency: entry.localConcurrency,
        role: entry.role,
        interactive: entry.interactive,
        categories: entry.categories,
        jobTypes: entry.events.map((event) => {
          const descriptor = describeJob(event, null, entry.queue);

          return {
            event,
            label: descriptor.label,
            category: descriptor.category,
            description: descriptor.description,
          };
        }),
        locked: locked != null,
        lockedReason: locked,
        skippedCount: row?.skippedCount ?? 0,
        lastSkippedAt: row?.lastSkippedAt?.toISOString() ?? null,
      };
    });

    const crons = [...this.cronDeclarations().entries()]
      .map(([name, facts]): JobCronControlDto => {
        const row = JobControlStore.row('cron', name);
        const locked = protectedCronReason(name);

        return {
          name,
          cron: facts.cron,
          mode: JobControlStore.cronMode(name),
          role: facts.role,
          servedHere: facts.servedHere,
          locked: locked != null,
          lockedReason: locked,
          skippedCount: row?.skippedCount ?? 0,
          lastSkippedAt: row?.lastSkippedAt?.toISOString() ?? null,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const perProcessConcurrency = perProcessGlobalConcurrency(
      globalSetting,
      config.queues.concurrency,
      processes,
    );

    return {
      global: {
        concurrency: {
          value: globalSetting,
          default: shippedAppliance,
          // The shipped figure, NOT `MAX_CONCURRENCY`. This used to report 64
          // against a shipped 10, so the page invited an operator to take the
          // appliance six times past what the build allows — on the one page
          // whose reason for existing is that an unattended appliance already
          // pegs the machine.
          max: shippedAppliance,
          // The appliance figure, i.e. the per-process share multiplied back
          // out. On a split deployment a cap of 1 reports 2, because a process
          // with zero worker slots is a stopped process — the one place the
          // division rounds up, stated rather than hidden.
          effective: perProcessConcurrency * processes,
        },
        perQueueConcurrency: {
          value: perQueueSetting,
          default: config.queues.perQueueConcurrency,
          max: config.queues.perQueueConcurrency,
          effective: perQueueDefault,
        },
        nonInteractive: JobControlStore.nonInteractivePaused() ? 'paused' : 'enabled',
      },
      topology: {
        role: processRole(),
        queueWorkerProcesses: processes,
        perProcessConcurrency,
      },
      queues,
      crons,
      maxConcurrency: MAX_CONCURRENCY,
    };
  }
}

/** What the settings API needs about a schedule, from wherever it learned of it. */
interface CronFacts {
  readonly cron: string;
  readonly role: ServedRole;
  readonly servedHere: boolean;
}

interface PlannedWrite {
  readonly kind: JobControlKind;
  readonly key: string;
  readonly mode: JobMode | null;
  readonly concurrency: number | null;
  readonly setsMode: boolean;
  readonly setsConcurrency: boolean;
}

function modeWrite(kind: JobControlKind, key: string, mode: JobMode): PlannedWrite {
  return { kind, key, mode, concurrency: null, setsMode: true, setsConcurrency: false };
}

function numberWrite(kind: JobControlKind, key: string, concurrency: number | null): PlannedWrite {
  return { kind, key, mode: null, concurrency, setsMode: false, setsConcurrency: true };
}

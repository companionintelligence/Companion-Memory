import { Logger } from '@nestjs/common';
import { Cron as NestCron, type CronOptions } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';

import { ContextService } from '@ci/common/context';
import { JobControlStore } from '@ci/common/job-controls';
import { serves, type ServedRole } from '@ci/common/roles';

import { CronRegistry } from '../CronRegistry';
import { CronRunStore } from '../CronRunStore';

/**
 * Diagnosability, not containment.
 *
 * `@nestjs/schedule` already stops a rejecting tick from taking the process
 * down: `SchedulerRegistry.addCronJob` wraps `fireOnTick` in
 * `wrapFunctionInTryCatchBlocks`, which awaits the method and logs whatever it
 * throws. What that wrapper does NOT do is say which job failed — it calls
 * `this.logger.error(error)` with a `SchedulerRegistry` context and nothing
 * else, so a stack trace from a cron body arrives with no schedule name and no
 * correlation to the traceId this decorator just minted.
 *
 * With ~34 scheduled methods across the appliance, "something in the scheduler
 * threw" is not a diagnosis. Catching here — one layer inside Nest's own catch,
 * where the class, the method and the traceId are all in scope — turns it into
 * one. The rethrow-free return matches the framework's existing behaviour: the
 * tick is lost, the schedule keeps running.
 *
 * Each tick also stamps `ci.cron_runs` so the Jobs dashboard's "Last run"
 * survives API restarts. The registry name (explicit `name:` option, else
 * `Class.method`) is the key — same string SchedulerRegistry and the dashboard
 * use. Two stamps, not one: the attempt lands before the body so a hung or
 * throwing tick still counts as fired, and the success lands after it returns.
 * A schedule that fails every tick is otherwise indistinguishable from a
 * healthy one on the dashboard.
 *
 * This wrapper is also the ONE place a recurring job can be turned off. All 53
 * scheduled methods on the appliance go through it, so gating here is the whole
 * of "the user disabled this schedule" — there is no second path to a `@Cron`
 * body, and the raw `@nestjs/schedule` import that would bypass it is an eslint
 * error everywhere but this file's own directory.
 *
 * Being the one path is also why the overlap guard is available here. Most
 * schedules on the appliance sweep a table or drive a sidecar, and a second tick
 * starting on top of the first duplicates work at best; the bodies that noticed
 * had each grown their own boolean, advisory lock or pg-boss singleton key to
 * say so. `exclusive` gives that to the ones that never grew anything, and —
 * because this wrapper swallows errors — turns an overlap that was previously
 * invisible into a logged warning. It is OPT-IN rather than the default; see the
 * option's own note for why.
 */
const cronLogger = new Logger('Cron');

/**
 * Registry names whose tick is currently in flight.
 *
 * Per-process and in-memory by design. This guards the collision a schedule can
 * actually have here — the previous tick of the same schedule in the same
 * process — and nothing more. Cross-process exclusion belongs to pg-boss, whose
 * singleton keys already cover the jobs these bodies enqueue; a Postgres
 * advisory lock in this wrapper would put a round trip in front of all 53 ticks
 * to defend against a deployment shape the appliance does not have.
 */
const inFlight = new Set<string>();

export type CiCronOptions = CronOptions & {
  /**
   * Which process runs this cron. Defaults to `web` — the process a
   * single-role deployment always has — so only crons that explicitly belong
   * to the queue worker (the import purge, the resume sweep) move. When this
   * process does not serve the role, the method simply never registers with
   * the scheduler: same class, same code, silent in the other process.
   */
  role?: ServedRole;

  /**
   * Skip a tick while the previous tick of this same schedule is still running.
   *
   * Defaults to FALSE, and opting in is deliberate rather than timid. Most
   * schedules already refuse to overlap themselves — a `running` boolean
   * (AccountPurgeCron, ActivityRollupCron, AskExpiryCron, ConsumptionSweepCron,
   * PendingActionExpiryCron, DailyMetricsCron, SyncOrchestrator), a Postgres
   * advisory lock (PipelineTickCron), a claim on a config row
   * (BlueBubblesSyncCron), or a pg-boss `singletonKey` on everything the fan-out
   * bodies enqueue. Two guards for one question is worse than one:
   *
   *  - The body's guard reports better. `DailyMetricsCron` logs `runningForMs`
   *    and `consecutiveSkips`, which is what tells one slow run apart from a
   *    permanently wedged one; this wrapper can only ever log a fixed string,
   *    because the schedule's own state is not in scope here.
   *  - A guard here is not even correct for some of them. `DailyMetricsCron`'s
   *    `onApplicationBootstrap` calls the private `refresh()` directly, so the
   *    30-day boot backfill never passes through the decorator at all — only the
   *    body's flag can see the hourly tick landing on top of it.
   *  - The singleton-key bodies are re-entrant on purpose: pg-boss already
   *    refuses the duplicate job, and skipping the tick would drop the users the
   *    overlapping pass had not reached yet.
   *
   * So set it to `true` on a schedule that has NO guard of its own — an
   * unprotected sweep whose second tick would simply repeat the first.
   */
  exclusive?: boolean;
};

/**
 * Why firing `name` right now would not actually run it — the wrapper's own
 * early returns, asked ahead of time and in the same order it applies them.
 *
 * Exists for the Jobs page's "Run now": `fireOnTick()` invokes the wrapped body
 * but does not await it, so a caller that wants to report what happened has to
 * ask before firing rather than read a result afterwards. Keeping the question
 * here — rather than exporting `inFlight` and letting the caller re-implement
 * the order — is what stops the two from drifting apart the next time an early
 * return is added to the wrapper.
 *
 * A schedule left `exclusive: false` never enters `inFlight`, so the membership
 * test correctly answers "not skipped" for it.
 */
export function cronSkipReason(name: string): 'disabled' | 'in-flight' | null {
  if (JobControlStore.cronMode(name) === 'disabled') {
    return 'disabled';
  }

  if (inFlight.has(name)) {
    return 'in-flight';
  }

  return null;
}

export function Cron(expression: string, options?: CiCronOptions) {
  // `exclusive` is destructured out with `role`: neither is a Nest `CronOptions`
  // key, and what is left is what gets handed to `NestCron` unchanged.
  const { role = 'web', exclusive = false, ...cronOptions } = options ?? {};

  return function (target: object, propertyName: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    const label = `${(target as { constructor?: { name?: string } }).constructor?.name ?? 'Cron'}.${propertyName}`;
    const runName =
      typeof cronOptions.name === 'string' && cronOptions.name.length > 0 ? cronOptions.name : label;

    descriptor.value = async function (...args: unknown[]) {
      // The operator's switch, checked before anything else this tick would do.
      //
      // Ahead of the `ci.cron_runs` stamp on purpose: a disabled schedule did
      // NOT run, and recording a fire for it would leave the Jobs page showing a
      // healthy "last run" two minutes old for a job the appliance is
      // deliberately not doing. The dashboard reads the same setting and renders
      // the row as disabled instead — which is the difference between a control
      // an operator can trust and a job that has quietly stopped.
      //
      // The lookup is a synchronous Map hit against a snapshot refreshed on a
      // timer, so it costs nothing per tick and cannot make a schedule fail by
      // being unable to reach the database. When the store has never been
      // configured — every unit test, any CLI script — it answers `enabled` and
      // this branch is dead code.
      if (JobControlStore.cronMode(runName) === 'disabled') {
        JobControlStore.recordSkip('cron', runName);

        return undefined;
      }

      // Ahead of the `ci.cron_runs` stamp for the same reason the disabled gate
      // is: a tick that skips here did not run, and stamping it would credit the
      // still-running previous tick's work to this one.
      //
      // Warned rather than returned quietly, because exclusivity's own failure
      // mode is a body that never finishes — and a schedule that is silently
      // dead forever is indistinguishable from a schedule with nothing to do.
      // The `recordSkip` tally matches the disabled path, but only folds into
      // `ci.job_settings` when a row for this schedule already exists (its flush
      // is an UPDATE), so the log line is the signal that always survives.
      if (exclusive) {
        if (inFlight.has(runName)) {
          JobControlStore.recordSkip('cron', runName);
          cronLogger.warn(`Scheduled job ${runName} skipped — its previous tick is still running`);

          return undefined;
        }

        inFlight.add(runName);
      }

      const traceId = uuidv4();
      // Stamp before the body so a long or failing tick still counts as "ran"
      // — matching SchedulerRegistry lastDate() semantics.
      CronRunStore.record(runName);

      try {
        const result: unknown = await ContextService.run({ traceId }, () => originalMethod.apply(this, args));

        CronRunStore.recordSuccess(runName);

        return result;
      } catch (err: unknown) {
        // Swallowed on purpose — see the note on `cronLogger`. Nest would
        // otherwise catch this one frame further out and log it without saying
        // which schedule produced it.
        cronLogger.error(
          `Scheduled job ${runName} failed (traceId=${traceId})`,
          err instanceof Error ? err.stack : String(err),
        );

        return undefined;
      } finally {
        // Released here and nowhere else, so a throwing tick — or one that
        // rejects in a way the catch above does not shape — cannot wedge the
        // schedule off for the life of the process.
        if (exclusive) {
          inFlight.delete(runName);
        }
      }
    };

    // Declared before the role gate, so the record of what this BUILD schedules
    // is identical in the web and worker processes. The settings API reads it
    // instead of the scheduler registry, which by construction only ever knew
    // about the half of the schedules its own process runs — and presented that
    // half as the whole list.
    CronRegistry.declare({
      name: runName,
      cron: expression,
      // Nest types this `unknown`; only a string is a timezone `cron` can evaluate.
      timeZone: typeof cronOptions.timeZone === 'string' ? cronOptions.timeZone : null,
      role,
      servedHere: serves(role),
    });

    if (!serves(role)) {
      return descriptor;
    }

    return NestCron(expression, cronOptions)(target, propertyName, descriptor);
  };
}

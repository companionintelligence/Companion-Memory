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
 */
const cronLogger = new Logger('Cron');

export type CiCronOptions = CronOptions & {
  /**
   * Which process runs this cron. Defaults to `web` — the process a
   * single-role deployment always has — so only crons that explicitly belong
   * to the queue worker (the import purge, the resume sweep) move. When this
   * process does not serve the role, the method simply never registers with
   * the scheduler: same class, same code, silent in the other process.
   */
  role?: ServedRole;
};

export function Cron(expression: string, options?: CiCronOptions) {
  const { role = 'web', ...cronOptions } = options ?? {};

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

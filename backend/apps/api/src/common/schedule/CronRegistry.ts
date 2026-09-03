import type { ServedRole } from '@ci/common/roles';

/** One `@Cron` as it was DECLARED, whether or not this process runs it. */
export interface CronDeclaration {
  /**
   * The registry key: the explicit `name:` option, else `Class.method`. Same
   * string as the `ci.job_settings` row, the `ci.cron_runs` row, and the key
   * `SchedulerRegistry` uses for the ones it holds.
   */
  readonly name: string;
  /** The cron expression, as written at the declaration site. */
  readonly cron: string;
  /**
   * The `timeZone` option, if the declaration set one. Recorded so the
   * expression can be evaluated correctly in a process that never registered
   * the job — `overdue` for a worker schedule is computed from this plus
   * `ci.cron_runs`, and a daily 03:00 job is a different instant in each zone.
   */
  readonly timeZone: string | null;
  /** Which process runs it. `web` unless the declaration says otherwise. */
  readonly role: ServedRole;
  /** Whether THIS process registered it with Nest's scheduler. */
  readonly servedHere: boolean;
}

/**
 * Every `@Cron` in the build, including the ones this process does not run.
 *
 * ── Why the scheduler registry is not enough ───────────────────────────────
 *
 * `SchedulerRegistry` holds what a process actually registered, and the `@Cron`
 * wrapper deliberately does not register a schedule whose `role` this process
 * does not serve. Under the Procfile's split (`CI_ROLE=web` for the API,
 * `CI_ROLE=worker` beside it) that hides eleven schedules — the derivation pass,
 * the orphan sweep, the import retention purge — from the only process that
 * serves HTTP. The settings API asking the scheduler therefore produced a list
 * that silently ended at "the ones I happen to run", presented with a plain
 * count as though it were the total, so an operator looking for a worker cron to
 * switch off could neither find it nor tell that it existed.
 *
 * This registry is filled at class-definition time, one entry per declaration,
 * BEFORE the role gate — so it is identical in both processes and complete in
 * each. Which is also what makes the switch work across the split: the mode
 * lives in `ci.job_settings`, every process polls it, and the `@Cron` wrapper in
 * the worker consults it on each tick. The web process was never unable to
 * CONTROL a worker schedule; it was only unable to name one.
 *
 * ── What it deliberately does not hold ─────────────────────────────────────
 *
 * Anything live: next fire time, last fire time, a handle to fire it by hand.
 * Those exist only where the job is registered, which is why the dashboard's
 * Schedules card still reads the scheduler and still shows this process's own.
 * A declaration is a fact about the build; a next-run time is a fact about a
 * process, and conflating them is how you end up displaying a next-run time for
 * a schedule that is not running here.
 */
class CronRegistryImpl {
  private readonly declarations = new Map<string, CronDeclaration>();

  /**
   * Record one declaration. Called from the `@Cron` decorator at
   * class-definition time.
   *
   * Last writer wins, matching `SchedulerOrchestrator.addCron`, which assigns
   * into its map rather than checking for a clash: two crons sharing a name is
   * already one schedule silently replacing the other, and this must report the
   * one that won rather than inventing a disagreement of its own.
   */
  declare(declaration: CronDeclaration): void {
    this.declarations.set(declaration.name, declaration);
  }

  /** Every declaration in the build, in name order. */
  all(): CronDeclaration[] {
    return [...this.declarations.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): CronDeclaration | undefined {
    return this.declarations.get(name);
  }

  /** Tests only. Declarations are made once, at import time, in a real process. */
  clear(): void {
    this.declarations.clear();
  }
}

export const CronRegistry = new CronRegistryImpl();

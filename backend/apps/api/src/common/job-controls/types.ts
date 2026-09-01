/**
 * The vocabulary of `ci.job_settings`, in one place so the store, the service,
 * the controller and the worker cannot drift apart on what a row means.
 */

/** What a settings row steers. Closed set, matched by a CHECK on the table. */
export type JobControlKind = 'global' | 'queue' | 'cron';

/**
 * How much a queue is allowed to do.
 *
 * The distinction between the two off-states is the whole point of having three:
 *
 * - `paused` keeps enqueuing and stops working. The backlog grows, the box
 *   cools, and nothing is lost — this is what an operator wants when the fans
 *   are loud and they still expect the work to happen eventually.
 * - `disabled` also stops enqueuing, so new work is DROPPED. That is a real
 *   choice with a real cost (a note created while `search-index` is disabled is
 *   never indexed), which is why every surface that offers it says so and why
 *   the drops are counted rather than silent.
 */
export type JobMode = 'enabled' | 'paused' | 'disabled';

/** A cron either ticks or it does not; `paused` has no meaning for a schedule. */
export type CronMode = Extract<JobMode, 'enabled' | 'disabled'>;

/** One row of `ci.job_settings`, as the store holds it. */
export interface JobControlRow {
  readonly kind: JobControlKind;
  readonly key: string;
  /** NULL in the database — no opinion, inherit the shipped default. */
  readonly mode: JobMode | null;
  /** NULL in the database — no opinion, inherit the shipped default. */
  readonly concurrency: number | null;
  readonly skippedCount: number;
  readonly lastSkippedAt: Date | null;
  readonly updatedAt: Date | null;
}

/** `kind='global'` keys. The global row set is fixed, so these are constants. */
export const GLOBAL_CONCURRENCY = 'concurrency';
export const GLOBAL_PER_QUEUE_CONCURRENCY = 'per_queue_concurrency';
export const GLOBAL_NON_INTERACTIVE = 'non_interactive';

export const GLOBAL_KEYS = [
  GLOBAL_CONCURRENCY,
  GLOBAL_PER_QUEUE_CONCURRENCY,
  GLOBAL_NON_INTERACTIVE,
] as const;

export type GlobalControlKey = (typeof GLOBAL_KEYS)[number];

/**
 * Upper bound on any concurrency an operator can request.
 *
 * Not a physical limit — a defence against a fat finger turning "6" into "600"
 * and the appliance opening six hundred database connections before anyone
 * notices. The pg-boss client itself runs a pool of 10.
 */
export const MAX_CONCURRENCY = 64;

/**
 * The `ci.tasks.status` vocabulary, and the named subsets every caller filters by.
 *
 * The reason this module exists rather than a bare `TASK_STATUSES` array: #2558
 * added `delegated` to the array, the entity, the GraphQL enum and the web
 * client, and to nothing that FILTERS on status. Two call sites kept asking for
 * `['open', 'in_progress']` and a delegated task went invisible to both — it
 * vanished from the chat Plan snapshot and from the automation that reviews
 * open work against memory. Nothing failed; the task simply stopped existing
 * for those paths.
 *
 * A hardcoded list cannot be told that the vocabulary grew. A named subset can:
 * `__tests__/taskStatus.test.ts` asserts that PROPOSED ∪ ACTIVE ∪ CLOSED is
 * exactly TASK_STATUSES, with no overlap, so the next status added here fails
 * that test on the day it is added and has to be classified before it lands.
 * Everything narrower than those three is DERIVED from them rather than
 * written out again, so it widens on its own.
 *
 * Pure data: no typeorm, no Nest, importable from the engine helpers and from a
 * test without standing anything up.
 */

export const TASK_STATUSES = [
  'proposed',
  'open',
  'in_progress',
  'delegated',
  'done',
  'skipped',
  'archived',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * The trust-dial review inbox: automation surfaced the item but did not add it.
 * Accept promotes to `open`; decline archives.
 */
export const PROPOSED_TASK_STATUSES: readonly TaskStatus[] = ['proposed'];

/**
 * Accepted work that still wants doing — what "my open to-dos" means.
 *
 * `delegated` belongs here and is the whole point of the module: a task handed
 * to an agent harness is in flight, not finished. It is still the user's work,
 * it still has a deadline, and it still has to appear anywhere live work
 * appears. Only `AgentDispatchService.finishCompleted` retires it.
 */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'delegated'];

/** Over, however it ended — done, declined, or retired. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'skipped', 'archived'];

/** Everything that is not yet over: the review inbox plus live work. */
export const LIVE_TASK_STATUSES: readonly TaskStatus[] = [...PROPOSED_TASK_STATUSES, ...ACTIVE_TASK_STATUSES];

/**
 * Live work the planner may put a calendar block against.
 *
 * `delegated` is deliberately excluded, and derived-minus-one rather than
 * listed so a future active status is schedulable by default: booking an hour
 * for work an agent already has is telling the user to do it twice. The Plan
 * card makes the same call — `PlanPage/Task.tsx` hides Schedule and Reschedule
 * on a delegated task — and these two must not disagree.
 */
export const SCHEDULABLE_TASK_STATUSES: readonly TaskStatus[] = ACTIVE_TASK_STATUSES.filter(
  (status) => status !== 'delegated',
);

/**
 * Statuses whose title a scan should match against before minting a new card.
 *
 * Live work and completed work both mean "this job is already known", so the
 * scan appends to the existing row instead of spawning a duplicate. Declined
 * (`skipped`) and retired (`archived`) rows deliberately do NOT block a fresh
 * card: the user said no to that one, which is not a reason to refuse the work
 * ever being proposed again.
 */
export const TITLE_MATCH_TASK_STATUSES: readonly TaskStatus[] = [...LIVE_TASK_STATUSES, 'done'];

export function isActiveTaskStatus(status: string): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}

export function isClosedTaskStatus(status: string): boolean {
  return (CLOSED_TASK_STATUSES as readonly string[]).includes(status);
}

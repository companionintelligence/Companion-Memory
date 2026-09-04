import {
  ACTIVE_TASK_STATUSES,
  CLOSED_TASK_STATUSES,
  LIVE_TASK_STATUSES,
  PROPOSED_TASK_STATUSES,
  SCHEDULABLE_TASK_STATUSES,
  TASK_STATUSES,
  TITLE_MATCH_TASK_STATUSES,
  isActiveTaskStatus,
  isClosedTaskStatus,
} from '../taskStatus';

/**
 * The guard the `delegated` rollout did not have.
 *
 * #2558 widened `TASK_STATUSES` and left every FILTER on status alone, so a
 * delegated task disappeared from the chat Plan snapshot and from TodoProcess.
 * A subset assertion would not have caught that — `['open', 'in_progress']` is
 * a perfectly good subset of the vocabulary. What catches it is demanding that
 * the three subsets PARTITION the vocabulary: add a status and it belongs to
 * none of them, and this file goes red until somebody decides which.
 */
describe('task status vocabulary', () => {
  it('is partitioned by proposed / active / closed — every status is classified exactly once', () => {
    const classified = [...PROPOSED_TASK_STATUSES, ...ACTIVE_TASK_STATUSES, ...CLOSED_TASK_STATUSES];

    // Sorted, because the partition is about membership; the order inside each
    // subset is a readability choice and should not be able to fail this.
    expect([...classified].sort()).toEqual([...TASK_STATUSES].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('classifies delegated as active — the omission that shipped', () => {
    // Pinned by name as well as by the partition above: the partition would
    // stay green if a later edit moved `delegated` into CLOSED, and a delegated
    // task is in flight with an agent harness, not finished.
    expect(ACTIVE_TASK_STATUSES).toContain('delegated');
    expect(isActiveTaskStatus('delegated')).toBe(true);
    expect(isClosedTaskStatus('delegated')).toBe(false);
  });

  it('derives the narrower sets so they widen with the vocabulary', () => {
    // Each of these was a hand-written literal at a call site before this
    // module existed. Asserting the derivation is what makes "one exported
    // constant" true rather than aspirational.
    expect(LIVE_TASK_STATUSES).toEqual([...PROPOSED_TASK_STATUSES, ...ACTIVE_TASK_STATUSES]);
    expect(TITLE_MATCH_TASK_STATUSES).toEqual([...LIVE_TASK_STATUSES, 'done']);
    expect(TITLE_MATCH_TASK_STATUSES).not.toContain('skipped');
    expect(TITLE_MATCH_TASK_STATUSES).not.toContain('archived');
  });

  it('keeps the planner off delegated work without hardcoding what it may place', () => {
    // The one deliberate exclusion in the module, asserted as an exclusion:
    // schedulable is active-minus-delegated, so a future active status is
    // schedulable by default and only `delegated` had to argue its way out.
    expect(SCHEDULABLE_TASK_STATUSES).not.toContain('delegated');
    expect([...SCHEDULABLE_TASK_STATUSES, 'delegated'].sort()).toEqual([...ACTIVE_TASK_STATUSES].sort());
  });
});

// The GraphQL enum is the fourth copy of this vocabulary and is pinned against
// it too — in `domains/graphql/types/__tests__/TaskType.test.ts`, because
// reaching into another domain's internals from here is a dependency-cruiser
// error and the assertion belongs beside the enum it guards.


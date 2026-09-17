import { TASK_STATUSES, type Task } from '@ci/domains/planning';

import { TaskStatusEnum, TaskType } from '../TaskType';

const task = {
  id: '11111111-1111-1111-1111-111111111111',
  userId: 'owner-1',
  title: 'Dentist appointment',
  description: null,
  notes: null,
  status: 'open',
  priority: 3,
  parentId: null,
  dueAt: null,
  taskTime: null,
  scheduledFor: '2026-08-29',
  deferUntil: null,
  deferCount: 0,
  estimatedMinutes: 30,
  actualMinutes: 0,
  completedAt: null,
  sourceKind: 'inbox',
  sourceRef: null,
  l0Class: null,
  l1ClusterId: null,
  metadata: {},
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  updatedAt: new Date('2026-08-29T00:00:00.000Z'),
} as unknown as Task;

describe('TaskType.toType', () => {
  it('leaves placedOnCalendar unset rather than hardcoding false', () => {
    // A hardcoded `false` here makes TaskResolver.placedOnCalendar's
    // `typeof parent.placedOnCalendar === 'boolean'` guard always short-circuit,
    // so its plannedBlockService.findActiveForTask fallback lookup can never run.
    const result = TaskType.toType(task);

    expect(result.placedOnCalendar).toBeUndefined();
    expect('placedOnCalendar' in result).toBe(false);
  });
});

describe('TaskStatusEnum', () => {
  it('mirrors TASK_STATUSES exactly', () => {
    // A hand-maintained second copy of the vocabulary: Nest needs a real enum
    // object to register a GraphQL enum, so it cannot be derived from the const
    // tuple in `domains/planning/taskStatus.ts`. #2558 remembered to update it
    // while forgetting every status FILTER; the next change might invert that,
    // and a missing member here makes the status unrepresentable in every
    // GraphQL response rather than merely unfiltered.
    expect(Object.values(TaskStatusEnum).sort()).toEqual([...TASK_STATUSES].sort());
  });
});

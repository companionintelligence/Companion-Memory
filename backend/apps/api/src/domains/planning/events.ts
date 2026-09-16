import { defineEvent } from '@ci/domains/events';

export const TaskCreatedEvent = 'task.created';
export const TaskUpdatedEvent = 'task.updated';
export const TaskRemovedEvent = 'task.deleted';

export const PlanningTodoScanEvent = 'planning.todo_scan';
export const PlanningTodoProcessEvent = 'planning.todo_process';
export const PlanningInboxScanEvent = 'planning.inbox_scan';
export const PlanningEventNowEvent = 'planning.event_now';
export const PlanningVerifyDoneEvent = 'planning.verify_done';
/** M5's sixth planning job — the reminder claim-and-deliver tick. See RemindersCron. */
export const PlanningFireRemindersEvent = 'planning.fire_reminders';

/**
 * `userId` rides on every task event because the consumers are out-of-domain and
 * cannot re-derive it. `TaskService.findById` is unconditionally tenant-scoped —
 * unlike NoteService/ReceiptService it has no SYSTEM_USER escape, and widening it
 * would weaken the tenancy guarantee its dedicated test pins
 * (services/__tests__/TaskService.tenancy.integration.test.ts). So a listener
 * holding only a taskId cannot load the row at all: it silently indexes nothing.
 *
 * Consumers must tolerate `userId` being absent on jobs already queued under the
 * previous payload shape — pg-boss is at-least-once and those rows outlive a
 * deploy. Skipping such a job is safe: the next write to that task re-fires.
 */
export type TaskCreatedPayload = {
  taskId: string;
  userId: string;
};

export type TaskUpdatedPayload = {
  taskId: string;
  userId: string;
};

export type TaskRemovedPayload = {
  taskId: string;
  userId: string;
};

/** Per-user planning job payload. Cron fan-out resolves a real userId first. */
export type PlanningUserJobPayload = {
  userId: string;
};

defineEvent<TaskCreatedPayload>(TaskCreatedEvent);
defineEvent<TaskUpdatedPayload>(TaskUpdatedEvent);
defineEvent<TaskRemovedPayload>(TaskRemovedEvent);
defineEvent<PlanningUserJobPayload>(PlanningTodoScanEvent);
defineEvent<PlanningUserJobPayload>(PlanningTodoProcessEvent);
defineEvent<PlanningUserJobPayload>(PlanningInboxScanEvent);
defineEvent<PlanningUserJobPayload>(PlanningEventNowEvent);
defineEvent<PlanningUserJobPayload>(PlanningVerifyDoneEvent);
defineEvent<PlanningUserJobPayload>(PlanningFireRemindersEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [TaskCreatedEvent]: TaskCreatedPayload;
    [TaskUpdatedEvent]: TaskUpdatedPayload;
    [TaskRemovedEvent]: TaskRemovedPayload;
    [PlanningTodoScanEvent]: PlanningUserJobPayload;
    [PlanningTodoProcessEvent]: PlanningUserJobPayload;
    [PlanningInboxScanEvent]: PlanningUserJobPayload;
    [PlanningEventNowEvent]: PlanningUserJobPayload;
    [PlanningVerifyDoneEvent]: PlanningUserJobPayload;
    [PlanningFireRemindersEvent]: PlanningUserJobPayload;
  }
}

import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new connectionSyncJob.
 *
 * @see {@link ConnectionSyncJobService.create} - The method that emits this event
 */
export const ConnectionSyncJobExecuteEvent = 'connectionSyncJob.execute';
export const ConnectionSyncJobTransformEvent = 'connectionSyncJob.transform';

/**
 * Event payload of the event {@link ConnectionSyncJobExecuteEvent}.
 *
 * @see {@link ConnectionSyncJobExecuteEvent} - The event this payload is associated with
 */
export type ConnectionSyncJobExecutePayload = {
  /** The identifier of the newly created connectionSyncJob */
  connectionSyncJobId: string;
};

/**
 * Event payload of the event {@link ConnectionSyncJobTransformEvent}.
 *
 * @see {@link ConnectionSyncJobTransformEvent} - The event this payload is associated with
 */
export type ConnectionSyncJobTransformPayload = {
  /** The identifier of the newly created connectionSyncJob */
  connectionSyncJobId: string;
};

defineEvent<ConnectionSyncJobExecutePayload>(ConnectionSyncJobExecuteEvent);
defineEvent<ConnectionSyncJobTransformPayload>(ConnectionSyncJobTransformEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ConnectionSyncJobExecuteEvent]: ConnectionSyncJobExecutePayload;
    [ConnectionSyncJobTransformEvent]: ConnectionSyncJobTransformPayload;
  }
}

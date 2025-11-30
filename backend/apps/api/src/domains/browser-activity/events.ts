import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new user.
 *
 * @see {@link UserService.create} - The method that emits this event
 */
export const BrowserActivityCreatedEvent = 'browseractivity.created';
export const BrowserActivityUpdatedEvent = 'browseractivity.updated';
export const BrowserActivityRemovedEvent = 'browseractivity.deleted';

/**
 * Event payload of the event {@link BrowserActivityCreatedEvent}.
 *
 * @see {@link BrowserActivityCreatedEvent} - The event this payload is associated with
 * @see {@link BrowserActivityService.create} - The method that emits this event payload
 */
export type BrowserActivityCreatedPayload = {
  /** The identifier of the newly created user */
  browserActivityId: string;
};

/**
 * Event payload of the event {@link BrowserActivityUpdatedEvent}.
 *
 * @see {@link BrowserActivityUpdatedEvent} - The event this payload is associated with
 * @see {@link BrowserActivityService.update} - The method that emits this event payload
 */
export type BrowserActivityUpdatedPayload = {
  /** The identifier of the newly created user */
  browserActivityId: string;
};

/**
 * Event payload of the event {@link BrowserActivityRemovedEvent}.
 *
 * @see {@link BrowserActivityRemovedEvent} - The event this payload is associated with
 * @see {@link BrowserActivityService.remove} - The method that emits this event payload
 */
export type BrowserActivityDeletedPayload = {
  /** The identifier of the newly created user */
  browserActivityId: string;
};

defineEvent<BrowserActivityCreatedPayload>(BrowserActivityCreatedEvent);
defineEvent<BrowserActivityUpdatedPayload>(BrowserActivityUpdatedEvent);
defineEvent<BrowserActivityDeletedPayload>(BrowserActivityRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [BrowserActivityCreatedEvent]: BrowserActivityCreatedPayload;
    [BrowserActivityUpdatedEvent]: BrowserActivityUpdatedPayload;
    [BrowserActivityRemovedEvent]: BrowserActivityDeletedPayload;
  }
}

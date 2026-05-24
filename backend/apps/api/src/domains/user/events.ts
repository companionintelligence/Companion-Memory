import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new user.
 *
 * @see {@link UserService.create} - The method that emits this event
 */
export const UserCreatedEvent = 'user.created';
export const UserUpdatedEvent = 'user.updated';
export const UserRemovedEvent = 'user.removed';

/**
 * Event payload of the event {@link UserCreatedEvent}.
 *
 * @see {@link UserCreatedEvent} - The event this payload is associated with
 * @see {@link UserService.create} - The method that emits this event payload
 */
export type UserCreatedPayload = {
  /** The identifier of the newly created user */
  userId: string;
};

/**
 * Event payload of the event {@link UserUpdatedEvent}.
 *
 * @see {@link UserUpdatedEvent} - The event this payload is associated with
 * @see {@link UserService.update} - The method that emits this event payload
 */

export type UserUpdatedPayload = {
  /** The identifier of the newly created user */
  userId: string;
};
/**
 * Event payload of the event {@link UserRemovedEvent}.
 *
 * @see {@link UserRemovedEvent} - The event this payload is associated with
 * @see {@link UserService.remove} - The method that emits this event payload
 */
export type UserRemovedPayload = {
  /** The identifier of the newly created user */
  userId: string;
};

defineEvent<UserCreatedPayload>(UserCreatedEvent);
defineEvent<UserUpdatedPayload>(UserUpdatedEvent);
defineEvent<UserRemovedPayload>(UserRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [UserCreatedEvent]: UserCreatedPayload;
    [UserUpdatedEvent]: UserUpdatedPayload;
    [UserRemovedEvent]: UserRemovedPayload;
  }
}

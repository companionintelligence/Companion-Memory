import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new position.
 *
 * @see {@link PositionService.create} - The method that emits this event
 */
export const PositionCreatedEvent = 'position.created';
export const PositionUpdatedEvent = 'position.updated';
export const PositionRemovedEvent = 'position.deleted';

/**
 * Event payload of the event {@link PositionCreatedEvent}.
 *
 * @see {@link PositionCreatedEvent} - The event this payload is associated with
 * @see {@link PositionService.create} - The method that emits this event payload
 */
export type PositionCreatedPayload = {
  /** The identifier of the newly created position */
  positionId: string;
};

/**
 * Event payload of the event {@link PositionUpdatedEvent}.
 *
 * @see {@link PositionUpdatedEvent} - The event this payload is associated with
 * @see {@link PositionService.update} - The method that emits this event payload
 */
export type PositionUpdatedPayload = {
  /** The identifier of the newly created position */
  positionId: string;
};

/**
 * Event payload of the event {@link PositionRemovedEvent}.
 *
 * @see {@link PositionRemovedEvent} - The event this payload is associated with
 * @see {@link PositionService.remove} - The method that emits this event payload
 */
export type PositionDeletedPayload = {
  /** The identifier of the newly created position */
  positionId: string;
};

defineEvent<PositionCreatedPayload>(PositionCreatedEvent);
defineEvent<PositionUpdatedPayload>(PositionUpdatedEvent);
defineEvent<PositionDeletedPayload>(PositionRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [PositionCreatedEvent]: PositionCreatedPayload;
    [PositionUpdatedEvent]: PositionUpdatedPayload;
    [PositionRemovedEvent]: PositionDeletedPayload;
  }
}

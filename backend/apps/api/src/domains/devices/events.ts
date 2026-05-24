import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new user.
 *
 * @see {@link UserService.create} - The method that emits this event
 */
export const DeviceCreatedEvent = 'device.created';
export const DeviceUpdatedEvent = 'device.updated';
export const DeviceRemovedEvent = 'device.deleted';

/**
 * Event payload of the event {@link DeviceCreatedEvent}.
 *
 * @see {@link DeviceCreatedEvent} - The event this payload is associated with
 * @see {@link DeviceService.create} - The method that emits this event payload
 */
export type DeviceCreatedPayload = {
  /** The identifier of the newly created user */
  deviceId: string;
};

/**
 * Event payload of the event {@link DeviceUpdatedEvent}.
 *
 * @see {@link DeviceUpdatedEvent} - The event this payload is associated with
 * @see {@link DeviceService.update} - The method that emits this event payload
 */
export type DeviceUpdatedPayload = {
  /** The identifier of the newly created user */
  deviceId: string;
};

/**
 * Event payload of the event {@link DeviceRemovedEvent}.
 *
 * @see {@link DeviceRemovedEvent} - The event this payload is associated with
 * @see {@link DeviceService.remove} - The method that emits this event payload
 */
export type DeviceDeletedPayload = {
  /** The identifier of the newly created user */
  deviceId: string;
};

defineEvent<DeviceCreatedPayload>(DeviceCreatedEvent);
defineEvent<DeviceUpdatedPayload>(DeviceUpdatedEvent);
defineEvent<DeviceDeletedPayload>(DeviceRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [DeviceCreatedEvent]: DeviceCreatedPayload;
    [DeviceUpdatedEvent]: DeviceUpdatedPayload;
    [DeviceRemovedEvent]: DeviceDeletedPayload;
  }
}

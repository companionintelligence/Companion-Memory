/**
 * This interface is the single source of truth for all registered events. It
 * should be extended via declaration merging from different domain event files.
 *
 * @example
 *
 * import { defineEvent } from '@ci/domains/events';
 *
 * export const UserCreatedEvent = 'user.created';
 *
 * export type UserCreatedPayload = {
 *   userId: string;
 * };
 *
 * defineEvent<UserCreatedPayload>(UserCreatedEvent);

 * declare module '@ci/domains/events/registry' {
 *   interface EventRegistry {
 *     [UserCreatedEvent]: UserCreatedPayload;
 *   }
 * }
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type */
export interface EventRegistry {}

import { defineEvent } from '@ci/domains/events';

export const ThreadCreatedEvent = 'thread.created';
export const ThreadUpdatedEvent = 'thread.updated';
export const ThreadRemovedEvent = 'thread.deleted';

export type ThreadCreatedPayload = {
  threadId: string;
};

export type ThreadUpdatedPayload = {
  threadId: string;
};

export type ThreadRemovedPayload = {
  threadId: string;
};

export const MessageCreatedEvent = 'message.created';
export const MessageUpdatedEvent = 'message.updated';
export const MessageDeletedEvent = 'message.deleted';

export type MessageCreatedPayload = {
  messageId: string;
};

export type MessageUpdatedPayload = {
  messageId: string;
};

export type MessageDeletedPayload = {
  messageId: string;
};

defineEvent<ThreadCreatedPayload>(ThreadCreatedEvent);
defineEvent<ThreadUpdatedPayload>(ThreadUpdatedEvent);
defineEvent<ThreadRemovedPayload>(ThreadRemovedEvent);

defineEvent<MessageCreatedPayload>(MessageCreatedEvent);
defineEvent<MessageUpdatedPayload>(MessageUpdatedEvent);
defineEvent<MessageDeletedPayload>(MessageDeletedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ThreadCreatedEvent]: ThreadCreatedPayload;
    [ThreadUpdatedEvent]: ThreadUpdatedPayload;
    [ThreadRemovedEvent]: ThreadRemovedPayload;
    [MessageCreatedEvent]: MessageCreatedPayload;
    [MessageUpdatedEvent]: MessageUpdatedPayload;
    [MessageDeletedEvent]: MessageDeletedPayload;
  }
}

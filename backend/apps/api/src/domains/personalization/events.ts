import { defineEvent } from '@ci/domains/events';

export const ContextPromptPersistEvent = 'context.prompt.persist';
export const CONTEXT_PROMPT_PERSIST_QUEUE = 'context-prompt-persist';

export type ContextPromptPersistPayload = {
  userId: string;
  promptId: string;
};

defineEvent<ContextPromptPersistPayload>(ContextPromptPersistEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [ContextPromptPersistEvent]: ContextPromptPersistPayload;
  }
}

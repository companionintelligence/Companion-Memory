import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when a raw agent-memory fragment is written.
 *
 * @see {@link AgentMemoryService.create} - The method that emits this event
 */
export const AgentMemoryCreatedEvent = 'agent-memory.created';

/**
 * Payload of {@link AgentMemoryCreatedEvent}.
 *
 * Carries the fragment's raw text directly — fragments are immutable and
 * write-once, so the search-index listener can embed the content without a
 * round-trip back into the agent domain (avoids a search-ingress → agent
 * dependency).
 */
export type AgentMemoryCreatedPayload = {
  /** The identifier of the newly created memory fragment. */
  memoryId: string;
  /** Owner of the fragment. */
  userId: string;
  /** Raw fragment text, embedded for the recall message channel. */
  content: string;
};

defineEvent<AgentMemoryCreatedPayload>(AgentMemoryCreatedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [AgentMemoryCreatedEvent]: AgentMemoryCreatedPayload;
  }
}

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

/**
 * Event emitted when a raw agent-memory fragment is deleted.
 *
 * Mirrors {@link AgentMemoryCreatedEvent} so the search-index listener can
 * cascade-delete the fragment's 'message' embedding. Without this, deleting an
 * agent_memories row leaves an orphaned embedding in ci_search.embeddings (the
 * 'message' channel has no DB-level FK back to ci.agent_memories).
 *
 * @see {@link AgentMemoryService.remove} - The method that emits this event
 */
export const AgentMemoryRemovedEvent = 'agent-memory.deleted';

/**
 * Payload of {@link AgentMemoryRemovedEvent}.
 *
 * Carries only the identifiers needed to reap the embedding — unlike the
 * created payload there is no `content`, since deletion needs nothing to embed.
 */
export type AgentMemoryRemovedPayload = {
  /** The identifier of the deleted memory fragment. */
  memoryId: string;
  /** Owner of the fragment. */
  userId: string;
};

/**
 * One user's share of a chat-turn distillation tick.
 *
 * Sent by {@link TurnFragmentCron} (one job per user with recent completed
 * turns) and consumed by {@link TurnFragmentListener}. The fan-out exists so a
 * user whose scan throws retries on its own instead of ending the tick for
 * everyone behind them, and so the singleton key can refuse a second copy of
 * the same user+window while the first is still queued.
 *
 * @see {@link TurnFragmentCron.cronWriteTurnFragments} - The method that emits this event
 */
export const AgentTurnFragmentsEvent = 'agent-memory.turn-fragments';

/**
 * Payload of {@link AgentTurnFragmentsEvent}.
 *
 * Carries the user and the window boundaries the cron resolved, not just the
 * user: a job that sits in the queue for a retry cycle must distil the window
 * it was enqueued FOR, not the one that happens to be current when it runs.
 */
export type AgentTurnFragmentsPayload = {
  /** Owner whose turns this job distils. */
  userId: string;
  /** Inclusive lower bound on `ci.messages.updated_at`, ISO-8601. */
  since: string;
  /** Exclusive upper bound on `ci.messages.updated_at`, ISO-8601. */
  until: string;
};

export const AgentTaskDispatchEvent = 'agent.task.dispatch';
export const AgentTaskCheckpointEvent = 'agent.task.checkpoint';
export const AgentTaskCompletedEvent = 'agent.task.completed';
export const AgentTaskBlockedEvent = 'agent.task.blocked';
export const PlanningTaskResultEvent = 'planning.task_result';

export type AgentTaskDispatchPayload = {
  userId: string;
  jobId: string;
  threadId: string;
  taskId?: string | null;
};

export type AgentTaskCheckpointPayload = {
  userId: string;
  jobId: string;
  threadId: string;
  status: string;
};

export type AgentTaskCompletedPayload = {
  userId: string;
  jobId: string;
  threadId: string;
  taskId?: string | null;
};

export type AgentTaskBlockedPayload = {
  userId: string;
  jobId: string;
  threadId: string;
  taskId?: string | null;
  reason: string;
};

export type PlanningTaskResultPayload = {
  userId: string;
  jobId: string;
  taskId?: string | null;
  status: 'blocked' | 'completed' | 'failed';
  reason?: string;
};

defineEvent<AgentMemoryCreatedPayload>(AgentMemoryCreatedEvent);
defineEvent<AgentMemoryRemovedPayload>(AgentMemoryRemovedEvent);
defineEvent<AgentTurnFragmentsPayload>(AgentTurnFragmentsEvent);
defineEvent<AgentTaskDispatchPayload>(AgentTaskDispatchEvent);
defineEvent<AgentTaskCheckpointPayload>(AgentTaskCheckpointEvent);
defineEvent<AgentTaskCompletedPayload>(AgentTaskCompletedEvent);
defineEvent<AgentTaskBlockedPayload>(AgentTaskBlockedEvent);
defineEvent<PlanningTaskResultPayload>(PlanningTaskResultEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [AgentMemoryCreatedEvent]: AgentMemoryCreatedPayload;
    [AgentMemoryRemovedEvent]: AgentMemoryRemovedPayload;
    [AgentTurnFragmentsEvent]: AgentTurnFragmentsPayload;
    [AgentTaskDispatchEvent]: AgentTaskDispatchPayload;
    [AgentTaskCheckpointEvent]: AgentTaskCheckpointPayload;
    [AgentTaskCompletedEvent]: AgentTaskCompletedPayload;
    [AgentTaskBlockedEvent]: AgentTaskBlockedPayload;
    [PlanningTaskResultEvent]: PlanningTaskResultPayload;
  }
}

import { z } from 'zod/v3';

import type { ResolvedEntity } from '@ci/domains/entity-resolution';

import { AGENT_MEMORY_CATEGORIES } from './entities/AgentMemoryEntity';

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export const recallSchema = z.object({
  query: z.string().min(1).max(2000),
  maxResults: z.number().int().min(1).max(20).optional(),
});

export const turnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .min(1),
  sessionId: z.string().optional(),
  platform: z.string().max(100).optional(),
});

/**
 * A raw memory fragment written by the AI agent via the Hermes on_memory_write
 * hook.  Stored verbatim in ci.agent_memory for later LLM extraction into
 * structured graph entities.
 */
export const agentMemorySchema = z.object({
  content: z.string().min(1).max(10000),
  /** Optional short label. Defaults to "[source]" if source is provided. */
  title: z.string().max(500).optional(),
  /** Hermes target file: "memory" | "user", or any other source identifier. */
  source: z.string().max(50).optional(),
  /** Hermes session ID — passed through from the agent's active conversation. */
  sessionId: z.string().max(255).optional(),
  /** Optional governed atom category (`knowl` pattern). */
  category: z.enum(AGENT_MEMORY_CATEGORIES).optional(),
  /** Optional ID of a prior memory fragment that this write supersedes. */
  supersedesId: z.string().uuid().optional(),
});

export const memoryDriftSchema = z.object({
  changedPaths: z.array(z.string().min(1).max(1000)).min(1).max(500),
  markConflicted: z.boolean().optional(),
});

export type RecallDto = z.infer<typeof recallSchema>;
export type TurnDto = z.infer<typeof turnSchema>;
export type AgentMemoryDto = z.infer<typeof agentMemorySchema>;
export type MemoryDriftDto = z.infer<typeof memoryDriftSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface ContextResult {
  block: string;
}

/**
 * Who produced one line of recalled evidence.
 *
 * - `own`   — the OWNER of this archive wrote it or did it: a message they
 *             SENT, a place they went, a page they opened, a thing they bought,
 *             an event they attended, a node in their own graph.
 * - `other` — somebody else's words that arrived in the archive (an INBOUND
 *             message), or a line whose speaker cannot be established at all.
 *             Evidence about a conversation, not a statement about the owner.
 *
 * Unattributable lines are deliberately lumped in with `other` rather than given
 * a third value: the only decision downstream makes is "may this line carry a
 * first-person claim about the owner", and the answer for an unattributed line
 * is no.
 */
export type EvidenceVoice = 'own' | 'other';

/**
 * What kind of database row a recall line was rendered from.
 *
 * Every value except the last two is {@link ResolvedEntity}'s own discriminant,
 * so a caller holding a {@link RecallObjectRef} can hand `{ type, id }` straight
 * back to `EntityResolutionService.resolve` and get the row. The two exceptions
 * are the channels that never go through entity resolution:
 *
 * - `graph-node`    — a one-hop neighbour from `GraphExpansionService`. The id is
 *                     a `ci.entities.entity_id`.
 * - `agent-memory`  — a raw fragment from the naive-RAG message channel. The id
 *                     is a `ci.agent_memory.id`.
 */
export type RecallObjectType = ResolvedEntity['type'] | 'graph-node' | 'agent-memory';

/**
 * The database row one recall line was rendered from.
 *
 * Recall's whole output used to be prose: the id was known at serialization time
 * and thrown away one statement later, so a caller that put these lines in front
 * of a model as EVIDENCE could report WHAT it read but never WHICH ROW it read
 * it out of. That is the difference between a rationale the owner has to take on
 * faith and one they can click through to the message.
 *
 * `at` is the time of the RECORD, not of the import — a message's `time`, an
 * event's `startTime` — and is null for the types that have no such moment (a
 * person, a place, a concept). ISO-8601 so it survives a jsonb round trip.
 */
export interface RecallObjectRef {
  type: RecallObjectType;
  id: string;
  at: string | null;
}

export interface RecallLine {
  text: string;
  voice: EvidenceVoice;
  /**
   * Which row this line came out of. Required, not optional: every channel that
   * can push a line can name its source, and making it optional would let a new
   * channel quietly produce uncitable evidence.
   */
  ref: RecallObjectRef;
}

export interface RecallResult {
  block: string;
  resultCount: number;
  /**
   * The same lines the block is built from, each tagged with who produced it.
   *
   * Exists because `ci_search.vectors` carries no direction: the only place the
   * inbound/outbound distinction is knowable is here, after entity resolution,
   * and a caller that puts these lines in front of a model as EVIDENCE has to
   * be able to tell the owner's words from everyone else's.
   */
  lines: RecallLine[];
}

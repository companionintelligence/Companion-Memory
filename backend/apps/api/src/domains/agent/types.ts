import { z } from 'zod';

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
});

export type RecallDto = z.infer<typeof recallSchema>;
export type TurnDto = z.infer<typeof turnSchema>;
export type AgentMemoryDto = z.infer<typeof agentMemorySchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface ContextResult {
  block: string;
}

export interface RecallResult {
  block: string;
  resultCount: number;
}

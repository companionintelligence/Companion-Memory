/**
 * Data transfer objects for the agent-memory REST surface.
 *
 * Intentionally plain interfaces — no class-validator decorators — to match
 * the existing pattern used across this codebase (e.g. `ConsentService`,
 * `ExportService`). Input validation is handled at the NestJS pipe layer via
 * the global `ValidationPipe` if/when one is registered, or by the service
 * itself for safety-critical checks.
 */

export interface ContextMessageDto {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Body of `POST /v1/memory/context`.
 *
 * Matches the payload contract expected by the Hermes `sync_turn` hook and
 * the OpenClaw `agent_end` hook.
 */
export interface PostContextDto {
  /** Stable external session identifier provided by the agent. */
  session_id: string;
  /** Optional agent name or ID (e.g. "hermes", "openclaw"). */
  agent_id?: string;
  /** Zero-based turn counter within the session (optional). */
  turn_index?: number;
  /** Messages captured for this turn. */
  messages: ContextMessageDto[];
}

/**
 * Response from `POST /v1/memory/context`.
 *
 * MVP v1: `injection` is an empty string, `entitiesUsed` is empty.
 * MVP v2: `injection` is formatted for prepending to the agent's system
 *         prompt; `entitiesUsed` lists the entity IDs that were surfaced.
 */
export interface ContextResponse {
  /** Injection string to prepend to the system prompt. Empty in v1. */
  injection: string;
  /** Stable ID for this memory batch (for deduplication / future updates). */
  memoryId: string;
  /** Entity IDs surfaced during retrieval. Empty in v1. */
  entitiesUsed: string[];
}

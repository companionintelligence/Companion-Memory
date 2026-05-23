import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * A single context batch posted by an external agent (Hermes / OpenClaw).
 * Each row represents one call to `POST /v1/memory/context`.
 *
 * In MVP v1 these rows are purely a log. In v2 each row gains a `memory_id`
 * once the messages have been embedded and stored as a graph memory.
 */
@Entity({ schema: 'ci', name: 'agent_context_log' })
@Index('idx_agent_context_log_session_id', ['sessionId'])
@Index('idx_agent_context_log_user_id', ['userId'])
export class AgentContextLogEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** External session ID provided by the agent. */
  @Column({ type: 'text', name: 'session_id' })
  sessionId!: string;

  /** CI user ID resolved from the API key. */
  @Column({ type: 'text', name: 'user_id' })
  userId!: string;

  /** Optional agent identifier (e.g. "hermes", "openclaw", custom agent name). */
  @Column({ type: 'text', name: 'agent_id', nullable: true })
  agentId!: string | null;

  /** Zero-based turn counter within the session (optional, caller-supplied). */
  @Column({ type: 'integer', name: 'turn_index', nullable: true })
  turnIndex!: number | null;

  /** Raw messages captured for this turn. */
  @Column({ type: 'jsonb' })
  messages!: ContextMessage[];

  /** Set in v2 once the messages are ingested as a memory entity. */
  @Column({ type: 'text', name: 'memory_id', nullable: true })
  memoryId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

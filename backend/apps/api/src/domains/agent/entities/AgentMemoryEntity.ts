import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const AGENT_MEMORY_CATEGORIES = [
  'fact',
  'decision',
  'goal',
  'constraint',
  'architecture',
  'state',
  'preference',
  'observation',
] as const;

export type AgentMemoryCategory = (typeof AGENT_MEMORY_CATEGORIES)[number];

export const AGENT_MEMORY_STATUSES = ['active', 'superseded', 'conflicted'] as const;

export type AgentMemoryStatus = (typeof AGENT_MEMORY_STATUSES)[number];

@Entity({ schema: 'ci', name: 'agent_memories' })
export class AgentMemoryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Hermes session ID that produced this fragment. Null when unavailable. */
  @Column({ type: 'text', nullable: true, name: 'session_id' })
  sessionId!: string | null;

  /** on_memory_write target: "memory" | "user", or any other source identifier. */
  @Column({ type: 'text', nullable: true })
  source!: string | null;

  /** Optional short label, e.g. "[memory]" or a user-supplied title. */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text' })
  content!: string;

  /** Governed atom category (`knowl` pattern). Defaults to `'fact'`. */
  @Column({ type: 'text', default: 'fact' })
  category!: AgentMemoryCategory;

  /** Lifecycle status (`active`, `superseded`, `conflicted`). Defaults to `'active'`. */
  @Column({ type: 'text', default: 'active' })
  status!: AgentMemoryStatus;

  /** Points to the newer memory fragment that superseded this one. */
  @Column({ type: 'uuid', nullable: true, name: 'superseded_by_id' })
  supersededById!: string | null;

  /** Optional start of the memory's temporal validity window. */
  @Column({ type: 'timestamptz', nullable: true, name: 'valid_from' })
  validFrom!: Date | null;

  /** Optional end of the memory's temporal validity window (set on supersession). */
  @Column({ type: 'timestamptz', nullable: true, name: 'valid_until' })
  validUntil!: Date | null;

  /** Stamped by the compaction cron after LLM extraction. Null = unprocessed. */
  @Column({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: AgentMemoryEntity): AgentMemory {
    return { ...entity };
  }
}

export type AgentMemory = Readonly<AgentMemoryEntity>;

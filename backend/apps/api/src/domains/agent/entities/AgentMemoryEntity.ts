import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

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

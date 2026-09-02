import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const AGENT_JOB_STATUSES = ['queued', 'running', 'blocked', 'completed', 'failed'] as const;
export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

export const PACKET_MODES = ['details', 'intents', 'both'] as const;
export type PacketMode = (typeof PACKET_MODES)[number];

export type DispatchTurn = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  thought?: string;
};

export type DispatchPacket = {
  jobId: string;
  mode: PacketMode;
  turns: DispatchTurn[];
  source: {
    kind: string;
    id: string;
    title: string;
    body?: string | null;
  };
  taskId?: string | null;
  threadId: string;
};

@Entity({ schema: 'ci', name: 'agent_jobs' })
export class AgentJobEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'task_id', nullable: true })
  taskId!: string | null;

  @Column({ type: 'uuid', name: 'thread_id' })
  threadId!: string;

  @Column({ type: 'text', name: 'harness_id', default: 'openclaw' })
  harnessId!: 'openclaw';

  @Column({ type: 'text', name: 'packet_mode', default: 'both' })
  packetMode!: PacketMode;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  packet!: DispatchPacket;

  @Column({ type: 'text', default: 'queued' })
  status!: AgentJobStatus;

  @Column({ type: 'text', name: 'fail_step', nullable: true })
  failStep!: string | null;

  @Column({ type: 'int', name: 'fail_count', default: 0 })
  failCount!: number;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  /** pg-boss row for this dispatch — the Jobs page stays on this until OpenClaw finishes. */
  @Column({ type: 'uuid', name: 'event_job_id', nullable: true })
  eventJobId!: string | null;

  static toEgressType(entity: AgentJobEntity): AgentJob {
    return {
      id: entity.id,
      userId: entity.userId,
      taskId: entity.taskId,
      threadId: entity.threadId,
      harnessId: entity.harnessId,
      packetMode: entity.packetMode,
      packet: entity.packet,
      status: entity.status,
      failStep: entity.failStep,
      failCount: entity.failCount,
      result: entity.result,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      completedAt: entity.completedAt,
      eventJobId: entity.eventJobId,
    };
  }
}

export type AgentJob = Readonly<AgentJobEntity>;

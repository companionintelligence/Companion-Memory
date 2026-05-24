import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity({ schema: 'ci', name: 'communications' })
export class CommunicationEntity {
  @Column({ type: 'uuid' })
  id!: string;

  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ type: 'text', name: 'communication_type' })
  communicationType!: string;

  @Column({ type: 'uuid', nullable: true, name: 'device_id' })
  deviceId!: string | null;

  @Column({ type: 'text' })
  direction!: string;

  @Column({ type: 'text', nullable: true, name: 'thread_id' })
  threadId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'from_entity_id' })
  fromEntityId!: string | null;

  @Column('uuid', { array: true, nullable: true, name: 'to_entity_ids' })
  toEntityIds!: string[] | null;

  @Column({ type: 'jsonb', default: '{}', name: 'participants_metadata' })
  participantsMetadata!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  subject!: string | null;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'jsonb', default: '[]' })
  attachments!: unknown[];

  @Column({ type: 'integer', nullable: true, name: 'duration_seconds' })
  durationSeconds!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'sentiment_score' })
  sentimentScore!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'importance_score' })
  importanceScore!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'urgency_score' })
  urgencyScore!: number | null;

  @Column({ type: 'text', nullable: true })
  category!: string | null;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column('text', { array: true, nullable: true })
  tags!: string[] | null;

  @Column({ type: 'text', nullable: true, name: 'connection_id' })
  connectionId!: string | null;

  @Column({ type: 'boolean', default: false, name: 'is_encrypted' })
  isEncrypted!: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_archived' })
  isArchived!: boolean;

  @Column({ type: 'text', name: 'preview' })
  preview!: string | null;

  static toEgressType(entity: CommunicationEntity) {
    return {
      id: entity.id,
      time: entity.time,
      userId: entity.userId,
      communicationType: entity.communicationType,
      deviceId: entity.deviceId,
      direction: entity.direction,
      threadId: entity.threadId,
      fromEntityId: entity.fromEntityId,
      toEntityIds: entity.toEntityIds,
      participantsMetadata: entity.participantsMetadata,
      subject: entity.subject,
      content: entity.content,
      attachments: entity.attachments,
      durationSeconds: entity.durationSeconds,
      sentimentScore: entity.sentimentScore,
      importanceScore: entity.importanceScore,
      urgencyScore: entity.urgencyScore,
      category: entity.category,
      summary: entity.summary,
      tags: entity.tags,
      connectionId: entity.connectionId,
      isEncrypted: entity.isEncrypted,
      isArchived: entity.isArchived,
      preview: entity.preview,
    };
  }
}

export type Communication = Readonly<CommunicationEntity>;

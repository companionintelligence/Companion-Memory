import {
  Entity,
  Index,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { UserEntity, type User } from '@ci/domains/user';

import { EventEntity, Event } from './EventEntity';

@Entity({ schema: 'ci', name: 'content' })
// Idempotency key for captured/imported content. Created by migration
// 20260623120300_add_content_provenance; declared here so TypeORM is aware of it
// (schema sync stays off — the migration is the source of truth).
@Index('content_source_triple_uniq', ['userId', 'sourceType', 'sourceSystem', 'sourceId'], {
  unique: true,
  where: '"source_id" IS NOT NULL',
})
export class ContentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  type!: string;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  text!: string | null;

  @Column({ type: 'text', nullable: true })
  url!: string | null;

  @Column({ type: 'text', nullable: true })
  mimetype!: string | null;

  @Column({ type: 'text', nullable: true, name: 'external_id' })
  externalId!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_url' })
  sourceUrl!: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'source_data' })
  sourceData!: Record<string, unknown> | null;

  // Provenance triple for imported content (importer / capture sources). Added by
  // migration 20260623120300_add_content_provenance. Dedupe key for the batch
  // createContents mutation; also used to auto-link content to the event sharing
  // the same triple. Null for derived/manual rows.
  @Column({ type: 'text', nullable: true, name: 'source_type' })
  sourceType!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_system' })
  sourceSystem!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_id' })
  sourceId!: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  // Raw FK column backing the `user` relation above (same dual-mapping as
  // EventEntity.userId). The owner is written by ContentService.create setting
  // this scalar directly. It must stay insertable/updatable: when it was
  // insert:false the relation's FK write was shadowed and user_id was persisted
  // NULL on every insert, which silently broke every user_id-scoped read
  // (search-index listener, idempotency dedupe, content exports). Nullable
  // because the column maps to a nullable DB column.
  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId!: string | null;

  @ManyToOne(() => EventEntity, { nullable: true })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: ContentEntity) {
    return {
      id: entity.id,
      type: entity.type,
      title: entity.title || null,
      text: entity.text || null,
      url: entity.url || null,
      mimetype: entity.mimetype || null,
      externalId: entity.externalId || null,
      sourceUrl: entity.sourceUrl || null,
      sourceData: entity.sourceData || null,
      sourceType: entity.sourceType || null,
      sourceSystem: entity.sourceSystem || null,
      sourceId: entity.sourceId || null,
      userId: entity.userId ?? entity.user?.id ?? null,
      eventId: entity.event?.id || null,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      event: entity.event ? EventEntity.toEgressType(entity.event) : undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Content = Readonly<Omit<ContentEntity, 'user' | 'event' | 'tags'>> & {
  user?: User;
  event?: Event;
  tags?: string[];
};

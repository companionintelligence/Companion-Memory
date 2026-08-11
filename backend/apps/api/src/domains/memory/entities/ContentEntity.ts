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

  /**
   * CTI discriminator pin (migration 20260811200000): always 'Content'. Pairs
   * with id in the composite FK to ci.entities(entity_id, entity_type).
   * DEFAULTed and CHECKed in the schema; never written by the application.
   */
  @Column({ type: 'text', name: 'entity_type', default: 'Content', insert: false, update: false })
  entityType!: string;

  // title lives ONLY on the CTI base row (ci.entities.name, see ContentBaseEntity).

  @Column({ type: 'text', nullable: true })
  type!: string;

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

  @Column({ type: 'text', nullable: true, name: 'source_type' })
  sourceType!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_system' })
  sourceSystem!: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_id' })
  sourceId!: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId!: string | null;

  @ManyToOne(() => EventEntity, { nullable: true })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(
    entity: ContentEntity,
    base?: { name: string | null; description: string | null } | null,
  ): Content {
    return {
      id: entity.id,
      type: entity.type,
      title: base?.name ?? null,
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

export type Content = Readonly<Omit<ContentEntity, 'user' | 'event' | 'tags' | 'entityType'>> & {
  readonly title: string | null;
  user?: User;
  event?: Event;
  eventId?: string | null;
  tags?: string[];
};

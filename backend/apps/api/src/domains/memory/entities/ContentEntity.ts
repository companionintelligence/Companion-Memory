import {
  Entity,
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

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

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
      userId: entity.user?.id || null,
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

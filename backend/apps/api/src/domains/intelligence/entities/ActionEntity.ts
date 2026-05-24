import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToOne,
} from 'typeorm';

import { type Thread, ThreadEntity } from '@ci/domains/conversations';
import { type User, UserEntity } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'actions' })
export class ActionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  text!: string | null;

  @Column({ type: 'text', name: 'image_url', nullable: true })
  imageUrl!: string | null;

  @Column({ type: 'int', name: 'priority', nullable: true })
  priority!: number | null;

  @Column({ type: 'jsonb', name: 'metadata', default: '{}' })
  metadata!: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  seen!: boolean;

  @Column({ type: 'boolean', default: false })
  dismissed!: boolean;

  @Column({ type: 'text', name: 'thread_id', nullable: true })
  threadId!: string;

  @OneToOne(() => ThreadEntity, { nullable: true })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: ActionEntity): Action {
    return {
      id: entity.id,
      title: entity.title,
      text: entity.text,
      imageUrl: entity.imageUrl,
      priority: entity.priority,
      metadata: entity.metadata,
      seen: entity.seen ?? false,
      dismissed: entity.dismissed ?? false,
      threadId: entity.threadId,
      thread: entity.thread ? ThreadEntity.toEgressType(entity.thread) : undefined,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type Action = Readonly<Omit<ActionEntity, 'user' | 'thread' | 'tags'>> & {
  user?: User;
  thread?: Thread;
  tags?: string[];
};

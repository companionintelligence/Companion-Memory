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

@Entity({ schema: 'ci', name: 'threads' })
export class ThreadEntity {
  @PrimaryColumn({ type: 'uuid', name: 'thread_id' })
  id!: string;

  @Column({ type: 'text', nullable: true, name: 'title' })
  name!: string | null;

  @Column({ type: 'text', nullable: true, name: 'summary' })
  description!: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'boolean', default: false, name: 'is_archived' })
  isArchived!: boolean;

  static toEgressType(entity: ThreadEntity): Thread {
    return {
      id: entity.id,
      name: entity.name ?? null,
      description: entity.description ?? null,
      isArchived: entity.isArchived,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
    };
  }
}

export type Thread = Readonly<Omit<ThreadEntity, 'user'>> & {
  user?: User;
};

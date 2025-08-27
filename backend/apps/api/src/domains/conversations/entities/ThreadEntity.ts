import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinTable,
  JoinColumn,
  DeleteDateColumn,
} from 'typeorm';

import { FileEntity } from '@ci/domains/files';
import { UserEntity } from '@ci/domains/user';

import type { Thread } from '../types';

@Entity({ name: 'threads' })
export class ThreadEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deleted_at!: Date;

  @ManyToMany(() => FileEntity, { nullable: true })
  @JoinTable({
    name: 'thread_file',
    joinColumn: { name: 'thread_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'file_id', referencedColumnName: 'id' },
  })
  files?: FileEntity[];

  toThread() {
    return {
      id: this.id,
      name: this.name ?? null,
      model: this.model ?? null,
      description: this.description ?? null,
      files: this.files || [],

      user: this.user?.toUser(),
    } satisfies Thread;
  }
}

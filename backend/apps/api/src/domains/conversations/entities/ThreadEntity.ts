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

  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  model!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deleted_at?: Date;

  @ManyToMany(() => FileEntity, { nullable: true })
  @JoinTable({
    name: 'thread_file',
    joinColumn: { name: 'thread_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'file_id', referencedColumnName: 'id' },
  })
  files?: FileEntity[];

  toThread(): Thread {
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      description: this.description,
      files: this.files || [],

      user: this.user.toUser(),
    };
  }
}

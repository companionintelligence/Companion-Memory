import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import type { File } from '../types';

@Entity({ name: 'files' })
export class FileEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  bucket!: string;

  @Column({ type: 'uuid' })
  key!: string;

  @Column({ type: 'text' })
  original_name!: string;

  @Column({ type: 'text' })
  content_type!: string;

  @Column({ type: 'bigint' })
  size!: number;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  toFile(): File {
    return {
      id: this.id,
      name: this.original_name,
      key: this.key,
      contentType: this.content_type,
      size: this.size,
    };
  }
}

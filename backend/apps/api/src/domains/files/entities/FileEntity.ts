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
  @PrimaryColumn({ type: 'uuid', name: 'file_id' })
  id!: string;

  @Column({ type: 'text', name: 'file_path' })
  file_path!: string;

  @Column({ type: 'text', name: 'filename' })
  filename!: string;

  @Column({ type: 'text', name: 'storage_type' })
  storage_type!: string;

  @Column({ type: 'text', name: 'storage_provider', nullable: true })
  storage_provider!: string | null;

  @Column({ type: 'text', name: 'cloud_file_id', nullable: true })
  cloud_file_id!: string | null;

  @Column({ type: 'text', name: 'storage_account', nullable: true })
  storage_account!: string | null;

  @Column({ type: 'timestamptz', name: 'modified_at_source' })
  modified_at_source!: Date;

  @Column({ type: 'text', nullable: true })
  bucket!: string | null;

  @Column({ type: 'uuid', nullable: true })
  key!: string | null;

  @Column({ type: 'text', name: 'original_filename' })
  original_name!: string;

  @Column({ type: 'text', name: 'mime_type' })
  content_type!: string;

  @Column({ type: 'text', name: 'file_hash' })
  file_hash!: string | null;

  @Column({ type: 'bigint', name: 'file_size_bytes' })
  size!: number;

  @Column({ type: 'jsonb', name: 'document_metadata', nullable: true })
  document_metadata!: Record<string, unknown> | null;

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
      fileHash: this.file_hash || undefined,
      key: this.key,
      contentType: this.content_type,
      size: this.size,
    };
  }
}

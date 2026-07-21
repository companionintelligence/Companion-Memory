import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'file_chunks' })
export class FileChunkEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'file_id' })
  fileId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'integer', name: 'chunk_index' })
  chunkIndex!: number;

  @Column({ type: 'text', name: 'content' })
  content!: string;

  @Column({ type: 'text', name: 'section_title', nullable: true })
  sectionTitle!: string | null;

  @Column({ type: 'jsonb', name: 'source_locator', nullable: true })
  sourceLocator!: Record<string, unknown> | null;

  @Column({ type: 'text', name: 'parser_name' })
  parserName!: string;

  @Column({ type: 'text', name: 'parser_version' })
  parserVersion!: string;

  @Column({ type: 'text', name: 'chunker_version' })
  chunkerVersion!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

export type FileChunk = Readonly<FileChunkEntity>;

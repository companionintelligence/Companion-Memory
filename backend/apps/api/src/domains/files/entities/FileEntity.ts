import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, DeleteDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'files' })
export class FileEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', name: 'filename', nullable: true })
  filename!: string | null;

  @Column({ type: 'text', name: 'content_type' })
  contentType!: string;

  @Column({ type: 'bigint', nullable: true })
  size!: number | null;

  @Column({ type: 'integer', name: 'width', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', name: 'height', nullable: true })
  height!: number | null;

  @Column({ type: 'text' })
  variant!: string;

  @Column({ type: 'text', name: 'title', nullable: true })
  title!: string | null;

  @Column({ type: 'text', name: 'description', nullable: true })
  description!: string | null;

  @Column({ type: 'text', name: 'bucket', nullable: true })
  bucket!: string | null;

  @Column({ type: 'uuid', name: 'key', nullable: true })
  key!: string | null;

  @Column({ type: 'text', name: 'hash', nullable: true })
  hash!: string | null;

  @Column({ type: 'text', name: 'external_id', nullable: true })
  externalId!: string | null;

  @Column({ type: 'uuid', name: 'parent_id', nullable: true })
  parentId!: string | null;

  @Column({ type: 'text', name: 'user_id' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'text', name: 'external_created_at', nullable: true })
  externalCreatedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'external_updated_at', nullable: true })
  externalUpdatedAt!: Date | null;

  @Column({ type: 'text', name: 'parse_status', nullable: true })
  parseStatus!: string | null;

  @Column({ type: 'text', name: 'parse_error', nullable: true })
  parseError!: string | null;

  @Column({ type: 'timestamptz', name: 'parsed_at', nullable: true })
  parsedAt!: Date | null;

  @Column({ type: 'text', name: 'parser_name', nullable: true })
  parserName!: string | null;

  @Column({ type: 'text', name: 'parser_version', nullable: true })
  parserVersion!: string | null;

  @Column({ type: 'text', name: 'chunker_version', nullable: true })
  chunkerVersion!: string | null;

  static toEgressType(entity: FileEntity): File {
    return {
      id: entity.id,
      userId: entity.userId,
      parentId: entity.parentId,
      variant: entity.variant,
      filename: entity.filename,
      contentType: entity.contentType,
      size: entity.size,
      width: entity.width,
      height: entity.height,
      title: entity.title,
      description: entity.description,
      bucket: entity.bucket,
      key: entity.key,
      hash: entity.hash,
      externalId: entity.externalId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      deletedAt: entity.deletedAt,
      externalCreatedAt: entity.externalCreatedAt,
      externalUpdatedAt: entity.externalUpdatedAt,
      parseStatus: entity.parseStatus,
      parseError: entity.parseError,
      parsedAt: entity.parsedAt,
      parserName: entity.parserName,
      parserVersion: entity.parserVersion,
      chunkerVersion: entity.chunkerVersion,
    };
  }
}

export type File = Readonly<FileEntity>;
export type SignedFile = File & { readonly url: string | null };

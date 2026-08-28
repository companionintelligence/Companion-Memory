import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Mirrors `ci.unfurls` (migration `*_create_unfurls.sql`); the SQL is the source of truth. */
@Entity({ schema: 'ci', name: 'unfurls' })
export class UnfurlEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'resolve_key', type: 'text' })
  resolveKey!: string;

  @Column({ type: 'text' })
  resolver!: string;

  @Column({ type: 'text' })
  status!: string;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ name: 'author_name', type: 'text', nullable: true })
  authorName!: string | null;

  @Column({ name: 'author_url', type: 'text', nullable: true })
  authorUrl!: string | null;

  @Column({ name: 'site_name', type: 'text', nullable: true })
  siteName!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'canonical_url', type: 'text', nullable: true })
  canonicalUrl!: string | null;

  @Column({ name: 'thumbnail_url', type: 'text', nullable: true })
  thumbnailUrl!: string | null;

  @Column({ name: 'poster_file_id', type: 'uuid', nullable: true })
  posterFileId!: string | null;

  @Column({ name: 'duration_seconds', type: 'integer', nullable: true })
  durationSeconds!: number | null;

  @Column({ name: 'external_ref', type: 'text', nullable: true })
  externalRef!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @Column({ name: 'failure_count', type: 'integer', default: 0 })
  failureCount!: number;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

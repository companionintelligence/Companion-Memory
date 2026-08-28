import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Where the staged bytes came from. `upload` — staged into the importer's own
 * uploads directory the moment it arrived, registered immediately, TTL'd.
 * `inbox` — a file or directory the user placed in the inbox folder; it gets a
 * row only when a run claims it, because the folder itself is the pending
 * state.
 */
export type StagedSourceOrigin = 'upload' | 'inbox';

/**
 * Lifecycle of a staged source. `staged` — an upload awaiting its import
 * decision (TTL applies); `claimed` — bound to a run, bytes still at
 * `sourcePath`; `moved` — the unpack stage moved the bytes into the run's
 * scratch; `consumed` — the run completed and the bytes were reclaimed with
 * its scratch; `released` — an INBOX claim freed before the move (uploads
 * never take this state: releasing an upload re-stages it, or a stranded file
 * would outlive every sweep); `expired` — an upload's TTL passed and its file
 * was deleted, the row kept so the user sees "expired" rather than a bare 404.
 */
export type StagedSourceStatus = 'staged' | 'claimed' | 'moved' | 'consumed' | 'released' | 'expired';

export type StagedSourceKind = 'file' | 'directory';

/**
 * A local source an import run can consume. Mirrors the `staged_sources`
 * section of migration 20260810164304_create_ci_import_schema.
 *
 * Everything registered here is a COPY the importer owns. From `claimed` on,
 * both origins behave identically: the unpack stage MOVES `sourcePath` into
 * the run's scratch, and the bytes are deleted with the completed run. The
 * partial unique index on (user_id, source_path) WHERE status IN
 * ('claimed','moved') is the one-live-run-per-path race guard; UNIQUE
 * (user_id, drop_id) is the upload handle.
 *
 * Paths under CI_IMPORT_ROOTS never appear here: only staging-resolved paths
 * reach the code that inserts rows, and the mutation sites re-resolve
 * `sourcePath` against the staging roots before every move or delete.
 */
@Entity({ schema: 'ci_import', name: 'staged_sources' })
@Index('staged_sources_run_idx', ['runId'])
export class StagedSourceEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text' })
  origin!: StagedSourceOrigin;

  /** Sanitized public handle, uploads only. An inbox unit's handle is its path. */
  @Column({ type: 'text', name: 'drop_id', nullable: true })
  dropId!: string | null;

  /** Realpath of the staged bytes, inside a staging root at registration time. */
  @Column({ type: 'text', name: 'source_path' })
  sourcePath!: string;

  @Column({ type: 'text' })
  kind!: StagedSourceKind;

  @Column({ type: 'text', name: 'original_filename', nullable: true })
  originalFilename!: string | null;

  @Column({ type: 'text', name: 'content_type', nullable: true })
  contentType!: string | null;

  /**
   * Aggregate bytes for directories, file size for files. Advisory: feeds the
   * copy-fallback free-disk preflight, may lag the truth.
   */
  @Column({ type: 'bigint', name: 'size_bytes', nullable: true })
  sizeBytes!: number | null;

  @Column({ type: 'text', default: 'staged' })
  status!: StagedSourceStatus;

  /**
   * The run consuming this source, or NULL.
   *
   * `ON DELETE SET NULL` in the database, not CASCADE: deleting a run must not
   * silently orphan staged bytes by taking their registry row with it. Retiring
   * a run settles its rows in the same transaction rather than relying on that
   * — a claimed upload is re-staged, a claimed inbox claim is deleted — and
   * `StagedSourceService.purgeExpired` re-stages any claimed upload that lost
   * its run another way. See `ImportRetentionService.retireRun`.
   */
  @Column({ type: 'uuid', name: 'run_id', nullable: true })
  runId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  /** Uploads only: when the TTL purge may reclaim a still-staged upload. */
  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'claimed_at', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'consumed_at', nullable: true })
  consumedAt!: Date | null;
}

export type StagedSource = Readonly<StagedSourceEntity>;

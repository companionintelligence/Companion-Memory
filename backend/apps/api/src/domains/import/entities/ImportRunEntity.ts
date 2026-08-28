import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Which surface started a run. 'connections' is a background ETL sync tick
 * (CloudFileIngestService, via SyncOrchestrator's cron) rather than anything
 * a person typed, called, or POSTed — see migration
 * 20260821224653_add_connections_import_run_source for why that is its own
 * value and not folded into 'api'.
 */
export type ImportRunSource = 'wizard' | 'api' | 'mcp' | 'connections';

/**
 * Rollup state of a run.
 *
 * `partial` is a terminal SUCCESS-ish state, not a euphemism for failure: a
 * Google Takeout holding six sources where one parser choked still imported the
 * other five, and reporting that as `failed` is what teaches people to re-run
 * the whole 40GB archive.
 */
export type ImportRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';

/**
 * One user-initiated import. Mirrors migration
 * 20260810164304_create_ci_import_schema.
 *
 * This is the USER-facing progress surface — "your Google Takeout is 60%
 * imported", in a stage vocabulary that means something to the person who
 * uploaded the file. pg-boss still holds the work, and `/jobs` still renders
 * pg-boss for an operator; the two are deliberately separate surfaces for
 * different audiences and must not be merged.
 *
 * Everything staged for a run — items, entities, edges — hangs off this row
 * with `ON DELETE CASCADE`. Deleting a run is therefore the complete cleanup
 * operation, and staging never outlives the import it belongs to.
 */
@Entity({ schema: 'ci_import', name: 'import_runs' })
@Index('import_runs_user_created_idx', ['userId', 'createdAt'])
export class ImportRunEntity {
  /**
   * `@PrimaryColumn`, not `@PrimaryGeneratedColumn('uuid')`: the id comes from
   * the column default `ci.gen_uuid_v7()` so rows sort by insertion time.
   * TypeORM's generated-uuid strategy would mint a v4 client-side and throw
   * that ordering away.
   */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Display label for the run list, typically the uploaded archive's filename. */
  @Column({ type: 'text', nullable: true })
  label!: string | null;

  @Column({ type: 'text', default: 'wizard' })
  source!: ImportRunSource;

  /**
   * The services this run turned out to contain, most rows first.
   *
   * DETECTED, not declared. Upstream knew the service because the user picked
   * its card before uploading; a drop zone that takes any archive has to work it
   * out from the contents — and one archive legitimately spans several parsers,
   * which is why this is a list rather than a single value.
   *
   * Written by the parse stage. Empty until then.
   */
  @Column({ type: 'text', array: true, name: 'data_sources', default: () => "'{}'" })
  dataSources!: string[];

  /**
   * DECLARED, not detected: the importer(s) the user's chosen service card
   * stands for, recorded when the run was started from the wizard. NULL for
   * runs with no such intent on record (inbox, CLI, API callers, pre-column
   * history). The picker's "imported ✓" credits `declared ∩ detected` when
   * this is present — which is what keeps a stray readme.md inside an Amazon
   * archive from marking the Notion tile imported.
   */
  @Column({ type: 'text', array: true, name: 'declared_sources', nullable: true })
  declaredSources!: string[] | null;

  /**
   * Derived CACHE over {@link ImportStageEntity}, maintained by the stage
   * runners. Never the source of truth for whether work remains.
   */
  @Column({ type: 'text', default: 'queued' })
  status!: ImportRunStatus;

  /**
   * Weighted rollup cache, 0..100. Cached because the honest computation joins
   * every stage of the run and the run list renders dozens of rows per poll.
   */
  @Column({ type: 'smallint', default: 0 })
  percent!: number;

  /**
   * Stage kinds this run intends to execute, in order. Recorded up front so the
   * UI can draw the whole stage bar on the first poll instead of growing it a
   * box at a time as stages are created.
   */
  @Column({ type: 'text', array: true, name: 'requested_stages', default: () => "'{}'" })
  requestedStages!: string[];

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt!: Date | null;

  /**
   * NULL means the run is still live — the exact predicate of the partial index
   * `import_runs_active_idx` behind the "is anything importing right now?" poll.
   */
  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt!: Date | null;
}

export type ImportRun = Readonly<ImportRunEntity>;

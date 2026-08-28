import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * `population` is a Postgres `bigint`, which node-postgres hands back as a
 * string so a value past 2^53 is not silently mangled. An appliance index is
 * millions of rows at most, so a number is safe and far easier to compare —
 * but the conversion is explicit rather than implicit.
 */
const countColumn = {
  to: (value: number): number => value,
  from: (value: string | number | null): number => (value == null ? 0 : Number(value)),
};

/**
 * One weekly recall measurement of one search `entity_type` at one
 * `hnsw.ef_search`, written by `RecallProbeCron`. See migration 20260821223302
 * for why recall on this appliance had never been measured and why the answer
 * is persisted rather than logged.
 *
 * Rows are per-user, unlike `RetrievalHealthSnapshotEntity`: coverage is a
 * property of the index, but recall is a property of a FILTERED query, and
 * every production query filters by `user_id`.
 */
@Entity({ schema: 'ci', name: 'recall_probe_results' })
@Index(['entityType', 'capturedAt'])
export class RecallProbeResultEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Shared by every row of one cron tick, so a run is addressable as a unit. */
  @Column({ type: 'uuid', name: 'run_id' })
  runId!: string;

  @Column({ type: 'timestamptz', name: 'captured_at' })
  capturedAt!: Date;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** One of INDEXABLE_ENTITIES (`domains/search-next/types.ts`). */
  @Column({ type: 'text', name: 'entity_type' })
  entityType!: string;

  /** `hnsw.ef_search` for this leg; `null` means the server default was left alone. */
  @Column({ type: 'integer', name: 'ef_search', nullable: true })
  efSearch!: number | null;

  /** The LIMIT recall was measured at. */
  @Column({ type: 'integer', name: 'k' })
  k!: number;

  /** Sampled query vectors that produced a usable comparison. */
  @Column({ type: 'integer', name: 'samples' })
  samples!: number;

  /**
   * Indexed rows this type had for this user. A recall of 1.0 over a population
   * smaller than {@link k} is arithmetic, not good news — this is the column
   * that says so.
   */
  @Column({ type: 'bigint', name: 'population', transformer: countColumn })
  population!: number;

  @Column({ type: 'double precision', name: 'mean_recall' })
  meanRecall!: number;

  @Column({ type: 'double precision', name: 'min_recall' })
  minRecall!: number;

  /** Samples where the ANN leg returned fewer rows than the exact leg found. */
  @Column({ type: 'integer', name: 'truncated_samples', default: 0 })
  truncatedSamples!: number;

  @Column({ type: 'integer', name: 'exact_timeouts', default: 0 })
  exactTimeouts!: number;

  @Column({ type: 'integer', name: 'ann_timeouts', default: 0 })
  annTimeouts!: number;

  @Column({ type: 'double precision', name: 'mean_ann_rows' })
  meanAnnRows!: number;

  @Column({ type: 'double precision', name: 'mean_exact_rows' })
  meanExactRows!: number;

  @Column({ type: 'double precision', name: 'mean_ann_ms' })
  meanAnnMs!: number;

  /** One exact answer serves every `ef_search` leg, so this differs between a run's rows only where a leg lost a sample to a timeout. */
  @Column({ type: 'double precision', name: 'mean_exact_ms' })
  meanExactMs!: number;
}

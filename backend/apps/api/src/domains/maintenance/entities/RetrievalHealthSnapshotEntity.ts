import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Counts are `bigint` in Postgres (COUNT(*) is), which node-postgres hands back
 * as a string so a value past 2^53 is not silently mangled. Index counts on an
 * appliance are millions at most, so a number is safe here and far easier to
 * compare — but the conversion is explicit rather than implicit.
 */
const countColumn = {
  to: (value: number): number => value,
  from: (value: string | number | null): number => (value == null ? 0 : Number(value)),
};

/**
 * One nightly measurement of one search `entity_type`, written by
 * `RetrievalHealthCron`. See migration 20260821072448 for why the trend is
 * persisted rather than logged, and why BOTH index tables are counted.
 *
 * Rows are global, not user-scoped: the coverage counts they come from are
 * global (mirroring `/maintenance/search/coverage`), because an index hole is a
 * property of the index and not of an account.
 */
@Entity({ schema: 'ci', name: 'retrieval_health_snapshots' })
@Index(['entityType', 'capturedAt'])
export class RetrievalHealthSnapshotEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Shared by every row of one cron tick, so a run is addressable as a unit. */
  @Column({ type: 'uuid', name: 'run_id' })
  runId!: string;

  @Column({ type: 'timestamptz', name: 'captured_at' })
  capturedAt!: Date;

  /** One of INDEXABLE_ENTITIES (`domains/search-next/types.ts`). */
  @Column({ type: 'text', name: 'entity_type' })
  entityType!: string;

  /** Source rows for the type, with ENTITY_SOURCE_MAP's discriminator applied. */
  @Column({ type: 'bigint', name: 'source_total', transformer: countColumn })
  sourceTotal!: number;

  /** `ci_search.embeddings` rows — the re-rank side. */
  @Column({ type: 'bigint', name: 'embedded_count', transformer: countColumn })
  embeddedCount!: number;

  /** `ci_search.vectors` rows — the candidate side, i.e. what search can find. */
  @Column({ type: 'bigint', name: 'vector_count', transformer: countColumn })
  vectorCount!: number;

  @Column({ type: 'double precision', name: 'embed_ratio' })
  embedRatio!: number;

  @Column({ type: 'double precision', name: 'vector_ratio' })
  vectorRatio!: number;

  /** Source rows exist but `embeddedCount` is 0. */
  @Column({ type: 'boolean', name: 'embed_alarm', default: false })
  embedAlarm!: boolean;

  /** Source rows exist but `vectorCount` is 0 — the type is invisible to search. */
  @Column({ type: 'boolean', name: 'vector_alarm', default: false })
  vectorAlarm!: boolean;

  /** `embedRatio` below UNDER_COVERAGE_THRESHOLD. */
  @Column({ type: 'boolean', name: 'under_threshold', default: false })
  underThreshold!: boolean;

  /** The two index counts disagree by more than INDEX_DIVERGENCE_THRESHOLD. */
  @Column({ type: 'boolean', name: 'divergent', default: false })
  divergent!: boolean;
}

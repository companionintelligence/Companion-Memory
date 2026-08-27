import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One version of the appliance's retrieval policy.
 *
 * Append-only: rows are inserted with `version = MAX(version) + 1` and never
 * updated or deleted. The reader takes the newest row and nothing else, so a
 * bad version is superseded by v+1 rather than reverted — the same ledger rule
 * `domains/pipeline/versions.ts` documents for stage versions.
 *
 * There is no `user_id`. These knobs describe the retrieval ALGORITHM, not a
 * person; see migration 20260826205634 for the full argument.
 */
@Entity({ schema: 'ci', name: 'retrieval_policy' })
export class RetrievalPolicyEntity {
  /** Monotonic; starts at 1. The newest row wins. */
  @PrimaryColumn({ type: 'integer', name: 'version' })
  version!: number;

  /** `ts_rank` weight D — properties, bulk content. */
  @Column({ type: 'double precision', name: 'ts_rank_weight_d' })
  tsRankWeightD!: number;

  /** `ts_rank` weight C — categories, types, URLs. */
  @Column({ type: 'double precision', name: 'ts_rank_weight_c' })
  tsRankWeightC!: number;

  /** `ts_rank` weight B — descriptions, summaries. */
  @Column({ type: 'double precision', name: 'ts_rank_weight_b' })
  tsRankWeightB!: number;

  /** `ts_rank` weight A — names, titles, primary identifiers. */
  @Column({ type: 'double precision', name: 'ts_rank_weight_a' })
  tsRankWeightA!: number;

  /** `keyword_score * (1 + this * embedding_similarity)`. */
  @Column({ type: 'double precision', name: 'embedding_boost_factor' })
  embeddingBoostFactor!: number;

  /** Cosine DISTANCE floor for `semanticSearch`; smaller is stricter. */
  @Column({ type: 'double precision', name: 'semantic_distance_threshold' })
  semanticDistanceThreshold!: number;

  /** Default `LIMIT` for `semanticSearch`. */
  @Column({ type: 'integer', name: 'semantic_max_results' })
  semanticMaxResults!: number;

  /** Top-K for `RecallService`'s raw-message channel. */
  @Column({ type: 'integer', name: 'recall_message_results' })
  recallMessageResults!: number;

  /** `null` means "inherit `SearchService.searchMessages`' own default". */
  @Column({ type: 'double precision', name: 'recall_message_distance_floor', nullable: true })
  recallMessageDistanceFloor!: number | null;

  /** One of `SearchService`'s modes; `'boosted'` at v1. */
  @Column({ type: 'text', name: 'recall_seed_mode' })
  recallSeedMode!: string;

  /** Cosine SIMILARITY floor for the `'grounded'` strategy's semantic channel. */
  @Column({ type: 'double precision', name: 'grounded_similarity_floor' })
  groundedSimilarityFloor!: number;

  /** How much deeper `'grounded'` cuts its anchored channel than its semantic one. */
  @Column({ type: 'double precision', name: 'anchored_depth_multiplier' })
  anchoredDepthMultiplier!: number;

  @Column({ type: 'timestamptz', name: 'promoted_at' })
  promotedAt!: Date;

  /**
   * The evaluation run that justified this promotion, or `null` for v1 and for
   * hand promotions. Not a foreign key: the eval-run table does not exist yet.
   */
  @Column({ type: 'uuid', name: 'promoted_from_eval_run', nullable: true })
  promotedFromEvalRun!: string | null;

  /** Why this version exists. Required. */
  @Column({ type: 'text', name: 'notes' })
  notes!: string;
}

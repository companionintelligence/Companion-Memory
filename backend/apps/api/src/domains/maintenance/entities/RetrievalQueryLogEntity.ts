import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { RetrievalCaller } from '@ci/domains/search-next';

/**
 * One real retrieval call, written by `RetrievalQueryLogListener` off the
 * `telemetry` queue. See migration 20260826205619 — in particular for why there
 * is no `query` column and never can be.
 *
 * A plain table, not a hypertable (ADR 0002, Gate 4): a per-query log on a 1–5
 * user appliance is hundreds of rows a day, not the ≥10⁴/day/user that
 * partitioning is for.
 */
@Entity({ schema: 'ci', name: 'retrieval_query_log' })
@Index(['userId', 'ts'])
export class RetrievalQueryLogEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'ts' })
  ts!: Date;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Which entry point served the retrieval. */
  @Column({ type: 'text', name: 'caller' })
  caller!: RetrievalCaller;

  /** Strategy actually taken, AFTER `auto` resolved. */
  @Column({ type: 'text', name: 'mode_taken', nullable: true })
  modeTaken!: string | null;

  /**
   * Whitespace token count of the query — the ONLY thing retained about what
   * was asked. The text itself never leaves the retrieval call.
   */
  @Column({ type: 'integer', name: 'query_token_count' })
  queryTokenCount!: number;

  @Column({ type: 'text', name: 'include_types', array: true, nullable: true })
  includeTypes!: string[] | null;

  /** Includes the defaults `applyDefaultTypeExclusions` injects. */
  @Column({ type: 'text', name: 'exclude_types', array: true, nullable: true })
  excludeTypes!: string[] | null;

  @Column({ type: 'integer', name: 'result_count' })
  resultCount!: number;

  /**
   * Postgres GENERATED column (`result_count = 0`). Never written from here —
   * `insert: false, update: false` — so the derived flag cannot drift from the
   * count it is derived from.
   */
  @Column({ type: 'boolean', name: 'zero_result', insert: false, update: false })
  zeroResult!: boolean;

  /** Null where the retrieval path produces no score, or nothing matched. */
  @Column({ type: 'double precision', name: 'top_score', nullable: true })
  topScore!: number | null;

  @Column({ type: 'integer', name: 'latency_ms' })
  latencyMs!: number;
}

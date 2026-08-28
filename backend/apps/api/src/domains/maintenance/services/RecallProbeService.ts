import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, type QueryRunner, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import {
  INDEXABLE_ENTITIES,
  type IndexableEntity,
  SEMANTIC_MAX_RESULTS,
  SearchService,
} from '@ci/domains/search-next';

import { RecallProbeResultEntity } from '../entities/RecallProbeResultEntity';

/**
 * Types this probe will measure, and the one it deliberately will not.
 *
 * `message` is indexed in the same table but production never reaches it
 * through the statement measured here — `SearchService.searchMessages` is a
 * different query with a different LIMIT and a literal type predicate. Probing
 * it with the entity statement would produce a number for a query nobody runs.
 */
export const PROBED_TYPES: readonly IndexableEntity[] = INDEXABLE_ENTITIES.filter(
  (entityType) => entityType !== 'message',
);

/** k for recall@k — the LIMIT the production statement carries. */
export const PROBE_K = SEMANTIC_MAX_RESULTS;

/**
 * Query vectors drawn per type. 50 is the review's figure and it is a cost
 * ceiling, not a target: each one buys a sequential scan on the exact leg.
 */
export const SAMPLES_PER_TYPE = 50;

/**
 * Types measured per run, rotating weekly in non-overlapping windows, so a full
 * sweep of {@link PROBED_TYPES} takes `ceil(eligible / 3)` weeks.
 *
 * The alternative was every type every week, and the exact leg is what makes
 * that a bad trade: it is a sequential scan over ~1.1 GB of 768-dim vectors,
 * and every type × 50 samples of that is an hour of disk the appliance was
 * going to spend on the enrichment window instead. Recall moves with the
 * corpus, and the corpus does not change materially over a sweep; a stale
 * reading for a type is a far smaller problem than a probe that competes with
 * the work it measures.
 */
export const TYPES_PER_RUN = 3;

/**
 * `hnsw.ef_search` settings each sample is re-run at. `null` is the server
 * default, left unset — recorded as `null` rather than as 40 because the
 * default belongs to pgvector, not to this file.
 */
export const EF_SEARCH_VARIANTS: readonly (number | null)[] = [null, 100, 200, 400];

/** The widest candidate list any leg asks for. */
export const WIDEST_EF_SEARCH = Math.max(
  ...EF_SEARCH_VARIANTS.filter((efSearch): efSearch is number => efSearch != null),
);

/**
 * Smallest index a type may have and still be worth measuring.
 *
 * An HNSW search keeps a candidate list of `ef_search` nodes, so a type whose
 * whole population fits in that list comes back entire however badly its graph
 * is built: recall reads 1.0 by arithmetic rather than by merit, and nothing
 * about `ef_search` has been learned. The bar is five times the widest setting
 * this probe asks for — 2,000 for the 400 leg — so even the widest leg reads at
 * most a fifth of the type before it is allowed to score it.
 *
 * Reporting an unearned 1.0 as "recall is perfect" is worse than reporting
 * nothing, so a type under this bar is not measured and NOT WRITTEN: it is named
 * in {@link RecallProbeRun.tooSmall} and in the log instead. `mean_recall` is
 * `NOT NULL` (migration 20260821223302), so a row for such a type could only
 * carry a number, and "not measured" and "measured at 1.0" are different facts.
 * The absent row is what keeps them apart.
 */
export const MIN_POPULATION = WIDEST_EF_SEARCH * 5;

/** Statement timeout for the exact leg — the expensive half, and the one that can run away. */
export const EXACT_TIMEOUT_MS = 30_000;

/** Statement timeout for an ANN leg. An index-served KNN that takes this long has already failed. */
export const ANN_TIMEOUT_MS = 5_000;

/**
 * Wall-clock ceiling for a whole run, checked between samples.
 *
 * The per-statement timeouts bound one statement; nothing else bounds 3 × 50 of
 * them. Measured on this hardware, one exact leg over a 45,000-row index costs
 * ~284 ms, so a corpus an order of magnitude larger will spend this budget
 * before the third type — which is the bound working, not failing. The run then
 * stops and persists what it measured; a row's `samples` column says how much of
 * the sample it got, and because {@link selectProbeTypes} advances its starting
 * point every week, a type cut off this week is first in line soon after rather
 * than starved forever.
 */
export const MAX_RUN_MS = 10 * 60_000;

/** How long measurements are kept. Matches the retrieval-health snapshots next door. */
export const RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One sampled query vector's outcome at one `ef_search`. */
export interface LegSample {
  recall: number;
  annRows: number;
  exactRows: number;
  annMs: number;
  exactMs: number;
}

export interface LegSummary {
  samples: number;
  meanRecall: number;
  minRecall: number;
  truncatedSamples: number;
  meanAnnRows: number;
  meanExactRows: number;
  meanAnnMs: number;
  meanExactMs: number;
}

export interface RecallProbeRun {
  runId: string;
  capturedAt: Date;
  /** `null` when no user has an index large enough to measure. */
  userId: string | null;
  /** Types measured this run. */
  types: string[];
  /** Eligible types the rotation did not reach this week. */
  deferredTypes: string[];
  /**
   * Types below {@link MIN_POPULATION}: not measured, and deliberately absent
   * from `ci.recall_probe_results` rather than written with a number nobody
   * earned. Named here and in the log so "nothing was measured" has a reason.
   */
  tooSmall: string[];
  rows: RecallProbeResultEntity[];
  /** True when {@link MAX_RUN_MS} cut the sample short. */
  deadlineHit: boolean;
  pruned: number;
}

export interface TypePopulation {
  userId: string;
  entityType: string;
  population: number;
}

interface LegResult {
  ids: string[];
  ms: number;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ANN RECALL ACTUALLY IS ON THIS APPLIANCE — MEASURED, NOT ASSUMED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `embeddings_embedding_hnsw_idx` indexes `embedding` and nothing else, while
 * `SearchService.semanticSearch` filters on `user_id` and on `entity_type`
 * OUTSIDE the ORDER BY. The index therefore returns its nearest neighbours
 * across every user and every type, and the filters discard whatever does not
 * belong — so a type-filtered search can come back with a handful of rows while
 * the answer it should have returned is sitting in the table. Both knobs that
 * govern how wide the index searches (`hnsw.ef_search`, `hnsw.iterative_scan`)
 * are at their defaults, and a repo-wide grep shows neither has ever been set.
 *
 * This service turns that into numbers: for each sampled query vector, the
 * production statement against an exact answer, then the same statement at
 * `ef_search` 100 / 200 / 400. Picking a value afterwards is a human decision
 * made against a table of measurements instead of a guess.
 *
 * ── Three properties this is built to keep ────────────────────────────────
 *
 *  1. **It measures the production query, not a copy of it.** The SQL comes
 *     from `SearchService.buildSemanticSearchPlan`, the same function
 *     `semanticSearch` itself calls. A probe running a re-typed statement
 *     measures the re-typed statement.
 *  2. **It changes nothing.** No `SET` outlives its transaction (`SET LOCAL`
 *     only), no setting is written anywhere, and the only rows it writes are
 *     its own measurements. `PersonalizationService` is not consulted because
 *     there is no user data to mutate and no inference to rate.
 *  3. **It is bounded before it is thorough.** One user, three types, fifty
 *     samples, a statement timeout on every leg and a wall-clock deadline on
 *     the run. The exact leg is a sequential scan over the whole embedding
 *     table and the probe runs inside the enrichment window; an unbounded
 *     measurement would be competing with the indexing it exists to check.
 *
 * ── The one thing the sample cannot tell you ──────────────────────────────
 *
 * Query vectors are drawn from the index itself rather than embedded fresh,
 * which costs zero Ollama calls and makes the probe independent of whether the
 * embedder is up. The cost is that these are in-distribution queries: they
 * measure how well the graph finds neighbours of points it already holds, which
 * is the case the post-filter defect shows up in, but they are not a stand-in
 * for a genuinely unseen query. Read the numbers as an upper bound.
 */
@Injectable()
export class RecallProbeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(RecallProbeResultEntity)
    private readonly resultRepository: Repository<RecallProbeResultEntity>,
    private readonly searchService: SearchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RecallProbeService.name);
  }

  async probe(now: Date = new Date()): Promise<RecallProbeRun> {
    const runId = uuidv7();
    const capturedAt = new Date(now.getTime());
    // Off the wall clock, NOT off `now`: the argument exists so a caller can
    // stamp and prune against a fixed instant, and a deadline derived from it
    // would be either already past or hours away the moment a test moves it.
    const deadline = Date.now() + MAX_RUN_MS;

    const populations = await this.loadPopulations();
    const userId = pickProbeUser(populations);

    if (userId == null) {
      // Every type that exists is under the bar — that IS the reason nothing was
      // measured, and the cron logs this list. Leaving it empty here would make
      // "no index to measure" indistinguishable from "no index at all".
      const tooSmall = [
        ...new Set(populations.filter((row) => row.population < MIN_POPULATION).map((row) => row.entityType)),
      ].sort();

      this.logger.log('Recall probe found no index to measure', { runId, tooSmall });

      return {
        runId,
        capturedAt,
        userId: null,
        types: [],
        deferredTypes: [],
        tooSmall,
        rows: [],
        deadlineHit: false,
        pruned: await this.prune(now),
      };
    }

    const mine = populations.filter((row) => row.userId === userId);
    const eligible = mine
      .filter((row) => row.population >= MIN_POPULATION)
      .map((row) => row.entityType)
      .sort();
    const tooSmall = mine
      .filter((row) => row.population < MIN_POPULATION)
      .map((row) => row.entityType)
      .sort();
    const types = selectProbeTypes(eligible, weekIndex(now));
    const populationOf = new Map(mine.map((row) => [row.entityType, row.population]));

    const rows: RecallProbeResultEntity[] = [];
    let deadlineHit = false;

    const runner = this.dataSource.createQueryRunner();

    await runner.connect();

    try {
      for (const entityType of types) {
        let measured;

        try {
          measured = await this.probeType(runner, userId, entityType, deadline);
        } catch (error) {
          // One type's failure must not cost the run the types it already
          // measured — those rows are the week's only reading.
          this.logger.error('Recall probe failed for one type', {
            runId,
            entityType,
            error: error instanceof Error ? error.message : String(error),
          });

          continue;
        }

        deadlineHit = deadlineHit || measured.deadlineHit;

        for (const [efSearch, summary] of measured.legs) {
          if (summary.samples === 0) {
            continue;
          }

          rows.push(
            this.resultRepository.create({
              id: uuidv7(),
              runId,
              capturedAt,
              userId,
              entityType,
              efSearch,
              k: PROBE_K,
              population: populationOf.get(entityType) ?? 0,
              samples: summary.samples,
              meanRecall: summary.meanRecall,
              minRecall: summary.minRecall,
              truncatedSamples: summary.truncatedSamples,
              exactTimeouts: measured.exactTimeouts,
              annTimeouts: measured.annTimeouts,
              meanAnnRows: summary.meanAnnRows,
              meanExactRows: summary.meanExactRows,
              meanAnnMs: summary.meanAnnMs,
              meanExactMs: summary.meanExactMs,
            }),
          );
        }
      }
    } finally {
      await runner.release();
    }

    if (rows.length > 0) {
      await this.resultRepository.save(rows);
    }

    const pruned = await this.prune(now);

    this.logger.log('Recall probe captured', {
      runId,
      userId,
      types,
      tooSmall,
      rows: rows.length,
      deadlineHit,
      pruned,
      recallAtDefault: rows
        .filter((row) => row.efSearch == null)
        .map((row) => `${row.entityType}=${row.meanRecall.toFixed(3)}`),
    });

    return {
      runId,
      capturedAt,
      userId,
      types,
      deferredTypes: eligible.filter((entityType) => !types.includes(entityType)),
      tooSmall,
      rows,
      deadlineHit,
      pruned,
    };
  }

  /**
   * Rows per (user, type), in one grouped pass.
   *
   * One aggregate a week is cheap next to the exact legs it sizes, and it
   * answers all three questions the run has to open with: whose index to probe,
   * which of that user's types are big enough to say anything, and what
   * `population` each measurement should be read against.
   */
  private async loadPopulations(): Promise<TypePopulation[]> {
    const rows = (await this.dataSource.query(
      `SELECT user_id, entity_type, COUNT(*) AS population
         FROM ci_search.embeddings
        WHERE user_id IS NOT NULL
          AND entity_type = ANY($1)
          AND embedding IS NOT NULL
        GROUP BY user_id, entity_type`,
      [[...PROBED_TYPES]],
    )) as Array<{ user_id: string; entity_type: string; population: string }>;

    return rows.map((row) => ({
      userId: String(row.user_id),
      entityType: String(row.entity_type),
      population: Number(row.population),
    }));
  }

  private async probeType(
    runner: QueryRunner,
    userId: string,
    entityType: string,
    deadline: number,
  ): Promise<{
    legs: Map<number | null, LegSummary>;
    exactTimeouts: number;
    annTimeouts: number;
    deadlineHit: boolean;
  }> {
    const vectors = await this.sampleVectors(runner, userId, entityType);
    const collected = new Map<number | null, LegSample[]>(EF_SEARCH_VARIANTS.map((ef) => [ef, []]));

    let exactTimeouts = 0;
    let annTimeouts = 0;
    let deadlineHit = false;

    for (const vector of vectors) {
      if (Date.now() >= deadline) {
        deadlineHit = true;
        break;
      }

      const plan = this.searchService.buildSemanticSearchPlan(userId, vector, {
        includeTypes: [entityType as IndexableEntity],
        maxResults: PROBE_K,
      });

      const exact = await this.runLeg(runner, plan.sql, plan.params, {
        timeoutMs: EXACT_TIMEOUT_MS,
        exhaustive: true,
      });

      if (exact == null) {
        exactTimeouts += 1;
        continue;
      }

      // No row within the distance floor means production would return nothing
      // for this vector, and recall over an empty answer is not a number.
      if (exact.ids.length === 0) {
        continue;
      }

      for (const efSearch of EF_SEARCH_VARIANTS) {
        const ann = await this.runLeg(runner, plan.sql, plan.params, {
          timeoutMs: ANN_TIMEOUT_MS,
          efSearch,
        });

        if (ann == null) {
          annTimeouts += 1;
          continue;
        }

        collected.get(efSearch)?.push({
          recall: recallAt(exact.ids, ann.ids),
          annRows: ann.ids.length,
          exactRows: exact.ids.length,
          annMs: ann.ms,
          exactMs: exact.ms,
        });
      }
    }

    const legs = new Map<number | null, LegSummary>();

    for (const [efSearch, samples] of collected) {
      legs.set(efSearch, summarizeLeg(samples));
    }

    return { legs, exactTimeouts, annTimeouts, deadlineHit };
  }

  /**
   * Query vectors, taken from the index rather than embedded.
   *
   * `ORDER BY random()` is a scan of the type's rows, which is the same order
   * of cost as one exact leg and buys an unbiased sample; the alternatives
   * (`TABLESAMPLE`, an id range) skew towards whatever was inserted together,
   * and an import inserts by source.
   */
  private async sampleVectors(runner: QueryRunner, userId: string, entityType: string): Promise<string[]> {
    const rows = await this.inTransaction(runner, EXACT_TIMEOUT_MS, null, false, async () =>
      runner.query(
        `SELECT embedding::text AS embedding
           FROM ci_search.embeddings
          WHERE user_id = $1
            AND entity_type = $2
            AND embedding IS NOT NULL
          ORDER BY random()
          LIMIT $3`,
        [userId, entityType, SAMPLES_PER_TYPE],
      ),
    );

    if (rows == null) {
      this.logger.warn('Recall probe could not draw a sample', { entityType });

      return [];
    }

    return (rows as Array<{ embedding: string }>).map((row) => row.embedding);
  }

  /**
   * One leg: the production statement, on a connection whose planner has been
   * told what to do for the length of this transaction and nothing longer.
   *
   * The stopwatch is inside the transaction and around the statement alone.
   * BEGIN, the one to three `SET LOCAL` round trips and COMMIT are what it costs
   * to MEASURE and not what the query costs; they land on every leg, so leaving
   * them in would keep the legs comparable while making `mean_ann_ms` and
   * `mean_exact_ms` — which exist to answer "what does this `ef_search` cost" —
   * an unknown constant too high.
   *
   * Returns `null` when the statement timed out — which is a measurement
   * outcome (`exact_timeouts` / `ann_timeouts`), not an error, and must not
   * abort the rest of the run.
   */
  private async runLeg(
    runner: QueryRunner,
    sql: string,
    params: unknown[],
    options: { timeoutMs: number; efSearch?: number | null; exhaustive?: boolean },
  ): Promise<LegResult | null> {
    const measured = await this.inTransaction(
      runner,
      options.timeoutMs,
      options.efSearch ?? null,
      options.exhaustive ?? false,
      async () => {
        const startedAt = Date.now();
        const rows = (await runner.query(sql, params)) as Array<{ entity_id: string }>;

        return { rows, ms: Date.now() - startedAt };
      },
    );

    if (measured == null) {
      return null;
    }

    return {
      ids: measured.rows.map((row) => String(row.entity_id)),
      ms: measured.ms,
    };
  }

  /**
   * `SET LOCAL` inside a transaction, so every setting dies with the statement
   * it was for. A `SET` without `LOCAL` on a pooled connection would leak the
   * probe's planner settings into whatever query borrowed that connection next
   * — an ANN-only appliance suddenly sequential-scanning because a measurement
   * ran an hour ago.
   */
  private async inTransaction<T>(
    runner: QueryRunner,
    timeoutMs: number,
    efSearch: number | null,
    exhaustive: boolean,
    work: () => Promise<T>,
  ): Promise<T | null> {
    await runner.startTransaction();

    try {
      await runner.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);

      if (exhaustive) {
        // The ground truth. With both off the planner has no way to reach
        // `embeddings_embedding_hnsw_idx` (an index-only scan needs
        // `enable_indexscan` too), so it scans and sorts, which is exact.
        await runner.query('SET LOCAL enable_indexscan = off');
        await runner.query('SET LOCAL enable_bitmapscan = off');
      }

      if (efSearch != null) {
        await runner.query(`SET LOCAL hnsw.ef_search = ${efSearchSetting(efSearch)}`);
      }

      const result = await work();

      await runner.commitTransaction();

      return result;
    } catch (error) {
      await runner.rollbackTransaction();

      if (isStatementTimeout(error)) {
        return null;
      }

      throw error;
    }
  }

  /** Drop measurements past {@link RETENTION_DAYS}. Returns the number deleted. */
  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const result = await this.resultRepository.delete({ capturedAt: LessThan(cutoff) });

    return result.affected ?? 0;
  }
}

/**
 * Which types this week's run measures.
 *
 * A rotation and not a random pick: the window advances by its own width, so
 * two consecutive runs share no type and every eligible type is measured once
 * per sweep. A trend for one type then builds at a predictable cadence instead
 * of depending on how the dice fell. The final window of a sweep wraps when the
 * type count is not a multiple of `perRun`, which re-measures a few types a week
 * early — cheaper than carrying a partial window.
 */
export function selectProbeTypes(
  eligible: readonly string[],
  week: number,
  perRun: number = TYPES_PER_RUN,
): string[] {
  if (eligible.length === 0) {
    return [];
  }

  const take = Math.min(perRun, eligible.length);
  // Advance by a whole window, not by one: stepping by 1 would re-measure
  // `perRun - 1` of the same types every week and stretch a full sweep from
  // ceil(n / perRun) weeks to n.
  const windows = Math.ceil(eligible.length / take);
  const start = ((((week % windows) + windows) % windows) * take) % eligible.length;

  return Array.from({ length: take }, (_, offset) => eligible[(start + offset) % eligible.length]);
}

/**
 * Weeks since the epoch. Not the ISO week number — the run only needs a counter
 * that advances once every seven days and never goes backwards, and ISO weeks
 * repeat 1..52 and would restart the rotation every new year.
 */
export function weekIndex(now: Date): number {
  return Math.floor(now.getTime() / (7 * DAY_MS));
}

/** The user whose index is measured this run: the one with the most indexed rows. */
export function pickProbeUser(populations: readonly TypePopulation[]): string | null {
  const totals = new Map<string, number>();

  for (const row of populations) {
    if (row.population < MIN_POPULATION) {
      continue;
    }

    totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.population);
  }

  let winner: string | null = null;
  let best = 0;

  // Ties break on user id so a two-user appliance probes the same index every
  // week rather than alternating, which would halve every trend.
  for (const [userId, total] of [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (total > best) {
      winner = userId;
      best = total;
    }
  }

  return winner;
}

/** recall@k: the fraction of the exact answer the index actually returned. */
export function recallAt(exact: readonly string[], ann: readonly string[]): number {
  if (exact.length === 0) {
    return 1;
  }

  const returned = new Set(ann);
  const hits = exact.filter((id) => returned.has(id)).length;

  return hits / exact.length;
}

/** Collapse one leg's samples into the row that gets persisted. */
export function summarizeLeg(samples: readonly LegSample[]): LegSummary {
  if (samples.length === 0) {
    return {
      samples: 0,
      meanRecall: 0,
      minRecall: 0,
      truncatedSamples: 0,
      meanAnnRows: 0,
      meanExactRows: 0,
      meanAnnMs: 0,
      meanExactMs: 0,
    };
  }

  const mean = (pick: (sample: LegSample) => number): number =>
    samples.reduce((total, sample) => total + pick(sample), 0) / samples.length;

  return {
    samples: samples.length,
    meanRecall: mean((sample) => sample.recall),
    minRecall: Math.min(...samples.map((sample) => sample.recall)),
    // The post-filter signature: the ANN leg came back with less than the exact
    // answer HAD, which is a different failure from returning the wrong rows.
    truncatedSamples: samples.filter((sample) => sample.annRows < sample.exactRows).length,
    meanAnnRows: mean((sample) => sample.annRows),
    meanExactRows: mean((sample) => sample.exactRows),
    meanAnnMs: mean((sample) => sample.annMs),
    meanExactMs: mean((sample) => sample.exactMs),
  };
}

/**
 * `SET` takes no bind parameters, so this value is interpolated into SQL. It
 * comes from {@link EF_SEARCH_VARIANTS}, a module constant, but the check is
 * here anyway: the day somebody makes the variants configurable, the guard is
 * already in the path rather than being remembered.
 */
function efSearchSetting(efSearch: number): number {
  if (!Number.isInteger(efSearch) || efSearch < 1 || efSearch > 1000) {
    throw new Error(`Refusing to set hnsw.ef_search to ${efSearch}: expected an integer in [1, 1000]`);
  }

  return efSearch;
}

/** Postgres `57014 query_canceled` — what `statement_timeout` raises. */
function isStatementTimeout(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '57014';
}

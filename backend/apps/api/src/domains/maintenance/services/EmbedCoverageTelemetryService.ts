import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { ENTITY_SOURCE_MAP, type EntitySource } from '@ci/domains/search-ingress';
import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

/**
 * Per-entity-type embed-coverage figure: how many source rows exist for the type
 * (`total`), how many carry a `ci_search.embeddings` row (`embedded`), and the
 * ratio embedded/total in [0, 1] (0 when `total` is 0, so an empty type is 100%
 * "covered" rather than a divide-by-zero NaN).
 */
export interface EntityCoverage {
  /** Source rows for this entity type (with the source map's discriminator applied). */
  total: number;
  /** `ci_search.embeddings` rows for this entity type. */
  embedded: number;
  /** embedded / total, clamped to [0, 1]; 0 when total is 0. */
  ratio: number;
  /**
   * True when the type has source rows but ZERO embeddings — a total coverage
   * hole (gap G2: e.g. content 0/366k). The severe subset of `underThreshold`.
   * Always false for a type with no source rows (nothing to embed).
   */
  alarm: boolean;
  /**
   * True when the type has source rows but its coverage ratio is below
   * {@link UNDER_COVERAGE_THRESHOLD} — i.e. meaningfully under-indexed, not just
   * a complete hole. Catches the partial-coverage gaps a zero-only alarm misses
   * (e.g. person 0.28%, communications 14%). A superset of `alarm`. Always false
   * for a type with no source rows.
   */
  underThreshold: boolean;
}

/**
 * Whole-index coverage snapshot: one {@link EntityCoverage} per indexable type,
 * a flat `alarms` list of the types tripping the zero-coverage alarm, and an
 * `underThreshold` list of the types below the coverage-ratio target.
 */
export interface EmbedCoverageReport {
  /** entity_type -> coverage figures. Every INDEXABLE_ENTITIES type appears. */
  perType: Record<string, EntityCoverage>;
  /** Types with source rows but no embeddings at all (alarm === true). */
  alarms: string[];
  /** Types below the coverage-ratio target (underThreshold === true; superset of alarms). */
  underThreshold: string[];
  /** ISO timestamp the snapshot was computed at. */
  computedAt: string;
}

/**
 * A type's coverage on BOTH index tables: {@link EntityCoverage} (source rows vs
 * `ci_search.embeddings`) plus the `ci_search.vectors` count that decides
 * whether the type is findable at all.
 */
export interface EntityIndexHealth extends EntityCoverage {
  /** `ci_search.vectors` rows for this entity type — the search CANDIDATE side. */
  vectored: number;
  /** vectored / total, clamped to [0, 1]; 0 when total is 0. */
  vectorRatio: number;
  /**
   * True when the type has source rows but ZERO vectors. Strictly worse than
   * {@link EntityCoverage.alarm}: an embedded-but-unvectored type answers no
   * search at all, because the candidate pass never proposes it.
   */
  vectorAlarm: boolean;
  /**
   * |embedded - vectored| / max(embedded, vectored), in [0, 1]. 0 when both are
   * 0 (an untouched type is not "divergent", it is simply empty).
   */
  divergence: number;
  /**
   * True when the type has source rows and {@link divergence} exceeds
   * {@link INDEX_DIVERGENCE_THRESHOLD} — the two halves of the index disagree,
   * which is how "healthy on embeddings, invisible to search" looks from here.
   */
  divergent: boolean;
}

/** Whole-index health snapshot: {@link EmbedCoverageReport} plus the vector side. */
export interface IndexHealthReport {
  /** entity_type -> both-table figures. Every measured type appears. */
  perType: Record<string, EntityIndexHealth>;
  /** Types with source rows but no embeddings at all. */
  alarms: string[];
  /** Types with source rows but no vectors at all — invisible to search. */
  vectorAlarms: string[];
  /** Types whose EMBED ratio is below the coverage target. */
  underThreshold: string[];
  /** Types whose embedding and vector counts materially disagree. */
  divergent: string[];
  /** ISO timestamp the snapshot was computed at. */
  computedAt: string;
}

/**
 * Embed-coverage telemetry (memory-and-search plan, gap G2 / issue #1239).
 *
 * Why it exists, as a HISTORICAL reading and not a current one: when this was
 * written nothing monitored how much of the corpus was embedded, so the
 * coverage holes of the day (content 0/366,862, event 2,743/42,376 = 6.5%)
 * went unnoticed until measured by hand for PR #1605. Those figures are a
 * snapshot of that incident — for what the index looks like NOW, read
 * `ci.retrieval_health_snapshots`, which `RetrievalHealthCron` fills nightly
 * from {@link EmbedCoverageTelemetryService.computeIndexHealth}.
 *
 * This service computes, per search `entity_type`, the ratio of source rows
 * that carry a `ci_search.embeddings` row, and flags any type that has data but
 * zero embeddings.
 *
 * It is pure observability — no retrieval-path change, no writes. Counts are
 * GLOBAL (not user-scoped), mirroring the /search-index/embedded-count gauge and
 * the SearchIndexBackfillService sweep it complements.
 *
 * All table / column identifiers come from the trusted internal
 * {@link ENTITY_SOURCE_MAP} (never request input), so interpolating them is safe;
 * the only bound value is the discriminator literal.
 */
@Injectable()
export class EmbedCoverageTelemetryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EmbedCoverageTelemetryService.name);
  }

  /**
   * Compute the coverage report over the requested entity types (default: every
   * INDEXABLE_ENTITIES type). Each type contributes two COUNT queries (source
   * total + embedded count); both are index-served (the source PK and the
   * `ci_search.embeddings (entity_type, entity_id)` unique index, whose leading
   * column is `entity_type`).
   *
   * Bounded exactly like {@link computeIndexHealth} — one pinned connection, a
   * per-COUNT `statement_timeout` and a wall-clock budget (see
   * {@link runBounded}) — and for a sharper reason: this one is on the HTTP
   * path (`GET /maintenance/search/coverage`), so an unbounded run holds a
   * pooled connection for a request whose caller has long since hung up.
   * That is also why the default budget is {@link DEFAULT_COVERAGE_BUDGET_MS}
   * rather than the nightly sweep's ten minutes.
   */
  async computeCoverage(
    entityTypes?: IndexableEntity[],
    options: { statementTimeoutMs?: number; budgetMs?: number } = {},
  ): Promise<EmbedCoverageReport> {
    const types = entityTypes ?? [...INDEXABLE_ENTITIES];

    const perType: Record<string, EntityCoverage> = {};
    const alarms: string[] = [];
    const underThreshold: string[] = [];

    await this.runBounded(
      {
        label: 'Embed-coverage sweep',
        typeCount: types.length,
        defaultBudgetMs: DEFAULT_COVERAGE_BUDGET_MS,
        options,
      },
      async (query, typeMeasured) => {
        for (const entityType of types) {
          const source = sourceFor(entityType);

          const total = await this.countSource(source, query);
          const embedded = await this.countIndexed('embeddings', entityType, query);

          const coverage = buildCoverage(total, embedded);
          perType[entityType] = coverage;

          if (coverage.alarm) {
            alarms.push(entityType);
          }

          if (coverage.underThreshold) {
            underThreshold.push(entityType);
          }

          typeMeasured();
        }
      },
    );

    if (alarms.length > 0) {
      // Surface the total holes in the log stream too, so an appliance without a
      // metrics scraper still leaves a breadcrumb.
      this.logger.warn('Embed-coverage alarm: types with source rows but no embeddings', {
        alarms,
      });
    }

    // Under-threshold (but non-zero) types are the ones a zero-only alarm used to
    // miss — warn on them separately so partial-coverage gaps are visible.
    const partialOnly = underThreshold.filter((type) => !alarms.includes(type));

    if (partialOnly.length > 0) {
      this.logger.warn(
        `Embed-coverage below target (ratio < ${UNDER_COVERAGE_THRESHOLD}): types are indexed but under-covered`,
        { underThreshold: partialOnly },
      );
    }

    return { perType, alarms, underThreshold, computedAt: new Date().toISOString() };
  }

  /**
   * Both halves of the index, per type — what {@link computeCoverage} measures
   * plus the `ci_search.vectors` count it does not.
   *
   * Why that matters, and why it is not a nicety: `ci_search.vectors` is the
   * search CANDIDATE source (`ObjectMergeService`/`SearchService` select from
   * it), while `ci_search.embeddings` only re-ranks what the candidate pass
   * already found. A type with full embedding coverage and zero vectors is
   * therefore INVISIBLE to search while reading 100% "covered" — and because
   * the backfill sweep anti-joins on `embeddings`, filling embeddings alone
   * locks that invisibility in: the sweep sees nothing missing and never mints
   * the vector. Divergence between the two counts is its own alert condition.
   *
   * Cost and bounding: 3 index-served COUNTs per type (54 for the full 18), all
   * on ONE dedicated pooled connection under the two ceilings {@link runBounded}
   * imposes — 12 minutes at worst on this method's defaults.
   *
   * Blowing either ceiling throws, and deliberately returns nothing: the tick
   * is recorded as attempted-not-succeeded in `ci.cron_runs`, which is the
   * honest signal, rather than a partial snapshot that would read as a
   * coverage collapse.
   */
  async computeIndexHealth(
    entityTypes?: IndexableEntity[],
    options: { statementTimeoutMs?: number; budgetMs?: number } = {},
  ): Promise<IndexHealthReport> {
    const types = entityTypes ?? [...INDEXABLE_ENTITIES];

    const perType: Record<string, EntityIndexHealth> = {};
    const alarms: string[] = [];
    const vectorAlarms: string[] = [];
    const underThreshold: string[] = [];
    const divergent: string[] = [];

    await this.runBounded(
      {
        label: 'Index-health sweep',
        typeCount: types.length,
        defaultBudgetMs: DEFAULT_HEALTH_SWEEP_BUDGET_MS,
        options,
      },
      async (query, typeMeasured) => {
        for (const entityType of types) {
          const source = sourceFor(entityType);

          const total = await this.countSource(source, query);
          const embedded = await this.countIndexed('embeddings', entityType, query);
          const vectored = await this.countIndexed('vectors', entityType, query);

          const health = buildIndexHealth(total, embedded, vectored);
          perType[entityType] = health;

          if (health.alarm) {
            alarms.push(entityType);
          }

          if (health.vectorAlarm) {
            vectorAlarms.push(entityType);
          }

          if (health.underThreshold) {
            underThreshold.push(entityType);
          }

          if (health.divergent) {
            divergent.push(entityType);
          }

          typeMeasured();
        }
      },
    );

    if (vectorAlarms.length > 0) {
      this.logger.warn(
        'Retrieval alarm: types with source rows but NO search vectors (invisible to search)',
        {
          vectorAlarms,
        },
      );
    }

    if (alarms.length > 0) {
      this.logger.warn('Embed-coverage alarm: types with source rows but no embeddings', { alarms });
    }

    if (divergent.length > 0) {
      this.logger.warn('Index divergence: embeddings and vectors disagree for these types', { divergent });
    }

    return {
      perType,
      alarms,
      vectorAlarms,
      underThreshold,
      divergent,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Run a per-type COUNT sweep on ONE pinned pooled connection, under both
   * ceilings a sweep needs. Shared by {@link computeCoverage} and
   * {@link computeIndexHealth} so there is one answer to "how long may this
   * hold a connection", not two.
   *
   * Two ceilings, because the per-statement one alone bounds nothing useful:
   * `statement_timeout` caps a SINGLE count, so a sweep of counts each
   * finishing just inside the 120s default would still pin one of the 25 pool
   * connections for hours. So the run also carries a wall-clock BUDGET,
   * checked before every count. The enforced bound on how long the connection
   * is held is therefore `budgetMs` plus the one statement in flight when the
   * deadline passes, i.e. at most `budgetMs + statementTimeoutMs`.
   *
   * Blowing the budget throws rather than returning what was measured so far:
   * a partial snapshot reads as a coverage collapse.
   */
  private async runBounded(
    spec: {
      label: string;
      typeCount: number;
      defaultBudgetMs: number;
      options: { statementTimeoutMs?: number; budgetMs?: number };
    },
    sweep: (query: Executor, typeMeasured: () => void) => Promise<void>,
  ): Promise<void> {
    const timeoutMs = spec.options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    const budgetMs = Math.max(1, Math.floor(spec.options.budgetMs ?? spec.defaultBudgetMs));
    const deadline = Date.now() + budgetMs;

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    let measured = 0;

    // Checked BEFORE issuing, not after: refusing to start the next count is
    // what caps the hold; noticing afterwards would already have paid for it.
    const query: Executor = (sql, params) => {
      if (Date.now() >= deadline) {
        throw new Error(
          `${spec.label} abandoned: ${budgetMs}ms wall-clock budget spent after ${measured}/${spec.typeCount} types`,
        );
      }

      return runner.query(sql, params) as Promise<Array<{ count: string }>>;
    };

    try {
      // Session-scoped, not SET LOCAL: this runner owns its connection until
      // release, and a read-only sweep should not hold one snapshot open across
      // every count just to scope a GUC.
      await runner.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);

      await sweep(query, () => {
        measured += 1;
      });
    } finally {
      // RESET before release so the pooled connection goes back unmodified even
      // when a count threw.
      await runner.query('RESET statement_timeout').catch(() => undefined);
      await runner.release();
    }
  }

  /** Source rows for this type, honouring the source map's discriminator. */
  private async countSource(source: EntitySource, query: Executor): Promise<number> {
    const sourceRef = `"${source.schema}"."${source.table}"`;

    const discriminatorClause = source.discriminator ? `WHERE "${source.discriminator.column}" = $1` : '';
    const params = source.discriminator ? [source.discriminator.value] : [];

    const rows = await query(
      `SELECT COUNT(*)::bigint AS count FROM ${sourceRef} ${discriminatorClause}`,
      params,
    );

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * `ci_search.<table>` rows for this entity type (index-served: `entity_type`
   * leads the unique index on both embeddings and vectors). `table` is a
   * literal from this file, never request input.
   */
  private async countIndexed(
    table: 'embeddings' | 'vectors',
    entityType: IndexableEntity,
    query: Executor,
  ): Promise<number> {
    const rows = await query(
      `SELECT COUNT(*)::bigint AS count FROM ci_search.${table} WHERE entity_type = $1`,
      [entityType],
    );

    return Number(rows[0]?.count ?? 0);
  }
}

/** How a COUNT is issued: always {@link runBounded}'s pinned, budget-checked query runner. */
type Executor = (sql: string, params: unknown[]) => Promise<Array<{ count: string }>>;

/** Resolve a type's source table, refusing to silently drop a type we were asked to measure. */
function sourceFor(entityType: IndexableEntity): EntitySource {
  const source = ENTITY_SOURCE_MAP[entityType];

  if (source == null) {
    // Defensive: the compile-time guard in entitySourceMap already prevents
    // this, but never silently drop a type we were asked to measure.
    throw new Error(`No source mapping for entity type "${entityType}"`);
  }

  return source;
}

/**
 * Coverage ratio below which a type with source rows is flagged `underThreshold`
 * (meaningfully under-indexed). 0.9 = at least 90% of rows must carry an
 * embedding before a type is considered adequately covered.
 */
export const UNDER_COVERAGE_THRESHOLD = 0.9;

/**
 * Relative gap between a type's embedding count and its vector count above
 * which the two halves of the index are treated as disagreeing. 0.05 leaves
 * room for the ordinary in-flight skew (one listener has written the vector but
 * not yet the embedding) while still catching a whole-type hole.
 */
export const INDEX_DIVERGENCE_THRESHOLD = 0.05;

/**
 * Per-COUNT ceiling for either sweep. Generous — the plain `count(*)` on the
 * communications hypertable is ~1-2s at 1M rows — but finite, so a
 * pathological plan aborts instead of pinning a pooled connection all night.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * Wall-clock ceiling for a whole nightly health sweep, checked between counts.
 * The per-COUNT timeout above bounds one statement; only this bounds the RUN,
 * and the run is what holds the pooled connection.
 *
 * Ten minutes is deliberately far above the real cost (54 index-served counts,
 * seconds to ~2 minutes even on a million-row corpus) — a budget tight enough
 * to trip on a merely slow appliance would trade a long-held connection for a
 * sweep that never succeeds, and for a nightly measurement losing it entirely
 * is the worse failure.
 */
export const DEFAULT_HEALTH_SWEEP_BUDGET_MS = 600_000;

/**
 * Wall-clock ceiling for a coverage sweep. Far tighter than the nightly one
 * above because the trade runs the other way: this sweep answers an HTTP
 * request, so past a minute there is no caller left to receive the
 * measurement, and holding a pooled connection for it buys nobody anything.
 * The caller can simply ask again, which the nightly cron cannot.
 */
export const DEFAULT_COVERAGE_BUDGET_MS = 60_000;

/**
 * Derive a {@link EntityCoverage} from raw counts. Extracted (and exported) so
 * the ratio/alarm rules are unit-testable without a DataSource:
 *   - ratio is embedded/total, clamped to [0, 1]; 0 when total is 0.
 *   - alarm trips only when total > 0 AND embedded === 0 (a total hole).
 *   - underThreshold trips when total > 0 AND ratio < `threshold` (partial
 *     coverage — the gap a zero-only alarm misses). A superset of alarm. Never
 *     trips for an empty type (nothing to embed).
 */
export function buildCoverage(
  total: number,
  embedded: number,
  threshold: number = UNDER_COVERAGE_THRESHOLD,
): EntityCoverage {
  const ratio = total > 0 ? Math.min(Math.max(embedded / total, 0), 1) : 0;
  const alarm = total > 0 && embedded === 0;
  const underThreshold = total > 0 && ratio < threshold;

  return { total, embedded, ratio, alarm, underThreshold };
}

/**
 * Derive an {@link EntityIndexHealth} from raw counts. Pure, so the alarm rules
 * are unit-testable without a DataSource:
 *   - every {@link buildCoverage} rule still holds for the embedding side.
 *   - vectorAlarm trips only when total > 0 AND vectored === 0 — the type
 *     cannot be a search candidate at all.
 *   - divergence is the relative gap between the two index counts; divergent
 *     trips when the type has source rows and that gap exceeds
 *     `divergenceThreshold`. An empty type never diverges.
 */
export function buildIndexHealth(
  total: number,
  embedded: number,
  vectored: number,
  threshold: number = UNDER_COVERAGE_THRESHOLD,
  divergenceThreshold: number = INDEX_DIVERGENCE_THRESHOLD,
): EntityIndexHealth {
  const coverage = buildCoverage(total, embedded, threshold);
  const vectorRatio = total > 0 ? Math.min(Math.max(vectored / total, 0), 1) : 0;
  const peak = Math.max(embedded, vectored);
  const divergence = peak > 0 ? Math.abs(embedded - vectored) / peak : 0;

  return {
    ...coverage,
    vectored,
    vectorRatio,
    vectorAlarm: total > 0 && vectored === 0,
    divergence,
    divergent: total > 0 && divergence > divergenceThreshold,
  };
}

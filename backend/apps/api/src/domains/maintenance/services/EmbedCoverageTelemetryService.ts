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
 * Embed-coverage telemetry (memory-and-search plan, gap G2 / issue #1239).
 *
 * Nothing currently monitors how much of the corpus is actually embedded, so
 * coverage holes (content 0/366,862, event 2,743/42,376 = 6.5%) went unnoticed
 * until measured by hand for PR #1605. This service computes, per search
 * `entity_type`, the ratio of source rows that carry a `ci_search.embeddings`
 * row, and flags any type that has data but zero embeddings.
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
   */
  async computeCoverage(entityTypes?: IndexableEntity[]): Promise<EmbedCoverageReport> {
    const types = entityTypes ?? [...INDEXABLE_ENTITIES];

    const perType: Record<string, EntityCoverage> = {};
    const alarms: string[] = [];
    const underThreshold: string[] = [];

    for (const entityType of types) {
      const source = ENTITY_SOURCE_MAP[entityType];

      if (source == null) {
        // Defensive: the compile-time guard in entitySourceMap already prevents
        // this, but never silently drop a type we were asked to measure.
        throw new Error(`No source mapping for entity type "${entityType}"`);
      }

      const [total, embedded] = await Promise.all([this.countSource(source), this.countEmbedded(entityType)]);

      const coverage = buildCoverage(total, embedded);
      perType[entityType] = coverage;

      if (coverage.alarm) {
        alarms.push(entityType);
      }

      if (coverage.underThreshold) {
        underThreshold.push(entityType);
      }
    }

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

  /** Source rows for this type, honouring the source map's discriminator. */
  private async countSource(source: EntitySource): Promise<number> {
    const sourceRef = `"${source.schema}"."${source.table}"`;

    const discriminatorClause = source.discriminator ? `WHERE "${source.discriminator.column}" = $1` : '';
    const params = source.discriminator ? [source.discriminator.value] : [];

    const rows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${sourceRef} ${discriminatorClause}`,
      params,
    );

    return Number(rows[0]?.count ?? 0);
  }

  /** `ci_search.embeddings` rows for this entity type (index-served). */
  private async countEmbedded(entityType: IndexableEntity): Promise<number> {
    const rows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::bigint AS count FROM ci_search.embeddings WHERE entity_type = $1`,
      [entityType],
    );

    return Number(rows[0]?.count ?? 0);
  }
}

/**
 * Coverage ratio below which a type with source rows is flagged `underThreshold`
 * (meaningfully under-indexed). 0.9 = at least 90% of rows must carry an
 * embedding before a type is considered adequately covered.
 */
export const UNDER_COVERAGE_THRESHOLD = 0.9;

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

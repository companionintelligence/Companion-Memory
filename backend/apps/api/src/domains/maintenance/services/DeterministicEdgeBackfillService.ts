import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { GraphDeltaWriter } from '@ci/domains/memory';

import {
  DETERMINISTIC_EDGE_RULES,
  type DeterministicEdgeRule,
  type DeterministicEdgeSource,
} from './deterministicEdgeMatrix';

/** Default window width. Wider than the link backfill's 7d because each pass is
 * a read + insert-elsewhere (no hypertable decompression), so the per-window
 * cost is low and fewer windows means fewer round-trips over a long history. */
const DEFAULT_WINDOW_DAYS = 30;

/** graph_deltas rows written per INSERT statement (14 binds each — stays well
 * under Postgres' 65535 bind-param budget). */
const DELTA_CHUNK_SIZE = 1000;

export interface DeterministicEdgeBackfillProgress {
  /** Rule currently being materialized. */
  rule: string;
  /** Rules fully completed so far. */
  rulesDone: number;
  rulesTotal: number;
  /** Edges created so far across ALL rules (cumulative). */
  edgesCreated: number;
  /** Windows committed for the CURRENT rule. */
  windowsDone: number;
  windowsTotal: number;
}

export interface DeterministicEdgeBackfillOptions {
  /** Only consider source rows with time in [startTime, endTime). When omitted
   * each rule derives its own bounds from its candidates' MIN/MAX(time). */
  startTime?: Date;
  endTime?: Date;
  /** Window width in days (default 30). */
  windowDays?: number;
  /** Restrict to these rule ids (default: the whole matrix). */
  rules?: string[];
  /** Invoked once per committed window with cumulative counts. */
  onProgress?: (progress: DeterministicEdgeBackfillProgress) => void;
}

export interface DeterministicEdgeRuleResult {
  rule: string;
  relationshipType: string;
  /** Edges actually inserted (conflicts with existing edges don't count). */
  edgesCreated: number;
  windows: number;
  /** The [start, end) actually scanned, or null when the rule had no candidates. */
  range: { start: string; end: string } | null;
}

export interface DeterministicEdgeBackfillResult {
  edgesCreated: number;
  rules: DeterministicEdgeRuleResult[];
}

interface InsertedEdgeRow {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
}

/**
 * RE-RUNNABLE deterministic edge materialization.
 *
 * Projects the deterministic-edge matrix ({@link DETERMINISTIC_EDGE_RULES})
 * into `ci.relationships`: each rule turns one already-resolved linkage column
 * (communications' from/to, events' organizer/participants/location) into
 * graph edges the traversal can actually walk. Both endpoints are resolved
 * through their merge tombstone (`entities.merged_into_entity_id`, one hop by
 * PersonMergeService's path-compression invariant) so edges land on the
 * canonical, deduplicated person/place, and inactive un-merged entities are
 * skipped.
 *
 * Idempotent: the directed (from, to, type) partial unique index collapses
 * re-runs via ON CONFLICT DO NOTHING, and only genuinely-new edges are
 * counted and recorded into `ci.graph_deltas` (same-transaction, since the DB
 * triggers were dropped in favour of app-written deltas).
 *
 * Hypertable safety: `ci.communications` reads are bounded per time window so
 * chunk exclusion applies; `ci.events` is a plain table but rides the same
 * windowing to bound per-transaction delta volume.
 *
 * Operator-invoked via POST /api/maintenance/materialize-edges and the
 * orchestrator's `materialize_edges` leg (after link_communications /
 * link_events, which fill the columns this projects). Never auto-run.
 */
@Injectable()
export class DeterministicEdgeBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly graphDeltaWriter: GraphDeltaWriter,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DeterministicEdgeBackfillService.name);
  }

  async backfill(
    userId: string,
    options: DeterministicEdgeBackfillOptions = {},
  ): Promise<DeterministicEdgeBackfillResult> {
    const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const requestedRules = this.resolveRules(options.rules);

    const ruleResults: DeterministicEdgeRuleResult[] = [];
    let edgesCreated = 0;
    let rulesDone = 0;

    for (const rule of requestedRules) {
      const ruleResult = await this.backfillRule(userId, rule, {
        startTime: options.startTime,
        endTime: options.endTime,
        windowDays,
        onWindow: (windowsDone, windowsTotal, ruleEdges) => {
          options.onProgress?.({
            rule: rule.id,
            rulesDone,
            rulesTotal: requestedRules.length,
            edgesCreated: edgesCreated + ruleEdges,
            windowsDone,
            windowsTotal,
          });
        },
      });

      edgesCreated += ruleResult.edgesCreated;
      rulesDone += 1;
      ruleResults.push(ruleResult);
    }

    this.logger.log('Deterministic edge backfill complete', {
      userId,
      edgesCreated,
      rules: Object.fromEntries(ruleResults.map((r) => [r.rule, r.edgesCreated])),
    });

    return { edgesCreated, rules: ruleResults };
  }

  /**
   * Project every matrix rule of ONE source table over an explicit set of
   * source-row ids — the pipeline-slice entry point (`promote.edge_*` stages).
   *
   * Same projection SQL as the windowed backfill, scoped by id instead of by
   * time: canonical (merge-tombstone) resolution, ON CONFLICT idempotency and
   * same-transaction graph deltas all included. Returns the number of edges
   * actually created (re-projection of an already-materialized row is 0).
   */
  async materializeForSourceIds(
    userId: string,
    source: DeterministicEdgeSource,
    ids: string[],
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    let edgesCreated = 0;

    for (const rule of DETERMINISTIC_EDGE_RULES) {
      if (rule.source !== source) {
        continue;
      }

      edgesCreated += await this.dataSource.transaction(async (manager) => {
        const inserted = await this.projectRule(manager, rule, {
          scopeClause: `AND ${rule.idColumn} = ANY($2::uuid[])`,
          scopeParams: [ids],
          userId,
        });

        await this.recordDeltas(manager, rule, userId, inserted);

        return inserted.length;
      });
    }

    return edgesCreated;
  }

  /** The requested subset of the matrix, in matrix order; unknown ids are
   * ignored (the endpoint's schema already 400s them — this is the belt). */
  private resolveRules(ruleIds?: string[]): DeterministicEdgeRule[] {
    if (!ruleIds || ruleIds.length === 0) {
      return [...DETERMINISTIC_EDGE_RULES];
    }

    const requested = new Set(ruleIds);

    return DETERMINISTIC_EDGE_RULES.filter((rule) => requested.has(rule.id));
  }

  private async backfillRule(
    userId: string,
    rule: DeterministicEdgeRule,
    opts: {
      startTime?: Date;
      endTime?: Date;
      windowDays: number;
      onWindow: (windowsDone: number, windowsTotal: number, ruleEdges: number) => void;
    },
  ): Promise<DeterministicEdgeRuleResult> {
    const bounds = await this.resolveBounds(userId, rule, opts.startTime, opts.endTime);
    if (bounds == null) {
      return {
        rule: rule.id,
        relationshipType: rule.relationshipType,
        edgesCreated: 0,
        windows: 0,
        range: null,
      };
    }

    const { start, end } = bounds;
    const windowMs = opts.windowDays * 24 * 60 * 60 * 1000;
    const windowsTotal = Math.ceil((end.getTime() - start.getTime()) / windowMs);

    let edgesCreated = 0;
    let windows = 0;

    // Newest-first, same stepping as the link backfills: recent windows carry
    // the edges the user is likeliest to be looking at right now.
    let windowEnd = end;
    while (windowEnd > start) {
      const windowStart = new Date(Math.max(start.getTime(), windowEnd.getTime() - windowMs));

      edgesCreated += await this.materializeWindow(userId, rule, windowStart, windowEnd);
      windows += 1;
      opts.onWindow(windows, windowsTotal, edgesCreated);

      windowEnd = windowStart;
    }

    return {
      rule: rule.id,
      relationshipType: rule.relationshipType,
      edgesCreated,
      windows,
      range: { start: start.toISOString(), end: end.toISOString() },
    };
  }

  /** Caller bounds verbatim when both given; otherwise derived from the rule's
   * own candidates' MIN/MAX(time). Null when the rule has no candidates. */
  private async resolveBounds(
    userId: string,
    rule: DeterministicEdgeRule,
    startTime: Date | undefined,
    endTime: Date | undefined,
  ): Promise<{ start: Date; end: Date } | null> {
    if (startTime != null && endTime != null) {
      return startTime <= endTime ? { start: startTime, end: endTime } : null;
    }

    const rows: Array<{ min_time: Date | null; max_time: Date | null }> = await this.dataSource.query(
      `SELECT MIN(${rule.timeColumn}) AS min_time, MAX(${rule.timeColumn}) AS max_time
         FROM ${rule.table}
        WHERE ${rule.userColumn} = $1
          AND ${rule.candidateWhere}`,
      [userId],
    );

    const minTime = rows[0]?.min_time ?? null;
    const maxTime = rows[0]?.max_time ?? null;
    if (minTime == null || maxTime == null) {
      return null;
    }

    const start = startTime ?? new Date(minTime);
    // +1ms so the inclusive MAX(time) row falls inside a half-open window.
    const end = endTime ?? new Date(new Date(maxTime).getTime() + 1);

    return start <= end ? { start, end } : null;
  }

  /**
   * One bounded window: project the rule's (from, to) pairs, insert the missing
   * edges, and record a graph delta for each row actually created — all in one
   * transaction.
   */
  private async materializeWindow(
    userId: string,
    rule: DeterministicEdgeRule,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const inserted = await this.projectRule(manager, rule, {
        scopeClause: `AND ${rule.timeColumn} >= $2 AND ${rule.timeColumn} < $3`,
        scopeParams: [windowStart.toISOString(), windowEnd.toISOString()],
        userId,
      });

      await this.recordDeltas(manager, rule, userId, inserted);

      return inserted.length;
    });
  }

  /**
   * THE PROJECTION — one rule of the matrix, over one scope (a time window or
   * an explicit id set), inside the caller's transaction.
   *
   * The DISTINCT collapses duplicate pairs inside the scope (a person can
   * receive many messages, but the directed edge is written once); ON CONFLICT
   * DO NOTHING collapses pairs already materialized by an earlier run against
   * the directed-uniqueness partial index. The tombstone COALESCE re-points
   * both endpoints at their merge survivor, and the is_active/merged guard
   * drops edges to deleted (un-merged) entities. The <> guard mirrors the
   * table's no_self_references CHECK — a merge can collapse both endpoints
   * onto the same survivor.
   *
   * `scope.scopeClause` references params starting at $2 (its values ride in
   * `scope.scopeParams`, in order); the rule's type/strength/properties binds
   * are numbered after them.
   */
  private async projectRule(
    manager: { query: (sql: string, params?: unknown[]) => Promise<InsertedEdgeRow[]> },
    rule: DeterministicEdgeRule,
    scope: { scopeClause: string; scopeParams: unknown[]; userId: string },
  ): Promise<InsertedEdgeRow[]> {
    const properties = JSON.stringify({ ...rule.properties, rule: rule.id });
    const typeIdx = 2 + scope.scopeParams.length;

    return manager.query(
      `WITH pairs AS (
         SELECT ${rule.fromIdExpr} AS from_id, ${rule.toIdExpr} AS to_id
           FROM ${rule.table}
          WHERE ${rule.userColumn} = $1
            ${scope.scopeClause}
            AND ${rule.candidateWhere}
       ),
       resolved AS (
         SELECT DISTINCT
                COALESCE(ef.merged_into_entity_id, ef.entity_id) AS from_id,
                ef.entity_type AS from_type,
                COALESCE(et.merged_into_entity_id, et.entity_id) AS to_id,
                et.entity_type AS to_type
           FROM pairs p
           JOIN ci.entities ef
             ON ef.entity_id = p.from_id
            AND ef.owner_user_id = $1
            AND (ef.is_active = TRUE OR ef.merged_into_entity_id IS NOT NULL)
           JOIN ci.entities et
             ON et.entity_id = p.to_id
            AND et.owner_user_id = $1
            AND (et.is_active = TRUE OR et.merged_into_entity_id IS NOT NULL)
          WHERE COALESCE(ef.merged_into_entity_id, ef.entity_id)
                <> COALESCE(et.merged_into_entity_id, et.entity_id)
       )
       INSERT INTO ci.relationships
         (from_entity_id, to_entity_id, relationship_type, strength, properties,
          owner_user_id, from_entity_type, to_entity_type)
       SELECT from_id, to_id, $${typeIdx}, $${typeIdx + 1}, $${typeIdx + 2}::jsonb, $1, from_type, to_type
         FROM resolved
       ON CONFLICT DO NOTHING
       RETURNING relationship_id, from_entity_id, to_entity_id`,
      [scope.userId, ...scope.scopeParams, rule.relationshipType, rule.strength, properties],
    );
  }

  /**
   * App-written change trail (the DB triggers are gone). Same transaction as
   * the insert so a delta never exists without its edge; chunked to stay
   * inside the bind-param budget.
   */
  private async recordDeltas(
    manager: Parameters<GraphDeltaWriter['recordMany']>[1],
    rule: DeterministicEdgeRule,
    userId: string,
    inserted: InsertedEdgeRow[],
  ): Promise<void> {
    for (let offset = 0; offset < inserted.length; offset += DELTA_CHUNK_SIZE) {
      const chunk = inserted.slice(offset, offset + DELTA_CHUNK_SIZE);
      await this.graphDeltaWriter.recordMany(
        chunk.map((row) => ({
          nodeType: 'relationship' as const,
          changeType: 'created' as const,
          relationshipId: row.relationship_id,
          relationshipType: rule.relationshipType,
          fromEntityId: row.from_entity_id,
          toEntityId: row.to_entity_id,
          ownerUserId: userId,
          changeSource: 'DeterministicEdgeBackfillService',
          changeReason: rule.id,
        })),
        manager,
      );
    }
  }
}

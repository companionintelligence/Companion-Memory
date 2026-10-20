import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { EventService } from '@ci/domains/events';
import {
  RETRIEVAL_POLICY_DEFAULTS,
  RetrievalPolicyService,
  sqlNumberLiteral,
  tsRankWeightsLiteral,
} from '@ci/domains/retrieval-policy';

import { entityTimeSql } from '../entityTime';
import { queryTokenCount, RetrievalQueryEvent, type RetrievalQueryPayload } from '../events';
import { buildPromptQuery, type BuildPromptQueryOptions } from '../promptQuery';
import type { EntityIdentifier, IndexableEntity, PromptSearchResult } from '../types';

/**
 * ═══ Where the retrieval knobs live now ═══
 *
 * `TS_RANK_WEIGHTS` and `EMBEDDING_BOOST_FACTOR` used to be module-level
 * literals here. They are fields of the appliance's versioned retrieval policy
 * (`ci.retrieval_policy`, read through {@link RetrievalPolicyService}), so a
 * measured tuning result can be promoted without an edit-rebuild-redeploy.
 *
 * The baseline is unchanged and still stated in code, as
 * `RETRIEVAL_POLICY_DEFAULTS` in `domains/retrieval-policy/constants.ts`:
 *
 * - ts_rank weights `{D, C, B, A}` = `{0.1, 0.2, 0.4, 1.0}` — D lowest priority,
 *   A highest. A (ingestion weight 10+) is names/titles/primary identifiers, B
 *   (4-7) descriptions and summaries, C (2-3) categories/types/URLs, D (<2)
 *   properties and bulk content.
 * - embedding boost 0.5 — the keyword score is multiplied by
 *   `(1 + boost * similarity)`, so with similarity in [0,1] a score can rise by
 *   up to 50%.
 *
 * Version 1 of the table is seeded with exactly those numbers and the service
 * falls back to them when the table is empty or unreachable, so behaviour is
 * identical until somebody promotes a v2.
 */

/**
 * Default cosine-distance floor for `searchMessages` (naive-RAG message channel).
 *
 * Expressed as cosine DISTANCE (embedding <=> query), so smaller = more similar.
 * 0.5 matches `semanticSearch`'s `distanceThreshold` — anything the semantic mode
 * would already reject as too far is now also rejected here. This closes gap G5
 * (memory-and-search plan §3): before the floor, `searchMessages` always unioned
 * the top-K raw fragments regardless of similarity, injecting recall noise on
 * sparse corpora where even the closest fragment is unrelated. See plan §5
 * ("`searchMessages` floor → Yes, start at cosine-distance 0.5").
 */
const MESSAGE_DISTANCE_FLOOR = 0.5;

/**
 * Default top-K for `searchMessages`. K is corpus-dependent: dense corpora
 * benefit from a larger union, sparse ones from a smaller one. The floor above
 * does most of the noise-suppression work, so K stays at the historical 10 as
 * the safe default; deployments tune it via the `maxResults` argument once the
 * benchmark (PR #1587) is the gate. See plan §4 "Recall tuning: ... per-corpus K".
 */
const MESSAGE_DEFAULT_K = 10;

/**
 * BASELINE cosine-distance floor for `semanticSearch`. Rows at or beyond it are
 * not results at any `ef_search`, so the recall probe's exact leg has to apply
 * the same floor or it would count rows production would never return.
 *
 * The live value is `retrievalPolicy.semanticDistanceThreshold`; this is the
 * value it falls back to, re-exported from `RETRIEVAL_POLICY_DEFAULTS` so there
 * is one literal rather than two that agree today. Callers that need the number
 * without a policy read (`RecallProbeService`) keep using this.
 */
export const SEMANTIC_DISTANCE_THRESHOLD = RETRIEVAL_POLICY_DEFAULTS.semanticDistanceThreshold;

/**
 * BASELINE LIMIT for `semanticSearch`, and therefore the k recall is measured
 * at. Live value: `retrievalPolicy.semanticMaxResults`.
 */
export const SEMANTIC_MAX_RESULTS = RETRIEVAL_POLICY_DEFAULTS.semanticMaxResults;

/**
 * pgvector's own default for `hnsw.ef_search`, restated here because this
 * appliance never sets it: a repo-wide grep finds the parameter only in
 * `RecallProbeService`'s `SET LOCAL` (which dies with its own transaction),
 * in migration prose, and here. Every production semantic query therefore runs
 * the index at 40.
 *
 * An HNSW scan keeps a candidate list of `ef_search` nodes and can return at
 * most that many rows — and it returns them BEFORE `user_id`, the type filter
 * and the distance floor discard any of them (see
 * {@link SearchService.buildSemanticSearchPlan}, where all three sit outside
 * the ORDER BY). A statement whose `LIMIT k` exceeds this budget therefore
 * cannot fill its own LIMIT even against a corpus with nothing to filter out:
 * the shortfall is arithmetic, not a property of the data.
 *
 * This constant is NOT a tuning decision. It is a restatement of what the index
 * will do at its current setting, so that a caller asking for k rows can be
 * checked against it. What `ef_search` this corpus SHOULD run at — a question
 * about post-filter selectivity, latency and recall — is what
 * `ci.recall_probe_results` (migration `20260821223302`) was built to answer,
 * and nothing here pre-empts it.
 */
export const HNSW_DEFAULT_EF_SEARCH = 40;

/** pgvector's hard ceiling on `hnsw.ef_search`; setting past it raises. */
export const HNSW_MAX_EF_SEARCH = 1000;

/**
 * The candidate budget a `LIMIT k` HNSW request needs to be answerable at all.
 *
 * `max(default, k)`, clamped to pgvector's ceiling. This is the MINIMUM
 * coherent value, not a recall target: at `ef_search = k` the index can still
 * only just produce k candidates, and any filter that rejects one of them
 * shortens the result. Asking for more than that on every query would be the
 * corpus-wide tuning decision the recall probe owns, so this deliberately stops
 * at "the request is satisfiable" and goes no further.
 *
 * Below the default it returns the default, so a caller asking for fewer rows
 * than the index already offers needs no `SET` at all and is left untouched.
 */
export function requiredEfSearch(maxResults: number): number {
  const k = Math.trunc(maxResults);

  if (!Number.isFinite(k) || k <= HNSW_DEFAULT_EF_SEARCH) {
    return HNSW_DEFAULT_EF_SEARCH;
  }

  return Math.min(k, HNSW_MAX_EF_SEARCH);
}

/**
 * Default ceiling on how many rows a lexeme may match and still be allowed to
 * anchor {@link SearchService.searchAnchored}.
 *
 * Measured on the reference 907k-row corpus, over the questions the answer
 * inference asks. Document frequency is what separates a word that NAMES
 * something in the archive from a word the archive is simply full of:
 *
 *   cuisine 58 · favorite 426 · sports 265 · languages 267
 *   speak 903 | follow 1,175 · learning 1,648 · food 2,022 · city 3,848 · live 8,302
 *
 * Everything left of the bar is a usable anchor; everything right of it is a
 * lexical collision waiting to happen — "What city do you live in?" anchored on
 * `city` returns Suffragette City and Midnight City, because in a corpus with
 * 3,848 rows carrying the word, matching it says nothing. A question whose every
 * term lands right of the bar gets NO lexical channel at all, which is the
 * correct answer: there is no keyword in it worth searching on.
 *
 * The ceiling is absolute rather than a fraction of the corpus so it needs no
 * `count(*)` over ci_search.vectors (which has no user_id index) to evaluate,
 * and so the bounded count below is O(ceiling) instead of O(corpus). On a much
 * smaller archive it is proportionally permissive, which is the right direction
 * to be wrong in: with little indexed, recall matters more than precision.
 */
const ANCHOR_MAX_MATCHES = 1000;

/** Everything {@link SearchService.buildSemanticSearchPlan} needs besides the vector. */
export type SemanticSearchScope = {
  maxResults?: number;
  includeTypes?: IndexableEntity[];
  excludeTypes?: IndexableEntity[];
  /**
   * Cosine-distance floor, overriding {@link SEMANTIC_DISTANCE_THRESHOLD}.
   * Smaller = stricter. Callers that need a tighter relevance bar than plain
   * search (evidence retrieval, where a merely-word-adjacent row is worse than
   * no row) pass one; everyone else inherits the default and is unaffected.
   */
  distanceThreshold?: number;
};

/** Options for {@link SearchService.searchAnchored}. */
export type AnchoredSearchOptions = {
  maxResults?: number;
  /** See {@link ANCHOR_MAX_MATCHES}. */
  maxAnchorMatches?: number;
  includeTypes?: IndexableEntity[];
  excludeTypes?: IndexableEntity[];
};

/** One semantic statement plus its bind parameters, ready to run on any connection. */
export type SemanticSearchPlan = {
  sql: string;
  params: (number | string | string[])[];
  /**
   * The resolved `LIMIT` this statement carries — the k the HNSW index is being
   * asked for, after the caller's `maxResults` and the default have been folded
   * together. Reported rather than re-derived so that whoever has to reconcile
   * it with a candidate budget (see {@link requiredEfSearch}) reads the number
   * that is actually in the SQL, not a second computation of it.
   */
  maxResults: number;
};

type ScoredRowResult = {
  entity_id: string;
  entity_type: string;
  score: string;
};

type ScoredSearchResult = EntityIdentifier<IndexableEntity> & {
  score: number;
};

type BaseSearchOptions = {
  query: string;
  /**
   * Search mode:
   * - 'keyword': Fast text search using weighted tsvectors (no embedding call)
   * - 'semantic': Conceptual search using embeddings (requires embedding call)
   * - 'boosted': Keyword search with embedding similarity boost (requires embedding call)
   * - 'hybrid': Combines semantic and keyword with score fusion (requires embedding call)
   * - 'auto': Automatically selects mode based on query characteristics
   */
  mode?: 'semantic' | 'keyword' | 'boosted' | 'hybrid' | 'auto';
  maxResults?: number;
  /** Semantic modes only. See {@link SemanticSearchScope.distanceThreshold}. */
  distanceThreshold?: number;
  /**
   * Keep only rows whose own time ({@link entityTimeSql}) is on or after `since` / on or before
   * `until`. Lexical modes only (`keyword`, `boosted`): a nearest-neighbour list has no "every
   * match since Tuesday", so the semantic modes ignore both.
   */
  since?: Date;
  until?: Date;
  /**
   * `recent` orders the page by each row's own time, newest first, nulls last, rank as the
   * tie-break; the default is rank. Lexical modes only, like `since` / `until`.
   */
  sort?: 'relevance' | 'recent';
  /**
   * Hybrid fusion strategy:
   * - `'weighted'` (default): 50/50 normalized score average.
   * - `'rrf'`: Reciprocal Rank Fusion ($\sum_i \frac{1}{k + \text{rank}_i}$, $k=60$),
   *   which is invariant to outlier `ts_rank` spikes.
   */
  fusionMode?: 'weighted' | 'rrf';
};

export const RRF_DEFAULT_K = 60;

/**
 * Reciprocal Rank Fusion (`knowl` / Cormack et al. pattern): combines ranked
 * lists from heterogeneous retrieval channels (e.g. pgvector cosine similarity
 * and Postgres `ts_rank`) using rank positions rather than raw score magnitudes:
 *
 * $$\text{RRF}(d) = \sum_{L \in \text{lists}} \frac{1}{k + \text{rank}_L(d)}$$
 *
 * where $\text{rank}_L(d) \ge 1$ is the 1-based rank of document $d$ in list $L$.
 */
export function reciprocalRankFusion<T extends { id: string; type: IndexableEntity }>(
  rankedLists: ReadonlyArray<ReadonlyArray<T>>,
  k: number = RRF_DEFAULT_K,
): Array<T & { score: number }> {
  const fusedScores = new Map<string, number>();
  const itemsByKey = new Map<string, T>();

  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const key = `${item.type}:${item.id}`;
      const rank = index + 1;
      fusedScores.set(key, (fusedScores.get(key) ?? 0) + 1 / (k + rank));
      if (!itemsByKey.has(key)) {
        itemsByKey.set(key, item);
      }
    });
  }

  const results: Array<T & { score: number }> = [];
  fusedScores.forEach((score, key) => {
    const item = itemsByKey.get(key)!;
    results.push({ ...item, score });
  });

  return results.sort((a, b) => b.score - a.score);
}

/** The `since` / `until` predicate over {@link entityTimeSql}, bound after `paramOffset - 1` params. */
function buildTimeFilter(
  options: { since?: Date; until?: Date },
  paramOffset: number,
  alias?: string,
): { clause: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const time = entityTimeSql(alias);

  if (options.since) {
    clauses.push(`AND ${time} >= $${paramOffset + params.length}::timestamptz`);
    params.push(options.since.toISOString());
  }

  if (options.until) {
    clauses.push(`AND ${time} <= $${paramOffset + params.length}::timestamptz`);
    params.push(options.until.toISOString());
  }

  return { clause: clauses.join('\n        '), params };
}

/** The ORDER BY a lexical page runs: rank, or each row's own time newest first with rank as the tie-break. */
function lexicalOrderSql(sort: 'relevance' | 'recent' | undefined, alias?: string): string {
  return sort === 'recent' ? `${entityTimeSql(alias)} DESC NULLS LAST, score DESC` : 'score DESC';
}

type SearchOptions =
  | (BaseSearchOptions & { includeTypes: IndexableEntity[]; excludeTypes?: never })
  | (BaseSearchOptions & { excludeTypes: IndexableEntity[]; includeTypes?: never })
  | (BaseSearchOptions & { includeTypes?: never; excludeTypes?: never });

/**
 * A prompt search names its input `prompt` rather than `query`, because it is
 * NOT a query: it is a sentence someone else wrote, and {@link buildPromptQuery}
 * decides what part of it may constrain the owner's memory.
 */
type PromptSearchOptions = BuildPromptQueryOptions & {
  prompt: string;
  maxResults?: number;
  includeTypes?: IndexableEntity[];
  excludeTypes?: IndexableEntity[];
};

/** The strategy {@link SearchService.search} actually ran, after `'auto'` resolved. */
export type SearchModeTaken = 'semantic' | 'keyword' | 'boosted' | 'hybrid';

/**
 * What {@link SearchService.searchPage} returns: the page AND how big the
 * match set behind it is.
 *
 * `search()` hands back a bare array, so a caller cannot tell a set that
 * happens to be exactly `maxResults` long from one that was cut off there —
 * the same blind spot {@link PromptSearchResult} closes for asks. A chat tool
 * that turns a full page into "you have 100 photos of rabbits" states a number
 * that is only the cap. This shape is what lets it say "at least 100" instead,
 * or the exact figure when the mode can count.
 *
 * `totalMatches` is EXACT for the lexical modes (`keyword`, `boosted`): both
 * already rank every matching row before the LIMIT, so `count(*) OVER ()` is
 * free. It is `null` for `semantic` and `hybrid`, where "the match set" is a
 * nearest-neighbour list bounded by the HNSW candidate budget rather than a
 * predicate — there is no honest number to report, only whether the page came
 * back full.
 */
export interface SearchPage {
  items: EntityIdentifier<IndexableEntity>[];
  /** Exact size of the match set before the cap, or `null` when the mode cannot count. */
  totalMatches: number | null;
  /**
   * The page may not be the whole match set: `totalMatches > items.length`,
   * or a full page from a mode that cannot count. "At least", not "exactly".
   */
  truncated: boolean;
  /** The cap that was applied, so a caller can explain the truncation. */
  limit: number;
  modeTaken: SearchModeTaken;
}

/**
 * Options for {@link SearchService.count}: the lexical `WHERE` of a keyword
 * search and nothing else. No mode, because only the lexical predicate has a
 * countable match set; no `maxResults`, because a count is the one thing a cap
 * must not touch.
 *
 * `query` is optional: absent or blank means "everything in scope", which is
 * how "how many photos do I have" is answered — a question with no search
 * term, which a tool that demanded one turned into a validation error
 * (measured live 2026-09-16: the model sent `query: ""` and the turn died).
 */
type CountOptions = { query?: string; since?: Date; until?: Date } & (
  | { includeTypes: IndexableEntity[]; excludeTypes?: never }
  | { excludeTypes: IndexableEntity[]; includeTypes?: never }
  | { includeTypes?: never; excludeTypes?: never }
);

/** A ranked row that may also carry the window count of its whole match set. */
type CountedRowResult = ScoredRowResult & { total_matches?: string | number | null };

/** What each private strategy hands the dispatcher: its rows, its count (if any), and the LIMIT it ran. */
type StrategyResult = {
  results: ScoredSearchResult[];
  totalMatches: number | null;
  limit: number;
};

/** Default page size for the lexical modes; the semantic default is the retrieval policy's. */
const DEFAULT_MAX_RESULTS = 25;

/**
 * The tsquery both lexical modes AND {@link SearchService.count} search on, as
 * one SQL fragment so a count can never disagree with the page it explains.
 *
 * `websearch_to_tsquery` builds an AND-joined query; the `&` → `|` rewrite
 * turns it into an OR so a 2-3 word query like "dog breed" matches an entity
 * whose vector has only one of the tokens (Mochi's vector has 'dog' but not
 * 'breed'). `ts_rank` still rewards entities matching more terms. Single-term
 * queries are unaffected (no `&` to replace); phrase queries (`<->`) and
 * negations (`!`) survive the literal string replace. Expects the query text
 * bound as `$2`.
 */
const KEYWORD_TSQUERY_SQL = `replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery`;

@Injectable()
export class SearchService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly retrievalPolicy: RetrievalPolicyService,
    private readonly events: EventService,
  ) {}

  /**
   * The ts_rank weight literal and embedding boost currently in force, ready to
   * interpolate.
   *
   * Both are written into the statement TEXT rather than bound as parameters —
   * `ts_rank`'s first argument is an array literal and the boost sits inside an
   * arithmetic expression — so the values are formatted by
   * {@link tsRankWeightsLiteral} / {@link sqlNumberLiteral}, which refuse
   * anything that is not a plain bounded number. `RetrievalPolicyService`
   * already validates the row; this is the second gate, and if it ever fires we
   * fall back to the compiled-in baseline rather than build a statement out of
   * whatever the row held.
   */
  private async rankingLiterals(): Promise<{ weights: string; boost: string }> {
    const policy = await this.retrievalPolicy.get();

    try {
      return {
        weights: tsRankWeightsLiteral(policy.tsRankWeights),
        boost: sqlNumberLiteral(policy.embeddingBoostFactor, 'embeddingBoostFactor'),
      };
    } catch {
      return {
        weights: tsRankWeightsLiteral(RETRIEVAL_POLICY_DEFAULTS.tsRankWeights),
        boost: sqlNumberLiteral(RETRIEVAL_POLICY_DEFAULTS.embeddingBoostFactor, 'embeddingBoostFactor'),
      };
    }
  }

  async search(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const page = await this.searchPage(context, options);

    return page.items;
  }

  /**
   * {@link search}, plus how many rows the query matched before the cap.
   *
   * Same dispatch, same telemetry row, same page — `search()` is this with the
   * count thrown away, so the two can never rank differently. Callers that
   * report a NUMBER to someone (the chat tools, which turn a page into "you
   * have N ...") read this; callers that only consume the rows keep `search()`.
   */
  async searchPage(context: UserServiceContext, options: SearchOptions): Promise<SearchPage> {
    const resolvedOptions = this.applyDefaultTypeExclusions(options);
    const { mode = 'auto' } = resolvedOptions;

    // Resolve 'auto' BEFORE dispatching rather than inside a private
    // `autoSearch`, so the mode that actually ran is a value this method holds
    // and can record. Logged as 'auto' it would be unreadable: auto is the
    // default, so it is most calls, and the three strategies it picks between
    // have completely different recall behaviour.
    const modeTaken: SearchModeTaken = mode === 'auto' ? resolveAutoMode(resolvedOptions.query) : mode;
    const startedAt = Date.now();

    let outcome: StrategyResult;

    switch (modeTaken) {
      case 'semantic':
        outcome = await this.semanticSearch(context, resolvedOptions);
        break;

      case 'keyword':
        outcome = await this.keywordSearch(context, resolvedOptions);
        break;

      case 'boosted':
        outcome = await this.boostedKeywordSearch(context, resolvedOptions);
        break;

      case 'hybrid':
        outcome = await this.hybridSearch(context, resolvedOptions);
        break;

      default:
        outcome = await this.keywordSearch(context, resolvedOptions);
        break;
    }

    const { results, totalMatches, limit } = outcome;

    this.recordQuery({
      userId: context.userId,
      caller: 'search',
      modeTaken,
      queryTokenCount: queryTokenCount(resolvedOptions.query),
      includeTypes: resolvedOptions.includeTypes ?? null,
      excludeTypes: resolvedOptions.excludeTypes ?? null,
      resultCount: results.length,
      topScore: topScoreOf(results),
      latencyMs: Date.now() - startedAt,
    });

    return {
      items: results.map((result) => ({
        id: result.id,
        type: result.type,
      })),
      totalMatches,
      // A mode that cannot count can still say when its page came back full:
      // the index may well have had more, so "exactly this many" is the one
      // claim a full page never supports.
      truncated: totalMatches == null ? results.length >= limit : totalMatches > results.length,
      limit,
      modeTaken,
    };
  }

  /**
   * How many indexed rows match `query` lexically — the whole match set, with
   * no LIMIT, no ranking, no rows.
   *
   * Runs the same tsquery and the same type scope as the keyword page
   * ({@link KEYWORD_TSQUERY_SQL}, {@link applyDefaultTypeExclusions}), so the
   * number it returns is the number a `searchPage` of the same query would
   * report as `totalMatches`. It exists so a caller asked "how many" can answer
   * with a `count(*)` against the GIN index instead of paging entities through
   * a context budget that drops most of them.
   *
   * Lexical only, deliberately. A semantic "match set" is a nearest-neighbour
   * list cut at a distance threshold and an HNSW candidate budget; counting it
   * would report a property of the index settings, not of the corpus.
   */
  async count(context: UserServiceContext, options: CountOptions): Promise<number> {
    const query = options.query?.trim() ?? '';
    const resolvedOptions = this.applyDefaultTypeExclusions({ ...options, query });
    const startedAt = Date.now();

    // No term: count the scope itself. The type filter is the only predicate,
    // so it binds as $2 rather than after the query text.
    const { sql, params } =
      query.length > 0
        ? this.buildKeywordCountPlan(context.userId, query, resolvedOptions, options)
        : this.buildScopeCountPlan(context.userId, resolvedOptions, options);

    const rows: { total_matches: string | number }[] = await this.dataSource.query(sql, params);
    const totalMatches = Number(rows[0]?.total_matches ?? 0);

    this.recordQuery({
      userId: context.userId,
      caller: 'search_count',
      // 'scope' is a count with no term — the honest name for a mode that ran
      // no text match at all, and one a dashboard can tell apart from keyword.
      modeTaken: query.length > 0 ? 'keyword' : 'scope',
      queryTokenCount: queryTokenCount(query),
      includeTypes: resolvedOptions.includeTypes ?? null,
      excludeTypes: resolvedOptions.excludeTypes ?? null,
      // The count IS the result: this path returns no rows, so "how many did
      // it produce" and "how many matched" are the same number here.
      resultCount: totalMatches,
      topScore: null,
      latencyMs: Date.now() - startedAt,
    });

    return totalMatches;
  }

  /** `count(*)` of the rows in scope that match `query` lexically — the page's own predicate, uncapped. */
  private buildKeywordCountPlan(
    userId: string,
    query: string,
    scope: Pick<SemanticSearchScope, 'includeTypes' | 'excludeTypes'>,
    window: { since?: Date; until?: Date } = {},
  ): { sql: string; params: (string | string[])[] } {
    const typeFilter = this.buildTypeFilter(scope, 3);
    const timeFilter = buildTimeFilter(window, 3 + (typeFilter.param ? 1 : 0));

    const sql = `
      WITH q AS (
        SELECT ${KEYWORD_TSQUERY_SQL} AS tq
      )
      SELECT count(*) AS total_matches
      FROM
        ci_search.vectors
        CROSS JOIN q
      WHERE user_id = $1
        AND q.tq <> ''::tsquery
        AND vector @@ q.tq
        ${typeFilter.clause}
        ${timeFilter.clause}
    `;

    const params: (string | string[])[] = [userId, query];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    params.push(...timeFilter.params);

    return { sql, params };
  }

  /** `count(*)` of every indexed row in scope, no text match — "how many photos do I have". */
  private buildScopeCountPlan(
    userId: string,
    scope: Pick<SemanticSearchScope, 'includeTypes' | 'excludeTypes'>,
    window: { since?: Date; until?: Date } = {},
  ): { sql: string; params: (string | string[])[] } {
    const typeFilter = this.buildTypeFilter(scope, 2);
    const timeFilter = buildTimeFilter(window, 2 + (typeFilter.param ? 1 : 0));

    const sql = `
      SELECT count(*) AS total_matches
      FROM ci_search.vectors
      WHERE user_id = $1
        ${typeFilter.clause}
        ${timeFilter.clause}
    `;

    const params: (string | string[])[] = [userId];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    params.push(...timeFilter.params);

    return { sql, params };
  }

  /**
   * Emit one {@link RetrievalQueryEvent} onto the `telemetry` queue, and never
   * wait for it.
   *
   * Not awaited and never rethrown: a search that already produced its answer
   * must not fail, or slow down, because a telemetry row could not be enqueued.
   * The failure is not silent at the queue layer — `PGBossEventService` logs an
   * unknown or suppressed queue itself — so the catch here is the last resort
   * for a genuinely broken connection, which the retrieval path cannot act on
   * anyway.
   */
  private recordQuery(payload: RetrievalQueryPayload): void {
    void this.events.send(RetrievalQueryEvent, payload, { queue: 'telemetry' }).catch(() => undefined);
  }

  /**
   * Keyword search for an ASKER-SUPPLIED question, with precision the owner's
   * own searches do not need.
   *
   * `search({ mode: 'keyword' })` OR-joins every token with no floor, so a row
   * matching one common word is indistinguishable from a row that answers the
   * question. That is a recall win when the owner is searching their own memory
   * and a fabrication risk when another person is asking: see
   * {@link buildPromptQuery} for the measured cases ("Have you seen <invented
   * name>?" → 297 matches, all on 'seen'). This method is a SEPARATE entry point
   * rather than a change to `keywordSearch`, because the tools, activity and
   * planning domains all depend on the loose behaviour and none of them is
   * disclosing anything to a third party.
   *
   * The rebuilt query is `AND(required phrases) & OR(alternative terms)`:
   * anything the asker NAMED has to be there, anything they merely mentioned is
   * an alternative. A prompt that yields no groups at all matches NOTHING —
   * failing closed is the whole point, because the caller of an ask executor
   * turns an empty result into "no" and a non-empty one into "yes".
   *
   * Unlike the other search methods this one reports {@link
   * PromptSearchResult.totalMatches}, so a saturated result set is
   * distinguishable from an exact one. A count answer that silently stops at the
   * cap states a number that is not true.
   */
  async searchPrompt(context: UserServiceContext, options: PromptSearchOptions): Promise<PromptSearchResult> {
    const { prompt, maxResults = 25 } = options;
    const groups = buildPromptQuery(prompt, { subjectIsName: options.subjectIsName });
    const limit = Math.max(1, Math.trunc(maxResults));
    const startedAt = Date.now();

    // No groups means the prompt named nothing. Short-circuit rather than send a
    // query with an empty tsquery: `vector @@ ''::tsquery` is a NULL comparison
    // that already returns no rows, but relying on that makes "asked nothing"
    // and "asked for everything" one code path, and only one of them is safe.
    if (groups.length === 0) {
      // Recorded, not skipped. "The prompt named nothing we could search on" is
      // a zero-result retrieval like any other, and it is the one an operator
      // most wants counted: it is the shape a failing ask executor takes.
      this.recordQuery({
        userId: context.userId,
        caller: 'search_prompt',
        modeTaken: 'prompt',
        queryTokenCount: queryTokenCount(prompt),
        includeTypes: options.includeTypes ?? null,
        excludeTypes: options.excludeTypes ?? null,
        resultCount: 0,
        topScore: null,
        latencyMs: Date.now() - startedAt,
      });

      return { items: [], totalMatches: 0, truncated: false, limit };
    }

    const resolvedOptions = this.applyDefaultTypeExclusions({
      query: prompt,
      ...(options.includeTypes ? { includeTypes: options.includeTypes } : {}),
      ...(options.excludeTypes ? { excludeTypes: options.excludeTypes } : {}),
    } as SearchOptions);

    const typeFilter = this.buildTypeFilter(resolvedOptions, 4, 'v');
    const { weights } = await this.rankingLiterals();

    // Each group's text crosses as a PARAMETER and is turned into a tsquery by
    // Postgres (`phraseto_tsquery` / `plainto_tsquery`), never by concatenating
    // asker text into SQL. The later `string_agg(tq::text, ...)` re-parses only
    // Postgres's OWN canonical tsquery output, which round-trips exactly — so
    // hostile punctuation in the prompt can reach the parser but never the
    // statement. `phraseto_tsquery` is what makes a name a name: it emits
    // `'david' <-> 'miller'`, exact adjacency, so a corpus holding Steve Miller
    // does not answer a question about David Miller.
    const sql = `
      WITH parts AS (
        SELECT
          s.kind,
          CASE
            WHEN s.kind = 'phrase' THEN phraseto_tsquery('english', s.txt)
            ELSE plainto_tsquery('english', s.txt)
          END AS tq
        FROM unnest($2::text[], $3::text[]) AS s(txt, kind)
      ),
      kept AS (
        SELECT kind, tq FROM parts WHERE tq <> ''::tsquery
      ),
      grouped AS (
        SELECT
          (SELECT string_agg(tq::text, ' & ') FROM kept WHERE kind = 'phrase') AS phrases,
          (SELECT string_agg(tq::text, ' | ') FROM kept WHERE kind = 'term') AS terms
      ),
      q AS (
        SELECT (
          CASE
            WHEN phrases IS NOT NULL AND terms IS NOT NULL
              THEN '(' || phrases || ') & (' || terms || ')'
            WHEN phrases IS NOT NULL THEN phrases
            ELSE terms
          END
        )::tsquery AS tq
        FROM grouped
      )
      SELECT
        v.entity_id,
        v.entity_type,
        ts_rank('${weights}', v.vector, q.tq) AS score,
        count(*) OVER () AS total_matches
      FROM
        ci_search.vectors v
        CROSS JOIN q
      WHERE v.user_id = $1
        AND q.tq IS NOT NULL
        AND v.vector @@ q.tq
        ${typeFilter.clause}
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    const params: (string | string[])[] = [
      context.userId,
      groups.map((group) => group.text),
      groups.map((group) => group.kind),
    ];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    const rows: (ScoredRowResult & { total_matches: string })[] = await this.dataSource.query(sql, params);

    // `count(*) OVER ()` is evaluated after WHERE and before LIMIT, so it is the
    // TRUE size of the match set, not the truncated page. Every row carries the
    // same value; zero rows means zero matches.
    const totalMatches = rows.length > 0 ? Number(rows[0].total_matches) : 0;

    this.recordQuery({
      userId: context.userId,
      caller: 'search_prompt',
      modeTaken: 'prompt',
      queryTokenCount: queryTokenCount(prompt),
      includeTypes: resolvedOptions.includeTypes ?? null,
      excludeTypes: resolvedOptions.excludeTypes ?? null,
      // The PAGE size, not `totalMatches`: every other caller records what it
      // handed back, and a zero_result rate computed over a mixture of the two
      // would mean nothing.
      resultCount: rows.length,
      topScore: rows.length > 0 ? Number(rows[0].score) : null,
      latencyMs: Date.now() - startedAt,
    });

    return {
      items: rows.map((row) => ({
        id: row.entity_id,
        type: row.entity_type as IndexableEntity,
      })),
      totalMatches,
      truncated: totalMatches > rows.length,
      limit,
    };
  }

  /**
   * Vector search over raw message embeddings (entity_type = 'message') — the
   * "naive RAG" retrieval channel that complements entity/graph search. Source
   * messages carry detail the terse entity serialisation drops, so surfacing the
   * closest raw fragments alongside the graph lifts recall (see RecallService).
   *
   * Cosine distance (<=>), matching semanticSearch — nomic embeddings are
   * unnormalised, so L2 is meaningless here. Top-K by similarity, gated by a
   * cosine-distance floor so fragments the semantic mode would reject as too far
   * are dropped instead of padding the union with noise (gap G5). Callers union
   * whatever survives the floor and let the answerer filter the rest.
   *
   * @param maxResults top-K cap (corpus-tunable; default {@link MESSAGE_DEFAULT_K})
   * @param distanceFloor max cosine distance to admit (default
   *   {@link MESSAGE_DISTANCE_FLOOR}); rows with `embedding <=> query >= floor`
   *   are excluded. Pass a larger value to loosen recall on paraphrase-heavy
   *   corpora, a smaller one to tighten precision on sparse corpora.
   */
  async searchMessages(
    context: UserServiceContext,
    query: string,
    maxResults = MESSAGE_DEFAULT_K,
    distanceFloor = MESSAGE_DISTANCE_FLOOR,
  ): Promise<{ id: string; score: number }[]> {
    const startedAt = Date.now();
    const vector = await this.embeddingGenerationService.generateEmbeddingString(query);

    // ORDER BY the raw distance operator (ascending) — NOT `1 - (embedding <=> $2)
    // DESC` — so the planner can use the HNSW index (embeddings_embedding_hnsw_idx,
    // vector_cosine_ops). HNSW only accelerates `ORDER BY col <=> const ASC LIMIT k`;
    // ordering by the derived `score DESC` is mathematically identical but opaque to
    // the planner, forcing a full Seq Scan + Sort. `embedding IS NOT NULL` matches
    // the index's partial predicate (the column is nullable). Nearest-distance-first
    // == highest-similarity-first, so the returned order is unchanged. See the KNN
    // index-usage finding: without this, semantic search full-scans at corpus scale.
    const sql = `
      SELECT entity_id, 1 - (embedding <=> $2) AS score
      FROM ci_search.embeddings
      WHERE user_id = $1
        AND entity_type = 'message'
        AND embedding IS NOT NULL
        AND (embedding <=> $2) < $3::double precision
      ORDER BY embedding <=> $2
      LIMIT ${maxResults}
    `;

    const rows = await this.dataSource.query(sql, [context.userId, vector, distanceFloor]);

    const hits = rows.map((row: { entity_id: string; score: string }) => ({
      id: row.entity_id,
      score: parseFloat(row.score),
    }));

    this.recordQuery({
      userId: context.userId,
      caller: 'search_messages',
      modeTaken: 'semantic',
      queryTokenCount: queryTokenCount(query),
      // This channel is 'message' BY CONSTRUCTION (the predicate is in the SQL,
      // not in an option), which is precisely why it is recorded as an include:
      // it is the one retrieval path that reads the type every other path
      // excludes by default, so a reader comparing its zero-result rate against
      // `search`'s is comparing two different corpora.
      includeTypes: ['message'],
      excludeTypes: null,
      resultCount: hits.length,
      topScore: topScoreOf(hits),
      latencyMs: Date.now() - startedAt,
    });

    return hits;
  }

  /**
   * Lexical retrieval for a natural-language QUESTION, anchored on the one word
   * in it that is actually selective against this user's corpus, and ordered by
   * how close each match is to the question as a whole.
   *
   * ═══ WHY NOT `mode: 'boosted'` ═══
   *
   * `boostedKeywordSearch` OR-joins every term in the question and ranks by
   * `ts_rank`, with the embedding only as a ≤1.5× multiplier. Both halves of
   * that fail on a question:
   *
   *   1. OR with nothing that has to be true. "What city do you live in?" becomes
   *      `citi | live`, and a corpus holding 3,848 rows with 'city' and 8,302
   *      with 'live' answers it with Suffragette City, Midnight City and
   *      "Tessellate — Live from Spotify Sessions, New York City". Measured, on
   *      the reference corpus: the entire top-8 was song titles.
   *   2. `ts_rank` with no length normalisation rewards REPETITION. A 6,000-char
   *      browser row whose AI-overview body says "follow" nine times outranks a
   *      title that says "Sports" once at weight A — which is how "What sports do
   *      you follow?" retrieved a git-login page, an Ubuntu upgrade guide and RC
   *      monster-truck shopping.
   *
   * This method fixes both. It picks a single ANCHOR — the lowest-document-
   * frequency lexeme in the question, and only if it clears
   * {@link ANCHOR_MAX_MATCHES} — so a row must carry the word that makes the
   * question specific ('cuisin', 'sport', 'languag') rather than the words the
   * archive is full of. Then it orders the (by construction small) match set by
   * embedding distance to the WHOLE question, so length bias cannot rank a
   * body-text mention over a title.
   *
   * A question with no selective term returns NOTHING, deliberately. "What city
   * do you live in?" has no keyword worth searching this corpus on, and an empty
   * lexical channel is the honest result — the caller's semantic channel is what
   * should answer it.
   *
   * Rows with no embedding sort last rather than being dropped: they still
   * matched the anchor, so they are worse evidence than a scored row, not
   * non-evidence.
   */
  async searchAnchored(
    context: UserServiceContext,
    question: string,
    options: AnchoredSearchOptions = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const { maxResults = 25, maxAnchorMatches = ANCHOR_MAX_MATCHES } = options;
    const limit = Math.max(1, Math.trunc(maxResults));
    const startedAt = Date.now();

    const anchor = await this.findAnchorLexeme(context, question, maxAnchorMatches);

    if (!anchor) {
      // "No term in the question is selective enough to anchor on" is the
      // deliberate empty answer this method documents. It still has to be
      // COUNTED, or the anchored channel's zero-result rate is measured only
      // over the calls that got as far as running a query.
      this.recordQuery({
        userId: context.userId,
        caller: 'search_anchored',
        modeTaken: 'no_anchor',
        queryTokenCount: queryTokenCount(question),
        includeTypes: options.includeTypes ?? null,
        excludeTypes: options.excludeTypes ?? null,
        resultCount: 0,
        topScore: null,
        latencyMs: Date.now() - startedAt,
      });

      return [];
    }

    const vector = await this.embeddingGenerationService.generateEmbeddingString(question);
    const typeFilter = this.buildTypeFilter(options, 4, 'v');

    // `plainto_tsquery('simple', $2)` — 'simple', not 'english', because $2 is
    // already a lexeme that Postgres's english stemmer produced ('cuisin', not
    // 'cuisine'), and re-stemming a stem is not guaranteed to be a fixed point.
    // Passing it as a BIND PARAMETER and letting Postgres build the tsquery is
    // also what keeps this injection-free: no lexeme text is ever concatenated
    // into the statement.
    const sql = `
      WITH q AS (
        SELECT plainto_tsquery('simple', $2) AS tq
      )
      SELECT
        v.entity_id,
        v.entity_type
      FROM
        ci_search.vectors v
        CROSS JOIN q
      LEFT JOIN ci_search.embeddings e
        ON e.entity_type = v.entity_type
        AND e.entity_id = v.entity_id
        AND e.user_id = $1
        AND e.embedding IS NOT NULL
      WHERE v.user_id = $1
        AND q.tq <> ''::tsquery
        AND v.vector @@ q.tq
        ${typeFilter.clause}
      ORDER BY (e.embedding <=> $3::vector) ASC NULLS LAST
      LIMIT ${limit}
    `;

    const params: (string | string[])[] = [context.userId, anchor, vector];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    const rows: Omit<ScoredRowResult, 'score'>[] = await this.dataSource.query(sql, params);

    this.recordQuery({
      userId: context.userId,
      caller: 'search_anchored',
      modeTaken: 'anchored',
      queryTokenCount: queryTokenCount(question),
      includeTypes: options.includeTypes ?? null,
      excludeTypes: options.excludeTypes ?? null,
      resultCount: rows.length,
      // This statement selects no score at all — it orders by embedding
      // distance and returns identifiers — so there is no top score to claim.
      topScore: null,
      latencyMs: Date.now() - startedAt,
    });

    return rows.map((row) => ({
      id: row.entity_id,
      type: row.entity_type as IndexableEntity,
    }));
  }

  /**
   * The rarest word in `question` that still clears `maxMatches`, or null.
   *
   * The count is BOUNDED — `LIMIT maxMatches` inside the subquery — so this
   * costs O(maxMatches) index probes per term regardless of how many rows
   * actually carry the word. A true `count(*)` for 'live' would walk 8,302 rows
   * to learn something the first 1,001 already settled.
   */
  private async findAnchorLexeme(
    context: UserServiceContext,
    question: string,
    maxMatches: number,
  ): Promise<string | null> {
    const cap = Math.max(1, Math.trunc(maxMatches)) + 1;

    const rows: { lexeme: string; df: string }[] = await this.dataSource.query(
      `
        WITH lexemes AS (
          SELECT DISTINCT l AS lexeme
          FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS l
        )
        SELECT
          lx.lexeme,
          (
            SELECT count(*) FROM (
              SELECT 1
              FROM ci_search.vectors v
              WHERE v.user_id = $1
                AND v.vector @@ plainto_tsquery('simple', lx.lexeme)
              LIMIT $3
            ) capped
          ) AS df
        FROM lexemes lx
      `,
      [context.userId, question, cap],
    );

    const eligible = rows
      .map((row) => ({ lexeme: row.lexeme, df: Number(row.df) }))
      // df === 0 means the word is nowhere in the corpus: anchoring on it
      // returns nothing, so it is not an anchor, it is a dead end.
      .filter((row) => row.df > 0 && row.df <= maxMatches)
      .sort((a, b) => a.df - b.df);

    return eligible[0]?.lexeme ?? null;
  }

  private applyDefaultTypeExclusions(options: SearchOptions): SearchOptions {
    if (options.includeTypes || options.excludeTypes) {
      return options;
    }

    return {
      ...options,
      // GPS fixes are indexed for recall (`includeTypes: ['position']`, agent
      // tools). Default entity search still omits them: SearchResultType has no
      // PositionType, and a 1Hz trace would swamp the union even after downsample
      // if a client ever asked for every type. Messages stay excluded for the
      // same GraphQL-union reason.
      excludeTypes: ['message', 'position'],
    };
  }

  /**
   * Hybrid search combining semantic and keyword results with score fusion.
   * Uses normalized score weighting instead of RRF for better score preservation.
   *
   * Weighting: 50% semantic + 50% keyword (when both present)
   * If only one type matches, that score is used directly.
   */
  private async hybridSearch(context: UserServiceContext, options: SearchOptions): Promise<StrategyResult> {
    const { maxResults = DEFAULT_MAX_RESULTS } = options;

    // Over-fetch so fusion has something to fuse: a row that ranks 30th on the
    // semantic side and 5th on the keyword side has to be present in BOTH lists
    // for the 50/50 average to see it at all.
    //
    // At the default `maxResults` of 25 this asks the semantic leg for 50 rows.
    // That is more than {@link HNSW_DEFAULT_EF_SEARCH}, so before this was
    // derived the leg could not fill its own LIMIT under ANY conditions — not
    // "under a selective filter", but with no filter at all, because the index
    // only ever produced 40 candidates. `semanticSearch` now widens the
    // candidate list to match whatever it is asked for (see
    // {@link runSemanticPlan}), so the two numbers agree by construction rather
    // than by two independent constants happening to line up.
    //
    // The keyword leg needs no such treatment: `ci_search.vectors` is a GIN
    // full-text scan with no candidate-list budget.
    const doubledMaxResults = maxResults * 2;

    // Run both semantic and keyword searches in parallel
    const [semanticLeg, keywordLeg] = await Promise.all([
      this.semanticSearch(context, {
        ...options,
        maxResults: doubledMaxResults,
      }),
      this.keywordSearch(context, {
        ...options,
        maxResults: doubledMaxResults,
      }),
    ]);
    const semanticResults = semanticLeg.results;
    const keywordResults = keywordLeg.results;

    if (options.fusionMode === 'rrf') {
      const rrfFused = reciprocalRankFusion([semanticResults, keywordResults]);

      return {
        results: rrfFused.slice(0, maxResults),
        totalMatches: null,
        limit: maxResults,
      };
    }

    // Normalize keyword scores (ts_rank scores vary widely, normalize to 0-1)
    const maxKeywordScore = Math.max(...keywordResults.map((r) => r.score), 0.001);

    // Build maps of normalized scores by composite key
    const semanticScores = new Map<string, number>();
    const keywordScores = new Map<string, number>();
    const allResults = new Map<string, ScoredSearchResult>();

    // Semantic scores are already 0-1 (1 - distance)
    semanticResults.forEach((result) => {
      const key = makeCompositeKey(result.type, result.id);
      semanticScores.set(key, result.score);
      allResults.set(key, result);
    });

    // Normalize keyword scores to 0-1
    keywordResults.forEach((result) => {
      const key = makeCompositeKey(result.type, result.id);
      keywordScores.set(key, result.score / maxKeywordScore);
      if (!allResults.has(key)) {
        allResults.set(key, result);
      }
    });

    // Compute fused scores with weighted average
    const fusedResults: ScoredSearchResult[] = [];

    allResults.forEach((result, key) => {
      const semScore = semanticScores.get(key);
      const kwScore = keywordScores.get(key);

      let fusedScore: number;
      if (semScore !== undefined && kwScore !== undefined) {
        // Both matched: weighted average (50/50)
        fusedScore = 0.5 * semScore + 0.5 * kwScore;
      } else if (semScore !== undefined) {
        // Only semantic matched
        fusedScore = semScore * 0.5; // Penalize slightly for missing keyword match
      } else if (kwScore !== undefined) {
        // Only keyword matched
        fusedScore = kwScore * 0.5; // Penalize slightly for missing semantic match
      } else {
        fusedScore = 0;
      }

      fusedResults.push({
        ...result,
        score: fusedScore,
      });
    });

    // Sort by fused score and limit. The keyword leg knows its own match
    // count, but the fused set is a union with the uncountable semantic leg, so
    // no single number describes it honestly.
    return {
      results: fusedResults.sort((a, b) => b.score - a.score).slice(0, maxResults),
      totalMatches: null,
      limit: maxResults,
    };
  }

  /**
   * The semantic statement, as data, so something other than a search can run
   * exactly what a search runs.
   *
   * `RecallProbeCron` measures this query against an exact answer, and a probe
   * that measured a COPY of the SQL would measure the copy. Building the plan
   * here — one function, used by {@link semanticSearch} itself — is what makes
   * "the probe ran the production query" true by construction rather than by
   * two strings agreeing today.
   *
   * Deliberately SYNCHRONOUS, and therefore policy-free: `semanticSearch`
   * resolves `ci.retrieval_policy` and passes the resulting `maxResults` /
   * `distanceThreshold` in through `scope`. The fallbacks below are the
   * compiled-in baseline, which is what a caller supplying its own scope (the
   * recall probe, which fixes k at `PROBE_K`) gets — see the follow-up note in
   * the PR: if a v2 changes `semanticMaxResults`, the probe still measures at
   * the baseline k until it is taught to read the policy too.
   *
   * @param vector the query embedding, already in pgvector's text form (the
   *   same shape `EmbeddingGenerationService.generateEmbeddingString` returns);
   *   passed as a bind parameter exactly as production does, because the
   *   planner's use of the HNSW index depends on that placement.
   */
  buildSemanticSearchPlan(
    userId: string,
    vector: string,
    scope: SemanticSearchScope = {},
  ): SemanticSearchPlan {
    const { maxResults = SEMANTIC_MAX_RESULTS, distanceThreshold = SEMANTIC_DISTANCE_THRESHOLD } = scope;

    const typeFilter = this.buildTypeFilter(scope, 4);

    // Cosine distance (<=>), NOT L2 (<->): embeddings are unnormalised, so the
    // L2 distance is ~22 and never < 0.5 — the threshold made semantic search
    // return nothing, and 1 - L2 produced large-negative "scores". With <=>,
    // (embedding <=> $2) is cosine distance in [0,2] and 1 - it is cosine sim.
    // ORDER BY the raw `embedding <=> $2` (ascending) rather than `score DESC` so the
    // HNSW index serves the KNN; `embedding IS NOT NULL` matches its partial predicate.
    // Nearest-first == highest-similarity-first, so results are unchanged but the query
    // uses the index instead of a full Seq Scan + Sort at corpus scale.
    //
    // `user_id` and the type filter sit OUTSIDE the ordering, so the index
    // returns its nearest neighbours across every user and type and these
    // predicates then discard some of them — which is why a filtered query can
    // come back short of its LIMIT, and why the recall probe exists.
    const sql = `
      SELECT
        entity_id,
        entity_type,
        1 - (embedding <=> $2) as score
      FROM
        ci_search.embeddings
      WHERE user_id = $1
        AND embedding IS NOT NULL
        AND (embedding <=> $2) < $3::double precision
        ${typeFilter.clause}
      ORDER BY embedding <=> $2
      LIMIT ${maxResults}
    `;

    const params: (number | string | string[])[] = [userId, vector, distanceThreshold];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    return { sql, params, maxResults };
  }

  private async semanticSearch(context: UserServiceContext, options: SearchOptions): Promise<StrategyResult> {
    const vector = await this.embeddingGenerationService.generateEmbeddingString(options.query);
    const policy = await this.retrievalPolicy.get();

    // An explicit caller scope still wins — `groundedSeeds` passes a tighter
    // distance threshold on purpose, and the policy is the DEFAULT, not a cap.
    // Resolving the defaults here rather than inside `buildSemanticSearchPlan`
    // keeps that method synchronous, which is what lets `RecallProbeService`
    // measure the production statement without a policy read of its own.
    const plan = this.buildSemanticSearchPlan(context.userId, vector, {
      ...options,
      maxResults: options.maxResults ?? policy.semanticMaxResults,
      distanceThreshold: options.distanceThreshold ?? policy.semanticDistanceThreshold,
    });

    const results = await this.runSemanticPlan(plan);

    return {
      results: results.map((row: ScoredRowResult) => ({
        id: row.entity_id,
        type: row.entity_type as IndexableEntity,
        score: parseFloat(row.score),
      })),
      // A KNN list has no match set to count — see {@link SearchPage}.
      totalMatches: null,
      limit: plan.maxResults,
    };
  }

  /**
   * Run a semantic plan on a connection whose HNSW candidate list is at least
   * as wide as the plan's own `LIMIT`.
   *
   * The plan's SQL is untouched — {@link buildSemanticSearchPlan} stays the one
   * statement `RecallProbeService` measures — and so is the fast path: a request
   * the default budget can already satisfy (k <= {@link HNSW_DEFAULT_EF_SEARCH},
   * which is every default-`maxResults` search in the codebase) runs on the pool
   * exactly as before, with no transaction and no `SET`.
   *
   * A request that CANNOT be satisfied gets its own transaction and a `SET
   * LOCAL`. `LOCAL`, never a session or global `SET`: the pool hands this
   * connection to the next query the moment it is released, and a leaked
   * `hnsw.ef_search` would silently re-tune every unrelated vector query that
   * borrowed it afterwards. Bounded by {@link requiredEfSearch} to an integer in
   * [40, 1000] before it reaches the statement, because `SET` takes no bind
   * parameters and this value is interpolated.
   *
   * The HNSW index scan is preserved exactly: `ef_search` widens the candidate
   * list the scan walks, it does not change the plan. `ORDER BY embedding <=> $2
   * ASC LIMIT k` against a pseudoconstant is still the only shape the index can
   * serve, and nothing here touches it.
   */
  private async runSemanticPlan(plan: SemanticSearchPlan): Promise<ScoredRowResult[]> {
    const efSearch = requiredEfSearch(plan.maxResults);

    if (efSearch <= HNSW_DEFAULT_EF_SEARCH) {
      return this.dataSource.query(plan.sql, plan.params);
    }

    const runner = this.dataSource.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();

      try {
        await runner.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);

        const rows = await runner.query(plan.sql, plan.params);

        await runner.commitTransaction();

        return rows;
      } catch (error) {
        await runner.rollbackTransaction();

        throw error;
      }
    } finally {
      await runner.release();
    }
  }

  private async keywordSearch(context: UserServiceContext, options: SearchOptions): Promise<StrategyResult> {
    const { query, maxResults = DEFAULT_MAX_RESULTS } = options;

    const typeFilter = this.buildTypeFilter(options, 3);
    const timeFilter = buildTimeFilter(options, 3 + (typeFilter.param ? 1 : 0));
    const { weights } = await this.rankingLiterals();

    // `count(*) OVER ()` is evaluated after WHERE and before LIMIT, so it is
    // the size of the whole match set on every returned row — and it is free
    // here, because ORDER BY score already ranks every matching row before the
    // LIMIT takes the top of it.
    const sql = `
      WITH q AS (
        SELECT ${KEYWORD_TSQUERY_SQL} AS tq
      )
      SELECT
        entity_id,
        entity_type,
        ts_rank('${weights}', vector, q.tq) as score,
        count(*) OVER () AS total_matches
      FROM
        ci_search.vectors
        CROSS JOIN q
      WHERE user_id = $1
        AND q.tq <> ''::tsquery
        AND vector @@ q.tq
        ${typeFilter.clause}
        ${timeFilter.clause}
      ORDER BY ${lexicalOrderSql(options.sort)}
      LIMIT ${maxResults}
    `;

    const params: (string | string[])[] = [context.userId, query];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    params.push(...timeFilter.params);

    const rows: CountedRowResult[] = await this.dataSource.query(sql, params);

    return {
      results: rows.map((row) => ({
        id: row.entity_id,
        type: row.entity_type as IndexableEntity,
        score: parseFloat(row.score),
      })),
      totalMatches: totalMatchesOf(rows),
      limit: maxResults,
    };
  }

  /**
   * Keyword search with embedding similarity boost.
   * Requires keyword match (precision) but uses embedding similarity to boost relevance.
   * This combines the best of both worlds in a single query.
   *
   * Score formula: keyword_score * (1 + embeddingBoostFactor * embedding_similarity),
   * where the boost comes from the retrieval policy (baseline 0.5).
   */
  private async boostedKeywordSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<StrategyResult> {
    const { query, maxResults = DEFAULT_MAX_RESULTS } = options;

    // Generate query embedding for similarity comparison
    const queryEmbedding = await this.embeddingGenerationService.generateEmbeddingString(query);

    // Use 'v' table alias since we're joining vectors and embeddings
    const typeFilter = this.buildTypeFilter(options, 4, 'v');
    const timeFilter = buildTimeFilter(options, 4 + (typeFilter.param ? 1 : 0), 'v');
    const { weights, boost } = await this.rankingLiterals();

    // The natural-language questions we get from clients ("Where does Jordan
    // live?") are routed here, and an AND-joined tsquery would need every
    // non-stopword in the SAME entity's vector, which almost never holds:
    // "jordan" lives in the Person entity, "live" lives in the Place entity.
    // {@link KEYWORD_TSQUERY_SQL} is the OR-joined form, so any token match
    // qualifies and the embedding boost discriminates among them.
    //
    // `count(*) OVER ()` counts joined rows, which is one per match: the LEFT
    // JOIN target has `UNIQUE (entity_type, entity_id)`, so it can add nothing.
    const sql = `
      WITH q AS (
        SELECT ${KEYWORD_TSQUERY_SQL} AS tq
      )
      SELECT
        v.entity_id,
        v.entity_type,
        ts_rank('${weights}', v.vector, q.tq)
          * (1 + ${boost} * COALESCE(1 - (e.embedding <=> $3::vector), 0)) as score,
        count(*) OVER () AS total_matches
      FROM
        ci_search.vectors v
        CROSS JOIN q
      LEFT JOIN ci_search.embeddings e
        ON e.entity_type = v.entity_type
        AND e.entity_id = v.entity_id
        AND e.user_id = $1
      WHERE v.user_id = $1
        AND q.tq <> ''::tsquery
        AND v.vector @@ q.tq
        ${typeFilter.clause}
        ${timeFilter.clause}
      ORDER BY ${lexicalOrderSql(options.sort, 'v')}
      LIMIT ${maxResults}
    `;

    const params: (string | string[])[] = [context.userId, query, queryEmbedding];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    params.push(...timeFilter.params);

    const rows: CountedRowResult[] = await this.dataSource.query(sql, params);

    return {
      results: rows.map((row) => ({
        id: row.entity_id,
        type: row.entity_type as IndexableEntity,
        score: parseFloat(row.score),
      })),
      totalMatches: totalMatchesOf(rows),
      limit: maxResults,
    };
  }

  private buildTypeFilter(
    options: Pick<SemanticSearchScope, 'includeTypes' | 'excludeTypes'>,
    paramOffset: number,
    tableAlias?: string,
  ): { clause: string; param: string[] | null } {
    const column = tableAlias ? `${tableAlias}.entity_type` : 'entity_type';

    if (options.includeTypes && options.includeTypes.length > 0) {
      return {
        clause: `AND ${column} = ANY($${paramOffset})`,
        param: options.includeTypes,
      };
    }

    if (options.excludeTypes && options.excludeTypes.length > 0) {
      return {
        clause: `AND ${column} != ALL($${paramOffset})`,
        param: options.excludeTypes,
      };
    }

    return {
      clause: '',
      param: null,
    };
  }
}

function makeCompositeKey(type: IndexableEntity, id: string): string {
  return `${type}:${id}`;
}

/**
 * The match-set size a `count(*) OVER ()` column reports, read off the first
 * row. No rows means nothing matched, so zero — the window count cannot appear
 * on a row that does not exist. A row WITHOUT the column (a stubbed DataSource
 * in a unit test, or a statement that forgot it) falls back to the page size,
 * which is the pre-count behaviour: never more wrong than before, and never a
 * NaN in a number the model will repeat.
 */
function totalMatchesOf(rows: { total_matches?: string | number | null }[]): number {
  const reported = rows[0]?.total_matches;

  if (reported == null) {
    return rows.length;
  }

  const total = Number(reported);

  return Number.isFinite(total) ? total : rows.length;
}

/**
 * Which strategy `mode: 'auto'` picks for a query. Unchanged rules, lifted out
 * of the private `autoSearch` it used to live inside so that
 * {@link SearchService.search} can name the mode it is about to run — the
 * dispatcher needs the DECISION, not just its effect, in order to record it.
 *
 * - Short queries (≤3 words) or special chars: keyword only (fast, no embedding call)
 * - Medium queries (4-7 words): boosted keyword (embedding call for relevance boost)
 * - Long queries (≥8 words): semantic only (conceptual/natural language)
 */
export function resolveAutoMode(query: string): 'keyword' | 'boosted' | 'semantic' {
  const wordCount = query.trim().split(/\s+/).length;
  const hasSpecialChars = /[@.:\-_]/.test(query);

  // Short queries or those with special characters (emails, IDs) → keyword only (fast)
  if (wordCount <= 3 || hasSpecialChars) {
    return 'keyword';
  }

  // Long natural language queries → semantic (conceptual matching)
  if (wordCount >= 8) {
    return 'semantic';
  }

  // Medium length queries → boosted keyword (best balance of speed and relevance)
  return 'boosted';
}

/**
 * Highest score in a result set, or null when there is none to report.
 *
 * A max rather than `results[0]`: every ranked path here already returns its
 * best row first, but a log column that quietly assumes that would start lying
 * the day a caller re-orders a result set before it is recorded.
 */
function topScoreOf(results: { score: number }[]): number | null {
  let top: number | null = null;

  for (const result of results) {
    if (Number.isFinite(result.score) && (top === null || result.score > top)) {
      top = result.score;
    }
  }

  return top;
}

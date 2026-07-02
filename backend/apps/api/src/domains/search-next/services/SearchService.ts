import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';

import { EmbeddingEntity } from '../entities/EmbeddingEntity';
import { VectorEntity } from '../entities/VectorEntity';
import type { EntityIdentifier, IndexableEntity } from '../types';

/**
 * PostgreSQL ts_rank weight multipliers for weighted tsvectors.
 * Format: {D, C, B, A} - D is lowest priority, A is highest.
 * These weights determine how much each category contributes to the final score.
 *
 * Current configuration:
 * - A (weight 10+ at ingestion): 1.0 multiplier - names, titles, primary identifiers
 * - B (weight 4-7 at ingestion): 0.4 multiplier - descriptions, summaries
 * - C (weight 2-3 at ingestion): 0.2 multiplier - categories, types, URLs
 * - D (weight <2 at ingestion): 0.1 multiplier - properties, bulk content
 */
const TS_RANK_WEIGHTS = '{0.1, 0.2, 0.4, 1.0}';

/**
 * Embedding similarity boost factor.
 * The keyword score is multiplied by (1 + EMBEDDING_BOOST * similarity).
 * With similarity in [0,1] and boost of 0.5, scores can increase by up to 50%.
 */
const EMBEDDING_BOOST_FACTOR = 0.5;

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
};

type SearchOptions =
  | (BaseSearchOptions & { includeTypes: IndexableEntity[]; excludeTypes?: never })
  | (BaseSearchOptions & { excludeTypes: IndexableEntity[]; includeTypes?: never })
  | (BaseSearchOptions & { includeTypes?: never; excludeTypes?: never });

@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(EmbeddingEntity)
    private readonly embeddingRepo: Repository<EmbeddingEntity>,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    @InjectRepository(VectorEntity)
    private readonly vectorRepo: Repository<VectorEntity>,
  ) {}

  async search(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const resolvedOptions = this.applyDefaultTypeExclusions(options);
    const { mode = 'auto' } = resolvedOptions;

    let results: EntityIdentifier<IndexableEntity>[];

    switch (mode) {
      case 'semantic':
        results = await this.semanticSearch(context, resolvedOptions);
        break;

      case 'keyword':
        results = await this.keywordSearch(context, resolvedOptions);
        break;

      case 'boosted':
        results = await this.boostedKeywordSearch(context, resolvedOptions);
        break;

      case 'hybrid':
        results = await this.hybridSearch(context, resolvedOptions);
        break;

      case 'auto':
      default:
        results = await this.autoSearch(context, resolvedOptions);
        break;
    }

    return results.map((result) => ({
      id: result.id,
      type: result.type,
    }));
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
    const vector = await this.embeddingGenerationService.generateEmbeddingString(query);

    const sql = `
      SELECT entity_id, 1 - (embedding <=> $2) AS score
      FROM ci_search.embeddings
      WHERE user_id = $1
        AND entity_type = 'message'
        AND (embedding <=> $2) < $3::double precision
      ORDER BY score DESC
      LIMIT ${maxResults}
    `;

    const rows = await this.embeddingRepo.query(sql, [context.userId, vector, distanceFloor]);

    return rows.map((row: { entity_id: string; score: string }) => ({
      id: row.entity_id,
      score: parseFloat(row.score),
    }));
  }

  private applyDefaultTypeExclusions(options: SearchOptions): SearchOptions {
    if (options.includeTypes || options.excludeTypes) {
      return options;
    }

    return {
      ...options,
      excludeTypes: ['message'],
    };
  }

  /**
   * Automatically selects the best search strategy based on query characteristics.
   *
   * - Short queries (≤3 words) or special chars: keyword only (fast, no embedding call)
   * - Medium queries (4-7 words): boosted keyword (embedding call for relevance boost)
   * - Long queries (≥8 words): semantic only (conceptual/natural language)
   */
  private async autoSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<ScoredSearchResult[]> {
    const { query } = options;

    // Auto-detect search strategy based on query characteristics
    const wordCount = query.trim().split(/\s+/).length;
    const hasSpecialChars = /[@.:\-_]/.test(query);

    // Short queries or those with special characters (emails, IDs) → keyword only (fast)
    if (wordCount <= 3 || hasSpecialChars) {
      return this.keywordSearch(context, options);
    }

    // Long natural language queries → semantic (conceptual matching)
    if (wordCount >= 8) {
      return this.semanticSearch(context, options);
    }

    // Medium length queries → boosted keyword (best balance of speed and relevance)
    return this.boostedKeywordSearch(context, options);
  }

  /**
   * Hybrid search combining semantic and keyword results with score fusion.
   * Uses normalized score weighting instead of RRF for better score preservation.
   *
   * Weighting: 50% semantic + 50% keyword (when both present)
   * If only one type matches, that score is used directly.
   */
  private async hybridSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<ScoredSearchResult[]> {
    const { maxResults = 25 } = options;

    const doubledMaxResults = maxResults * 2;

    // Run both semantic and keyword searches in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearch(context, {
        ...options,
        maxResults: doubledMaxResults,
      }),
      this.keywordSearch(context, {
        ...options,
        maxResults: doubledMaxResults,
      }),
    ]);

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

    // Sort by fused score and limit
    return fusedResults.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  private async semanticSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<ScoredSearchResult[]> {
    const { query, maxResults = 25 } = options;

    const vector = await this.embeddingGenerationService.generateEmbeddingString(query);

    const distanceThreshold = 0.5;

    const typeFilter = this.buildTypeFilter(options, 4);

    // Cosine distance (<=>), NOT L2 (<->): embeddings are unnormalised, so the
    // L2 distance is ~22 and never < 0.5 — the threshold made semantic search
    // return nothing, and 1 - L2 produced large-negative "scores". With <=>,
    // (embedding <=> $2) is cosine distance in [0,2] and 1 - it is cosine sim.
    const sql = `
      SELECT
        entity_id,
        entity_type,
        1 - (embedding <=> $2) as score
      FROM
        ci_search.embeddings
      WHERE user_id = $1
        AND (embedding <=> $2) < $3::double precision
        ${typeFilter.clause}
      ORDER BY score DESC
      LIMIT ${maxResults}
    `;

    const params: (number | string | string[])[] = [context.userId, vector, distanceThreshold];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    const results = await this.embeddingRepo.query(sql, params);

    return results.map((row: ScoredRowResult) => ({
      id: row.entity_id,
      type: row.entity_type as IndexableEntity,
      score: parseFloat(row.score),
    }));
  }

  private async keywordSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<ScoredSearchResult[]> {
    const { query, maxResults = 25 } = options;

    const typeFilter = this.buildTypeFilter(options, 3);

    // Same OR-rewriting as boostedKeywordSearch: turn the AND-joined tsquery
    // from websearch_to_tsquery into an OR-joined one so a 2-3 word query like
    // "dog breed" matches an entity whose vector has only one of the tokens
    // (e.g. Mochi's vector has 'dog' but not 'breed').  ts_rank still rewards
    // entities matching more terms.  Single-term queries are unaffected
    // (no '&' to replace).
    const sql = `
      WITH q AS (
        SELECT replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery AS tq
      )
      SELECT
        entity_id,
        entity_type,
        ts_rank('${TS_RANK_WEIGHTS}', vector, q.tq) as score
      FROM
        ci_search.vectors
        CROSS JOIN q
      WHERE user_id = $1
        AND q.tq <> ''::tsquery
        AND vector @@ q.tq
        ${typeFilter.clause}
      ORDER BY score DESC
      LIMIT ${maxResults}
    `;

    const params: (string | string[])[] = [context.userId, query];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    const results = await this.vectorRepo.query(sql, params);

    return results.map((row: ScoredRowResult) => ({
      id: row.entity_id,
      type: row.entity_type as IndexableEntity,
      score: parseFloat(row.score),
    }));
  }

  /**
   * Keyword search with embedding similarity boost.
   * Requires keyword match (precision) but uses embedding similarity to boost relevance.
   * This combines the best of both worlds in a single query.
   *
   * Score formula: keyword_score * (1 + EMBEDDING_BOOST_FACTOR * embedding_similarity)
   */
  private async boostedKeywordSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<ScoredSearchResult[]> {
    const { query, maxResults = 25 } = options;

    // Generate query embedding for similarity comparison
    const queryEmbedding = await this.embeddingGenerationService.generateEmbeddingString(query);

    // Use 'v' table alias since we're joining vectors and embeddings
    const typeFilter = this.buildTypeFilter(options, 4, 'v');

    // The natural-language questions we get from clients ("Where does Jordan
    // live?") are routed here, but `websearch_to_tsquery` builds an AND-joined
    // tsquery — every non-stopword has to appear in the SAME entity's vector,
    // which almost never holds: "jordan" lives in the Person entity, "live"
    // lives in the Place entity.  Flip the join from `&` to `|` so any token
    // match qualifies and ts_rank still rewards entities matching more terms,
    // with the embedding boost discriminating among them.  Single-term queries
    // are unaffected (no `&` to replace) and phrase queries (`<->`) and
    // negations (`!`) are preserved by the literal string replace.
    const sql = `
      WITH q AS (
        SELECT replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery AS tq
      )
      SELECT
        v.entity_id,
        v.entity_type,
        ts_rank('${TS_RANK_WEIGHTS}', v.vector, q.tq)
          * (1 + ${EMBEDDING_BOOST_FACTOR} * COALESCE(1 - (e.embedding <=> $3::vector), 0)) as score
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
      ORDER BY score DESC
      LIMIT ${maxResults}
    `;

    const params: (string | string[])[] = [context.userId, query, queryEmbedding];

    if (typeFilter.param) {
      params.push(typeFilter.param);
    }

    const results = await this.vectorRepo.query(sql, params);

    return results.map((row: ScoredRowResult) => ({
      id: row.entity_id,
      type: row.entity_type as IndexableEntity,
      score: parseFloat(row.score),
    }));
  }

  private buildTypeFilter(
    options: SearchOptions,
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

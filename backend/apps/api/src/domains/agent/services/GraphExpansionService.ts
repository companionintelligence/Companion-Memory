/**
 * GraphExpansionService
 *
 * Query-conditioned 1-hop subgraph retrieval for recall.
 *
 * Pure vector/keyword search finds entities that lexically or semantically
 * match the query, but it can't answer relational questions: "Where does
 * Jordan live?" matches the `Jordan Rivera` node, yet the answer (`Austin`)
 * lives one edge away via `LIVES_IN`.  Naively pulling every 1-hop neighbour
 * doesn't scale — a hub node (the user!) can have hundreds of edges and would
 * flood the recall block.
 *
 * This service expands one hop from the seed hits but keeps only the neighbours
 * that bear on the query, in two cheap, bounded stages:
 *
 *   Stage 1 — edge-type prune.  The relationship type is the strongest
 *     relevance signal for relational queries ("where ... live" → LIVES_IN)
 *     and the vocabulary is tiny (~dozen types).  We embed a short natural-
 *     language gloss per type once, cache it, and cosine-score the query
 *     against those cached vectors.  Edges whose type scores below the floor
 *     are dropped *before* any per-neighbour work — so a node with 500 OWNS
 *     edges collapses to its 2 LIVES_IN edges for a "where do you live" query,
 *     at the cost of N dot-products, not N embeddings.
 *
 *   Stage 2 — neighbour rank.  Of the surviving neighbours, score each by a
 *     blend of its edge-type relevance (dominant) and its own embedding
 *     similarity to the query (tiebreak among same-type neighbours), using the
 *     embedding index that already exists.  Keep the top-K above a threshold.
 *
 * Output is bounded to ≤ NEIGHBOUR_K neighbours regardless of graph density.
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max edges pulled per query before pruning. Caps work on hub nodes. */
const MAX_EDGES = 200;

/** Keep at most this many distinct relationship types (the most query-relevant). */
const MAX_TYPES = 3;

/**
 * Minimum cosine(query, type-gloss) for an edge type to be considered relevant.
 * nomic-embed-text puts unrelated short texts around 0.3-0.45 and clearly
 * related ones above ~0.55; 0.5 is a moderate floor. Tunable.
 */
const TYPE_SCORE_FLOOR = 0.5;

/** Max neighbours added to the recall block. */
const NEIGHBOUR_K = 5;

/** Blend weights for the final neighbour score. Edge-type dominates. */
const W_TYPE = 0.7;
const W_NODE = 0.3;

/** Drop neighbours whose blended score is below this. */
const NEIGHBOUR_SCORE_FLOOR = 0.35;

/**
 * Short glosses for the relationship vocabulary.  Scored — not matched — so
 * synonyms and phrasing variants of the query still land on the right type.
 * Types not listed here fall back to a humanized form of the raw type string,
 * so the vocabulary self-extends without code changes.
 */
const RELATIONSHIP_GLOSSES: Record<string, string> = {
  LIVES_IN: 'lives in, home, residence, located in, where someone lives',
  WORKS_AT: 'works at, employer, job, workplace, company, occupation',
  WORKS_WITH: 'works with, colleague, coworker, collaborator',
  KNOWS: 'knows, acquaintance, met, knows about',
  FRIENDS_WITH: 'friend, best friend, friendship, close friend',
  PARENT_OF: 'parent of, mother, father, has a child',
  CHILD_OF: 'child of, son, daughter, their parents',
  SIBLING_OF: 'sibling, brother, sister',
  SPOUSE: 'spouse, husband, wife, married to, partner',
  OWNS: 'owns, possession, has, belongings, property',
  ATTENDED: 'attended, went to, participated in, visited, was at an event',
  // VISITED holds places the user goes (gym, cafe, trails), not just events.
  // Without an entry it fell back to the bare word "visited", so "where does
  // X work out" (→ the gym) scored below the type floor and was dropped.
  VISITED:
    'visited, went to, attended, was at, works out at, gym, exercises at, trains at, a place someone goes',
  LIKES: 'likes, enjoys, favorite, fond of',
  DISLIKES: 'dislikes, hates, avoids, not a fan of',
  PREFERS: 'prefers, preference, favorite choice, would rather',
  // INTERESTED_IN is the extraction's catch-all: it holds hobbies, sports,
  // musical instruments, languages, diet, and media (books/movies/podcasts).
  // The gloss must cover all of those vocabularies or e.g. "what instrument
  // does X play" / "current diet" score below the floor and never expand.
  INTERESTED_IN:
    'interested in, hobby, pastime, passion, plays a musical instrument, music, sport, diet, dietary preference, what they eat, reads books, watches movies, listens to podcasts, topic of interest',
  HAS_SKILL: 'has skill, ability, proficient in, learning, good at',
  RELATED_TO: 'related to, associated with, connected to, about',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EdgeRow {
  rel_type: string;
  strength: number | null;
  outbound: boolean;
  seed_id: string;
  neighbour_id: string;
  seed_name: string | null;
  neighbour_name: string | null;
  neighbour_description: string | null;
}

export interface ExpandedNeighbour {
  /** ci.entities entity_id — used by the caller to dedup against seed hits. */
  entityId: string;
  /** Pre-serialized, LLM-ready line including the relationship path. */
  line: string;
  /** Final blended relevance score (for ordering / logging). */
  score: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class GraphExpansionService {
  /** Lazily-populated cache of relationship-type gloss embeddings. */
  private readonly glossCache = new Map<string, number[]>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly embeddings: EmbeddingGenerationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphExpansionService.name);
  }

  /**
   * Expand one hop from the seed entities, returning only query-relevant
   * neighbours as ready-to-serialize lines.
   *
   * @param seedIds  ci.entities entity_ids of the search hits.
   * @param query    The (sanitized) recall query.
   * @param excludeIds  Entity ids already in the block (the seeds) — never re-added.
   */
  async expand(
    context: UserServiceContext,
    seedIds: string[],
    query: string,
    excludeIds: Set<string>,
  ): Promise<ExpandedNeighbour[]> {
    if (seedIds.length === 0 || !query.trim()) {
      return [];
    }

    try {
      // ---- Pull 1-hop edges (bounded) -----------------------------------
      const edges = await this.fetchEdges(context.userId, seedIds);
      const candidate = edges.filter((e) => !excludeIds.has(e.neighbour_id));
      if (candidate.length === 0) {
        return [];
      }

      // ---- Stage 1: edge-type prune via gloss embeddings ----------------
      const queryVec = await this.embeddings.generateEmbedding(query);
      const distinctTypes = [...new Set(candidate.map((e) => e.rel_type))];
      const typeScores = await this.scoreTypes(distinctTypes, queryVec);

      const keptTypes = new Set(
        [...typeScores.entries()]
          .filter(([, s]) => s >= TYPE_SCORE_FLOOR)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_TYPES)
          .map(([t]) => t),
      );

      if (keptTypes.size === 0) {
        return []; // No relationship type is relevant to this query.
      }

      const relevantEdges = candidate.filter((e) => keptTypes.has(e.rel_type));

      // ---- Stage 2: rank neighbours by blended score --------------------
      const neighbourIds = [...new Set(relevantEdges.map((e) => e.neighbour_id))];
      const nodeSims = await this.scoreNeighbourNodes(context.userId, neighbourIds, queryVec);

      // Collapse multi-edge neighbours to their single best edge.
      const best = new Map<string, { edge: EdgeRow; score: number }>();
      for (const edge of relevantEdges) {
        const typeScore = typeScores.get(edge.rel_type) ?? 0;
        const nodeSim = nodeSims.get(edge.neighbour_id) ?? 0;
        const score = W_TYPE * typeScore + W_NODE * nodeSim;

        const prev = best.get(edge.neighbour_id);
        if (!prev || score > prev.score) {
          best.set(edge.neighbour_id, { edge, score });
        }
      }

      return [...best.values()]
        .filter((b) => b.score >= NEIGHBOUR_SCORE_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, NEIGHBOUR_K)
        .map(({ edge, score }) => ({
          entityId: edge.neighbour_id,
          line: this.buildLine(edge),
          score,
        }));
    } catch (err) {
      // Expansion is best-effort; never break recall.
      this.logger.warn(`Graph expansion failed for user ${context.userId}: ${err}`);

      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 1 helpers
  // ---------------------------------------------------------------------------

  /** Cosine-score each relationship type's gloss against the query vector. */
  private async scoreTypes(types: string[], queryVec: number[]): Promise<Map<string, number>> {
    await this.ensureGlossEmbeddings(types);

    const scores = new Map<string, number>();
    for (const type of types) {
      const gloss = this.glossCache.get(type);
      if (gloss) {
        scores.set(type, cosine(queryVec, gloss));
      }
    }

    return scores;
  }

  /** Embed (and cache) glosses for any types not seen before, in parallel. */
  private async ensureGlossEmbeddings(types: string[]): Promise<void> {
    const missing = types.filter((t) => !this.glossCache.has(t));
    if (missing.length === 0) {
      return;
    }

    const embedded = await Promise.all(
      missing.map(async (type) => {
        const gloss = RELATIONSHIP_GLOSSES[type] ?? type.replace(/_/g, ' ').toLowerCase();

        return [type, await this.embeddings.generateEmbedding(gloss)] as const;
      }),
    );

    for (const [type, vec] of embedded) {
      this.glossCache.set(type, vec);
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 2 helpers
  // ---------------------------------------------------------------------------

  /**
   * Cosine similarity of each neighbour's stored embedding to the query.
   * Reuses the ci_search.embeddings index (mirrors SearchService's distance
   * usage). A neighbour may have rows under more than one tag; we keep the
   * highest similarity per entity_id.
   */
  private async scoreNeighbourNodes(
    userId: string,
    neighbourIds: string[],
    queryVec: number[],
  ): Promise<Map<string, number>> {
    const sims = new Map<string, number>();
    if (neighbourIds.length === 0) {
      return sims;
    }

    const vecString = `[${queryVec.join(',')}]`;
    const rows: Array<{ entity_id: string; sim: string }> = await this.dataSource.query(
      // Cosine similarity. MUST use <=> (cosine distance), NOT <-> (L2):
      // nomic-embed-text vectors are unnormalised (‖v‖≈22), so 1 - L2 yields
      // large negatives (~-22) that swamp the W_NODE term and push every
      // neighbour below NEIGHBOUR_SCORE_FLOOR — silently killing all expansion.
      `SELECT entity_id, 1 - (embedding <=> $1::vector) AS sim
       FROM ci_search.embeddings
       WHERE user_id = $2 AND entity_id = ANY($3::uuid[])`,
      [vecString, userId, neighbourIds],
    );

    for (const row of rows) {
      const sim = Number.parseFloat(row.sim);
      const prev = sims.get(row.entity_id);
      if (prev === undefined || sim > prev) {
        sims.set(row.entity_id, sim);
      }
    }

    return sims;
  }

  // ---------------------------------------------------------------------------
  // Data access + formatting
  // ---------------------------------------------------------------------------

  private async fetchEdges(userId: string, seedIds: string[]): Promise<EdgeRow[]> {
    return this.dataSource.query(
      `SELECT
         r.relationship_type AS rel_type,
         r.strength          AS strength,
         (r.from_entity_id = ANY($1::uuid[])) AS outbound,
         CASE WHEN r.from_entity_id = ANY($1::uuid[]) THEN r.from_entity_id ELSE r.to_entity_id END AS seed_id,
         CASE WHEN r.from_entity_id = ANY($1::uuid[]) THEN r.to_entity_id ELSE r.from_entity_id END AS neighbour_id,
         seed.name AS seed_name,
         nb.name AS neighbour_name,
         nb.description AS neighbour_description
       FROM ci.relationships r
       JOIN ci.entities seed
         ON seed.entity_id = CASE WHEN r.from_entity_id = ANY($1::uuid[]) THEN r.from_entity_id ELSE r.to_entity_id END
       JOIN ci.entities nb
         ON nb.entity_id = CASE WHEN r.from_entity_id = ANY($1::uuid[]) THEN r.to_entity_id ELSE r.from_entity_id END
       WHERE (r.from_entity_id = ANY($1::uuid[]) OR r.to_entity_id = ANY($1::uuid[]))
         AND r.is_active = true
         AND r.owner_user_id = $2
       ORDER BY r.strength DESC NULLS LAST
       LIMIT $3`,
      [seedIds, userId, MAX_EDGES],
    );
  }

  /**
   * Compact, LLM-ready line that carries the relationship path so the model
   * knows *why* this neighbour surfaced:
   *   "Austin, Texas — Current residence (Jordan Rivera lives in)"
   */
  private buildLine(edge: EdgeRow): string {
    const name = (edge.neighbour_name ?? '').trim() || '(unnamed)';
    const desc = (edge.neighbour_description ?? '').trim();
    const seed = (edge.seed_name ?? '').trim();
    const rel = edge.rel_type.replace(/_/g, ' ').toLowerCase();

    // Outbound: seed --rel--> neighbour ("Jordan lives in Austin").
    // Inbound:  neighbour --rel--> seed ("Austin: Jordan lives in").
    const path = seed ? (edge.outbound ? `${seed} ${rel}` : `${rel} ${seed}`) : '';

    const head = desc ? `${name} — ${desc}` : name;

    return path ? `${head} (${path})` : head;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  if (na === 0 || nb === 0) {
    return 0;
  }

  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

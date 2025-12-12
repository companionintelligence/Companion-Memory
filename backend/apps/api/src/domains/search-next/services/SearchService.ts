import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { UserServiceContext } from '@ci/common/types';

import { EmbeddingEntity } from '../entities/EmbeddingEntity';
import { VectorEntity } from '../entities/VectorEntity';
import type { EntityIdentifier, IndexableEntity } from '../types';

type ScoredRowResult = {
  entity_id: string;
  entity_type: string;
  score: string;
};

type ScoredSearchResult = EntityIdentifier<IndexableEntity> & {
  score: number;
};
interface SearchOptions {
  query: string;
  mode?: 'semantic' | 'keyword' | 'hybrid' | 'auto';
  maxResults?: number;
}

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
    const { mode = 'auto' } = options;

    let results: EntityIdentifier<IndexableEntity>[];

    switch (mode) {
      case 'semantic':
        results = await this.semanticSearch(context, options);
        break;

      case 'keyword':
        results = await this.keywordSearch(context, options);
        break;

      case 'hybrid':
        results = await this.hybridSearch(context, options);
        break;

      case 'auto':
      default:
        results = await this.autoSearch(context, options);
        break;
    }

    return results.map((result) => ({
      id: result.id,
      type: result.type,
    }));
  }

  private async autoSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<ScoredSearchResult[]> {
    const { query } = options;

    // Auto-detect search strategy based on query characteristics
    const wordCount = query.trim().split(/\s+/).length;
    const hasSpecialChars = /[@.:\-_]/.test(query);

    // Short queries or those with special characters (emails, IDs) → keyword
    if (wordCount <= 3 || hasSpecialChars) {
      return this.keywordSearch(context, options);
    }

    // Long natural language queries → semantic
    if (wordCount >= 8) {
      return this.semanticSearch(context, options);
    }

    // Medium length queries → hybrid (best of both)
    return this.hybridSearch(context, options);
  }

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

    // Reciprocal Rank Fusion (RRF) - combine results with weighted scoring
    const fusedScores = new Map<string, number>();
    const k = 60; // RRF constant

    // Weight semantic results (60% weight)
    semanticResults.forEach((result, index) => {
      const key = makeCompositeKey(result.type, result.id);
      const rrfScore = 1 / (k + index + 1);
      fusedScores.set(key, (fusedScores.get(key) || 0) + rrfScore * 0.6);
    });

    // Weight keyword results (40% weight)
    keywordResults.forEach((result, index) => {
      const key = makeCompositeKey(result.type, result.id);
      const rrfScore = 1 / (k + index + 1);
      fusedScores.set(key, (fusedScores.get(key) || 0) + rrfScore * 0.4);
    });

    // Merge results and apply fused scores using composite keys
    const allResults = new Map<string, ScoredSearchResult>();

    [...semanticResults, ...keywordResults].forEach((result) => {
      const key = makeCompositeKey(result.type, result.id);
      if (!allResults.has(key)) {
        allResults.set(key, {
          ...result,
          score: fusedScores.get(key) || 0,
        });
      }
    });

    // Sort by fused score and limit
    return Array.from(allResults.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  private async semanticSearch(
    context: UserServiceContext,
    options: SearchOptions,
  ): Promise<ScoredSearchResult[]> {
    const { query, maxResults = 25 } = options;

    const vector = await this.embeddingGenerationService.generateEmbeddingString(query);

    // Distance threshold for pgvector cosine distance (0-2 range)
    // 0 = identical, 2 = opposite
    // Similarity score (1 - distance) ranges from -1 to 1
    // We want similarity > 0.5, which means distance < 0.5
    const distanceThreshold = 0.5;

    const sql = `
      SELECT
        entity_id,
        entity_type,
        1 - (embedding <-> $2) as score
      FROM
        ci_search.embeddings
      WHERE user_id = $1
        AND (embedding <-> $2) < $3
      ORDER BY score DESC
      LIMIT ${maxResults}
    `;

    const params = [context.userId, vector, distanceThreshold];

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

    const sql = `
      SELECT
        entity_id,
        entity_type,
        ts_rank(vector, websearch_to_tsquery('english', $2)) as score
      FROM
        ci_search.vectors
      WHERE user_id = $1
        AND vector @@ websearch_to_tsquery('english', $2)
      ORDER BY score DESC
      LIMIT ${maxResults}
    `;

    const params = [context.userId, query];

    const results = await this.vectorRepo.query(sql, params);

    const entities = results.map((row: ScoredRowResult) => ({
      id: row.entity_id,
      type: row.entity_type as IndexableEntity,
      score: parseFloat(row.score),
    }));

    return entities;
  }
}

function makeCompositeKey(type: IndexableEntity, id: string): string {
  return `${type}:${id}`;
}

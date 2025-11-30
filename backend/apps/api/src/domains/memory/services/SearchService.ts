import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EmbeddingService } from '@ci/domains/search';

export type SearchMode = 'semantic' | 'keyword' | 'hybrid' | 'auto';
export type SearchScope = 'entities' | 'facts' | 'documents' | 'messages';

export interface DatabaseSearchOptions {
  query: string;
  searchMode?: SearchMode;
  scopes?: SearchScope[];
  entityTypes?: string[];
  includeRelationships?: boolean;
  maxResults?: number;
  dateRange?: { start: Date; end: Date };
}

export interface SearchResultItem {
  id: string;
  type: 'entity' | 'fact' | 'document_chunk' | 'message';
  score: number;
  name?: string;
  content?: string;
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface DatabaseSearchResults {
  items: SearchResultItem[];
  totalResults: number;
  searchMode: SearchMode;
  executionTimeMs: number;
}

// Internal query result types
interface EntityQueryResult {
  id: string;
  type: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  score: string;
}

interface FactQueryResult {
  id: string;
  type: string;
  fact_statement: unknown;
  fact_type: string;
  source: string;
  score: string;
}

interface DocumentChunkQueryResult {
  id: string;
  type: string;
  content: string;
  section_title: string | null;
  document_id: string;
  document_title: string;
  score: string;
}

interface MessageQueryResult {
  id: string;
  type: string;
  content: string;
  role: string;
  created_at: Date;
  thread_id: string;
  thread_title: string | null;
  score: string;
}

@Injectable()
export class SearchService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly embeddingService: EmbeddingService,
  ) {}

  async search(userId: string, options: DatabaseSearchOptions): Promise<DatabaseSearchResults> {
    const startTime = Date.now();
    const searchMode = options.searchMode || 'auto';
    const maxResults = options.maxResults || 25;

    let results: SearchResultItem[];

    switch (searchMode) {
      case 'semantic':
        results = await this.semanticSearch(userId, options, maxResults);
        break;
      case 'keyword':
        results = await this.keywordSearch(userId, options, maxResults);
        break;
      case 'hybrid':
        results = await this.hybridSearch(userId, options, maxResults);
        break;
      case 'auto':
      default:
        results = await this.autoSearch(userId, options, maxResults);
        break;
    }

    return {
      items: results,
      totalResults: results.length,
      searchMode,
      executionTimeMs: Date.now() - startTime,
    };
  }

  private async semanticSearch(
    userId: string,
    options: DatabaseSearchOptions,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    // Generate embedding for the query
    const queryEmbedding = await this.embeddingService.generateEmbedding(options.query);

    const scopes = this.normalizeScopes(options.scopes);
    const results: SearchResultItem[] = [];

    // Search entities if in scope
    if (scopes.includes('entities')) {
      const entityResults = await this.semanticSearchEntities(userId, queryEmbedding, options, maxResults);
      results.push(...entityResults);
    }

    // Search facts if in scope
    if (scopes.includes('facts')) {
      const factResults = await this.semanticSearchFacts(userId, queryEmbedding, maxResults);
      results.push(...factResults);
    }

    // Search documents if in scope
    if (scopes.includes('documents')) {
      const docResults = await this.semanticSearchDocuments(userId, queryEmbedding, maxResults);
      results.push(...docResults);
    }

    // Search messages if in scope
    if (scopes.includes('messages')) {
      const messageResults = await this.semanticSearchMessages(userId, queryEmbedding, maxResults);
      results.push(...messageResults);
    }

    // Sort by score and limit
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  private async semanticSearchEntities(
    userId: string,
    queryEmbedding: number[],
    options: DatabaseSearchOptions,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const entityTypeFilter = options.entityTypes?.length ? `AND entity_type = ANY($3::text[])` : '';

    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const query = `
      SELECT 
        entity_id as id,
        'entity' as type,
        entity_type,
        name,
        description,
        properties,
        1 - (embedding <=> $1::vector) as score
      FROM entities
      WHERE owner_user_id = $2
        AND embedding IS NOT NULL
        ${entityTypeFilter}
      ORDER BY embedding <=> $1::vector
      LIMIT $${options.entityTypes?.length ? 4 : 3}
    `;

    const params = options.entityTypes?.length
      ? [embeddingStr, userId, options.entityTypes, maxResults]
      : [embeddingStr, userId, maxResults];

    const results = await this.dataSource.query(query, params);

    return results.map((row: EntityQueryResult) => ({
      id: row.id,
      type: 'entity' as const,
      score: parseFloat(row.score),
      name: row.name,
      content: row.description,
      properties: row.properties,
      metadata: {
        entityType: row.entity_type,
      },
    }));
  }

  private async semanticSearchFacts(
    userId: string,
    queryEmbedding: number[],
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const query = `
      SELECT 
        fact_id as id,
        'fact' as type,
        fact_statement,
        fact_type,
        source,
        1 - (fact_embedding <=> $1::vector) as score
      FROM facts
      WHERE fact_owner_id = $2
        AND fact_embedding IS NOT NULL
        AND is_current = TRUE
      ORDER BY fact_embedding <=> $1::vector
      LIMIT $3
    `;

    const results = await this.dataSource.query(query, [embeddingStr, userId, maxResults]);

    return results.map((row: FactQueryResult) => ({
      id: row.id,
      type: 'fact' as const,
      score: parseFloat(row.score),
      content: JSON.stringify(row.fact_statement),
      metadata: {
        factType: row.fact_type,
        source: row.source,
      },
    }));
  }

  private async semanticSearchDocuments(
    userId: string,
    queryEmbedding: number[],
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const query = `
      SELECT 
        dc.chunk_id as id,
        'document_chunk' as type,
        dc.content,
        dc.section_title,
        d.document_id,
        d.title as document_title,
        1 - (dc.chunk_embedding <=> $1::vector) as score
      FROM document_chunks dc
      JOIN documents d ON d.document_id = dc.document_id
      JOIN files f ON f.file_id = d.file_id
      WHERE f.owner_user_id = $2
        AND dc.chunk_embedding IS NOT NULL
      ORDER BY dc.chunk_embedding <=> $1::vector
      LIMIT $3
    `;

    const results = await this.dataSource.query(query, [embeddingStr, userId, maxResults]);

    return results.map((row: DocumentChunkQueryResult) => ({
      id: row.id,
      type: 'document_chunk' as const,
      score: parseFloat(row.score),
      content: row.content.substring(0, 300),
      metadata: {
        documentId: row.document_id,
        documentTitle: row.document_title,
        sectionTitle: row.section_title,
      },
    }));
  }

  private async semanticSearchMessages(
    userId: string,
    queryEmbedding: number[],
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const query = `
      SELECT 
        m.message_id as id,
        'message' as type,
        m.content,
        m.role,
        m.created_at,
        t.thread_id,
        t.title as thread_title,
        1 - (m.message_embedding <=> $1::vector) as score
      FROM messages m
      JOIN threads t ON t.thread_id = m.thread_id
      WHERE m.user_id = $2
        AND m.message_embedding IS NOT NULL
        AND m.is_deleted = FALSE
      ORDER BY m.message_embedding <=> $1::vector
      LIMIT $3
    `;

    const results = await this.dataSource.query(query, [embeddingStr, userId, maxResults]);

    return results.map((row: MessageQueryResult) => ({
      id: row.id,
      type: 'message' as const,
      score: parseFloat(row.score),
      content: row.content.substring(0, 300),
      metadata: {
        role: row.role,
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        createdAt: row.created_at,
      },
    }));
  }

  private async keywordSearch(
    userId: string,
    options: DatabaseSearchOptions,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const scopes = this.normalizeScopes(options.scopes);
    const results: SearchResultItem[] = [];

    // Search entities if in scope
    if (scopes.includes('entities')) {
      const entityResults = await this.keywordSearchEntities(userId, options, maxResults);
      results.push(...entityResults);
    }

    // Search facts if in scope
    if (scopes.includes('facts')) {
      const factResults = await this.keywordSearchFacts(userId, options.query, maxResults);
      results.push(...factResults);
    }

    // Search documents if in scope
    if (scopes.includes('documents')) {
      const docResults = await this.keywordSearchDocuments(userId, options.query, maxResults);
      results.push(...docResults);
    }

    // Search messages if in scope
    if (scopes.includes('messages')) {
      const messageResults = await this.keywordSearchMessages(userId, options.query, maxResults);
      results.push(...messageResults);
    }

    // Sort by score and limit
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  private async keywordSearchEntities(
    userId: string,
    options: DatabaseSearchOptions,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const entityTypeFilter = options.entityTypes?.length ? `AND entity_type = ANY($3::text[])` : '';

    const query = `
      SELECT 
        entity_id as id,
        'entity' as type,
        entity_type,
        name,
        description,
        properties,
        ts_rank(search_vector, websearch_to_tsquery('english', $1)) as score
      FROM entities
      WHERE owner_user_id = $2
        AND search_vector @@ websearch_to_tsquery('english', $1)
        ${entityTypeFilter}
      ORDER BY score DESC
      LIMIT $${options.entityTypes?.length ? 4 : 3}
    `;

    const params = options.entityTypes?.length
      ? [options.query, userId, options.entityTypes, maxResults]
      : [options.query, userId, maxResults];

    const results = await this.dataSource.query(query, params);

    return results.map((row: EntityQueryResult) => ({
      id: row.id,
      type: 'entity' as const,
      score: parseFloat(row.score),
      name: row.name,
      content: row.description,
      properties: row.properties,
      metadata: {
        entityType: row.entity_type,
      },
    }));
  }

  private async keywordSearchFacts(
    userId: string,
    searchQuery: string,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const query = `
      SELECT 
        fact_id as id,
        'fact' as type,
        fact_statement,
        fact_type,
        source,
        ts_rank(fact_search_vector, websearch_to_tsquery('english', $1)) as score
      FROM facts
      WHERE fact_owner_id = $2
        AND fact_search_vector @@ websearch_to_tsquery('english', $1)
        AND is_current = TRUE
      ORDER BY score DESC
      LIMIT $3
    `;

    const results = await this.dataSource.query(query, [searchQuery, userId, maxResults]);

    return results.map((row: FactQueryResult) => ({
      id: row.id,
      type: 'fact' as const,
      score: parseFloat(row.score),
      content: JSON.stringify(row.fact_statement),
      metadata: {
        factType: row.fact_type,
        source: row.source,
      },
    }));
  }

  private async keywordSearchDocuments(
    userId: string,
    searchQuery: string,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const query = `
      SELECT 
        dc.chunk_id as id,
        'document_chunk' as type,
        dc.content,
        dc.section_title,
        d.document_id,
        d.title as document_title,
        ts_rank(dc.content_search_vector, websearch_to_tsquery('english', $1)) as score
      FROM document_chunks dc
      JOIN documents d ON d.document_id = dc.document_id
      JOIN files f ON f.file_id = d.file_id
      WHERE f.owner_user_id = $2
        AND dc.content_search_vector @@ websearch_to_tsquery('english', $1)
      ORDER BY score DESC
      LIMIT $3
    `;

    const results = await this.dataSource.query(query, [searchQuery, userId, maxResults]);

    return results.map((row: DocumentChunkQueryResult) => ({
      id: row.id,
      type: 'document_chunk' as const,
      score: parseFloat(row.score),
      content: row.content.substring(0, 300),
      metadata: {
        documentId: row.document_id,
        documentTitle: row.document_title,
        sectionTitle: row.section_title,
      },
    }));
  }

  private async keywordSearchMessages(
    userId: string,
    searchQuery: string,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    const query = `
      SELECT 
        m.message_id as id,
        'message' as type,
        m.content,
        m.role,
        m.created_at,
        t.thread_id,
        t.title as thread_title,
        ts_rank(m.search_vector, websearch_to_tsquery('english', $1)) as score
      FROM messages m
      JOIN threads t ON t.thread_id = m.thread_id
      WHERE m.user_id = $2
        AND m.search_vector @@ websearch_to_tsquery('english', $1)
        AND m.is_deleted = FALSE
      ORDER BY score DESC
      LIMIT $3
    `;

    const results = await this.dataSource.query(query, [searchQuery, userId, maxResults]);

    return results.map((row: MessageQueryResult) => ({
      id: row.id,
      type: 'message' as const,
      score: parseFloat(row.score),
      content: row.content.substring(0, 300),
      metadata: {
        role: row.role,
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        createdAt: row.created_at,
      },
    }));
  }

  private async hybridSearch(
    userId: string,
    options: DatabaseSearchOptions,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    // Run both semantic and keyword searches in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearch(userId, options, maxResults * 2),
      this.keywordSearch(userId, options, maxResults * 2),
    ]);

    // Reciprocal Rank Fusion (RRF) - combine results with weighted scoring
    const fusedScores = new Map<string, number>();
    const k = 60; // RRF constant

    // Weight semantic results (60% weight)
    semanticResults.forEach((result, index) => {
      const rrfScore = 1 / (k + index + 1);
      fusedScores.set(result.id, (fusedScores.get(result.id) || 0) + rrfScore * 0.6);
    });

    // Weight keyword results (40% weight)
    keywordResults.forEach((result, index) => {
      const rrfScore = 1 / (k + index + 1);
      fusedScores.set(result.id, (fusedScores.get(result.id) || 0) + rrfScore * 0.4);
    });

    // Merge results and apply fused scores
    const allResults = new Map<string, SearchResultItem>();
    [...semanticResults, ...keywordResults].forEach((result) => {
      if (!allResults.has(result.id)) {
        allResults.set(result.id, {
          ...result,
          score: fusedScores.get(result.id) || 0,
        });
      }
    });

    // Sort by fused score and limit
    return Array.from(allResults.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  private async autoSearch(
    userId: string,
    options: DatabaseSearchOptions,
    maxResults: number,
  ): Promise<SearchResultItem[]> {
    // Auto-detect search strategy based on query characteristics
    const wordCount = options.query.trim().split(/\s+/).length;
    const hasSpecialChars = /[@.:\-_]/.test(options.query);

    // Short queries or those with special characters (emails, IDs) → keyword
    if (wordCount <= 3 || hasSpecialChars) {
      return this.keywordSearch(userId, options, maxResults);
    }

    // Long natural language queries → semantic
    if (wordCount >= 8) {
      return this.semanticSearch(userId, options, maxResults);
    }

    // Medium length queries → hybrid (best of both)
    return this.hybridSearch(userId, options, maxResults);
  }

  private normalizeScopes(scopes?: SearchScope[]): SearchScope[] {
    // If no scopes provided, search everything
    if (!scopes || scopes.length === 0) {
      return ['entities', 'facts', 'documents', 'messages'];
    }

    return scopes;
  }
}

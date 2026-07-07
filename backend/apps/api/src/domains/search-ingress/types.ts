import type { IndexableEntity } from '@ci/domains/search-next';

export interface UpsertEmbeddingDto {
  entityType: IndexableEntity;
  entityId: string;
  embedding: number[];
}

/**
 * Text with an associated search weight.
 * Higher weights indicate more important fields (e.g., name vs properties).
 * Weights are mapped to PostgreSQL tsvector weight categories:
 *   - weight >= 8 → 'A' (highest priority, e.g., names, titles)
 *   - weight >= 4 → 'B' (high priority, e.g., descriptions)
 *   - weight >= 2 → 'C' (medium priority, e.g., categories, tags)
 *   - weight < 2  → 'D' (low priority, e.g., bulk content, properties)
 */
export interface WeightedText {
  text: string;
  weight: number;
}

export interface UpsertVectorDto {
  entityType: IndexableEntity;
  entityId: string;
  searchableText: WeightedText[];
}

export interface RemoveEmbeddingDto {
  entityType: IndexableEntity;
  entityId: string;
}

export interface RecordIndexSkipDto {
  entityType: IndexableEntity;
  entityId: string;
  /** Why the row was not embedded (e.g. an `embedSkipReason` value). */
  reason: string;
}

export interface ClearIndexSkipDto {
  entityType: IndexableEntity;
  entityId: string;
}

export interface RemoveVectorDto {
  entityType: IndexableEntity;
  entityId: string;
}

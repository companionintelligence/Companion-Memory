import type { IndexableEntity } from '@ci/domains/search-next';

export interface UpsertEmbeddingDto {
  entityType: IndexableEntity;
  entityId: string;
  embedding: number[];
}

export interface UpsertVectorDto {
  entityType: IndexableEntity;
  entityId: string;
  searchableText: string[];
}

export interface RemoveEmbeddingDto {
  entityType: IndexableEntity;
  entityId: string;
}

export interface RemoveVectorDto {
  entityType: IndexableEntity;
  entityId: string;
}

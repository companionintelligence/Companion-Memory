export const INDEXABLE_ENTITIES = [
  'answer',
  'browser-activity',
  'communication',
  'concept',
  'content',
  'event',
  'file',
  'item',
  // Raw conversation fragments, embedded for the recall "naive RAG" channel.
  // Surfaced ONLY via SearchService.searchMessages; entity/graph searches
  // exclude this type so the two retrieval channels stay separate.
  'message',
  'note',
  'person',
  'place',
  'thread',
] as const;

export type IndexableEntity = (typeof INDEXABLE_ENTITIES)[number];

export const TAGGABLE_ENTITIES = [
  'action',
  'browser-activity',
  'communication',
  'concept',
  'content',
  'event',
  'file',
  'item',
  'note',
  'person',
  'place',
  'thread',
] as const;

export type TaggableEntity = (typeof TAGGABLE_ENTITIES)[number];

export interface EntityIdentifier<T> {
  type: T;
  id: string;
}

export interface CreateTagDto {
  id?: string;
  label: string;
  description?: string;
  forUserId?: string;
}

export interface UpdateTagDto {
  label?: string;
  description?: string;
}

export interface TagEntitiesDto {
  labels: string[];
  forUserId?: string;
  entities: EntityIdentifier<TaggableEntity>[];
}

export type SearchResult = {
  type: IndexableEntity;
  id: string;
};

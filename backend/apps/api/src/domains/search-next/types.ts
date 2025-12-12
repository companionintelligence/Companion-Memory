export type IndexableEntity = 'person';

export type TaggableEntity = 'person';

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
  label: string;
  forUserId?: string;
  entities: EntityIdentifier<TaggableEntity>[];
}

export type SearchResult = {
  type: string;
  entityId: string;
};

export type RawEmbedding = {
  id: string;
  entity_id: string;
  entity_type: string;
  user_id: string;
};

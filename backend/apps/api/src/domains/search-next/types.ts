export type IndexableEntity = 'communication' | 'person';

export type TaggableEntity = 'action' | 'communication' | 'person' | 'thread';

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

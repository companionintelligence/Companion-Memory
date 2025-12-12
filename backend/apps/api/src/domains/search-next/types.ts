export type IndexableEntity = 'person';

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

export interface EntityIdentifier {
  type: IndexableEntity;
  id: string;
}

export interface TagEntitiesDto {
  label: string;
  forUserId?: string;
  entities: EntityIdentifier[];
}

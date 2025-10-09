export const ENTITY_TYPES = [
  'Person',
  'Concept',
  'Location',
  'Object',
  'Event',
  'Goal',
  'Place',
  'Contact',
  'Content',
  'Thing',
  'Tag',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  'PREFERS',
  'DISLIKES',
  'KNOWS',
  'WORKS_WITH',
  'COLLABORATED_WITH',
  'LIVES_IN',
  'STUDIES_AT',
  'WORKS_AT',
  'LIVES_NEAR',
  'VISITED',
  'OWNS',
  'INTERESTED_IN',
  'CREATED',
  'MENTORED',
  'TAUGHT',
  'LEARNED_FROM',
  'PARTICIPATED_IN',
  'SPOUSE',
  'PARENT_OF',
  'CHILD_OF',
  'SIBLING_OF',
  'FAMILY_MEMBER',
  'LOCATED_AT',
  'HAPPENED_AT',
  'AT_LOCATION',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export interface QueryOptions {
  orderBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
}

export interface RelationshipLoadOptions {
  loadRelationships?: boolean;
  relationshipTypes?: string[];
  direction?: 'inbound' | 'outbound' | 'both';
  maxDepth?: number;
}

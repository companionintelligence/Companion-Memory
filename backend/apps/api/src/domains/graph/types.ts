import { type Relationship } from './entities/RelationshipEntity';

export enum RelationshipType {
  PREFERS = 'PREFERS',
  DISLIKES = 'DISLIKES',
  KNOWS = 'KNOWS',
  FRIENDS_WITH = 'FRIENDS_WITH',
  WORKS_WITH = 'WORKS_WITH',
  COLLABORATED_WITH = 'COLLABORATED_WITH',
  LIVES_IN = 'LIVES_IN',
  STUDIES_AT = 'STUDIES_AT',
  WORKS_AT = 'WORKS_AT',
  LIVES_NEAR = 'LIVES_NEAR',
  VISITED = 'VISITED',
  OWNS = 'OWNS',
  INTERESTED_IN = 'INTERESTED_IN',
  CREATED = 'CREATED',
  MENTORED = 'MENTORED',
  TAUGHT = 'TAUGHT',
  LEARNED_FROM = 'LEARNED_FROM',
  PARTICIPATED_IN = 'PARTICIPATED_IN',
  SPOUSE = 'SPOUSE',
  PARENT_OF = 'PARENT_OF',
  CHILD_OF = 'CHILD_OF',
  SIBLING_OF = 'SIBLING_OF',
  FAMILY_MEMBER = 'FAMILY_MEMBER',
  LOCATED_AT = 'LOCATED_AT',
  HAPPENED_AT = 'HAPPENED_AT',
  AT_LOCATION = 'AT_LOCATION',
}

export type CreateRelationshipDto = Optional<
  Omit<Relationship, 'userId' | 'createdAt' | 'updatedAt' | 'type'>,
  'id' | 'strength' | 'isBidirectional' | 'properties' | 'startDate' | 'endDate'
> & {
  type: keyof typeof RelationshipType;
};

export type UpdateRelationshipDto = Omit<CreateRelationshipDto, 'id' | 'fromNodeId' | 'toNodeId' | 'type'>;

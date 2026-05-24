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
  MET_WITH = 'MET_WITH',
  EMAILED = 'EMAILED',
  RECEIVED_EMAIL_FROM = 'RECEIVED_EMAIL_FROM',
  ORGANIZED_EVENT_WITH = 'ORGANIZED_EVENT_WITH',
  EDITED_WITH = 'EDITED_WITH',
  IS = 'IS',
  LIVES_WITH = 'LIVES_WITH',
  ASSOCIATED_WITH = 'ASSOCIATED_WITH',
  RECEIVED = 'RECEIVED',
  SENT = 'SENT',
}

export type CreateRelationshipDto = Optional<
  Omit<Relationship, 'userId' | 'createdAt' | 'updatedAt' | 'type'>,
  'id' | 'strength' | 'isBidirectional' | 'properties' | 'startDate' | 'endDate'
> & {
  type: keyof typeof RelationshipType;
};

export type UpdateRelationshipDto = Omit<
  CreateRelationshipDto,
  'id' | 'fromNodeId' | 'toNodeId' | 'fromNodeType' | 'toNodeType' | 'type'
>;

export const RelationshipMap = {
  person: {
    communication: [RelationshipType.SENT, RelationshipType.RECEIVED],
    concept: [RelationshipType.PREFERS, RelationshipType.DISLIKES, RelationshipType.INTERESTED_IN],
    content: [RelationshipType.CREATED],
    event: [RelationshipType.PARTICIPATED_IN],
    item: [RelationshipType.OWNS, RelationshipType.CREATED],
    note: [RelationshipType.CREATED],
    person: [
      RelationshipType.KNOWS,
      RelationshipType.FRIENDS_WITH,
      RelationshipType.WORKS_WITH,
      RelationshipType.COLLABORATED_WITH,
      RelationshipType.SPOUSE,
      RelationshipType.PARENT_OF,
      RelationshipType.CHILD_OF,
      RelationshipType.SIBLING_OF,
      RelationshipType.FAMILY_MEMBER,
      RelationshipType.MENTORED,
      RelationshipType.TAUGHT,
      RelationshipType.LEARNED_FROM,
      RelationshipType.MET_WITH,
      RelationshipType.EMAILED,
      RelationshipType.RECEIVED_EMAIL_FROM,
      RelationshipType.ORGANIZED_EVENT_WITH,
      RelationshipType.EDITED_WITH,
      RelationshipType.LIVES_WITH,
      RelationshipType.ASSOCIATED_WITH,
      RelationshipType.IS,
    ],
    place: [
      RelationshipType.LIVES_IN,
      RelationshipType.LIVES_NEAR,
      RelationshipType.STUDIES_AT,
      RelationshipType.WORKS_AT,
      RelationshipType.VISITED,
      RelationshipType.OWNS,
    ],
    thread: [RelationshipType.CREATED],
  },
  event: {
    place: [RelationshipType.LOCATED_AT, RelationshipType.HAPPENED_AT, RelationshipType.AT_LOCATION],
  },
};

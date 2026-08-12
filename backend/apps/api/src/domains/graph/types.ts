import { type Relationship } from './entities/RelationshipEntity';

/**
 * Canonical relationship vocabulary for the life-graph matrix (#1945).
 * Write-time aliases live in {@link normalizeRelationship}; the allowlist
 * of which types may connect which CTI nodes is {@link RelationshipMap}.
 */
export enum RelationshipType {
  // Preferences / concepts
  PREFERS = 'PREFERS',
  DISLIKES = 'DISLIKES',
  INTERESTED_IN = 'INTERESTED_IN',
  PURSUES = 'PURSUES',
  SKILLED_IN = 'SKILLED_IN',
  AVOIDS = 'AVOIDS',
  PRACTICES = 'PRACTICES',
  LEARNS = 'LEARNS',
  CELEBRATES = 'CELEBRATES',
  ABOUT = 'ABOUT',
  MENTIONS = 'MENTIONS',

  // Person ↔ person
  KNOWS = 'KNOWS',
  FRIENDS_WITH = 'FRIENDS_WITH',
  PARTNER_OF = 'PARTNER_OF',
  SPOUSE = 'SPOUSE',
  PARENT_OF = 'PARENT_OF',
  CHILD_OF = 'CHILD_OF', // write-time alias → PARENT_OF swapped
  SIBLING_OF = 'SIBLING_OF',
  FAMILY_MEMBER = 'FAMILY_MEMBER',
  WORKS_WITH = 'WORKS_WITH',
  COLLABORATED_WITH = 'COLLABORATED_WITH',
  INDUSTRY_CONNECTION = 'INDUSTRY_CONNECTION',
  SHARES_INTERESTS_WITH = 'SHARES_INTERESTS_WITH',
  MENTORED = 'MENTORED',
  TAUGHT = 'TAUGHT',
  LEARNED_FROM = 'LEARNED_FROM', // write-time alias → TAUGHT swapped
  CARES_FOR = 'CARES_FOR',
  CLIENT_OF = 'CLIENT_OF',
  EMERGENCY_CONTACT_FOR = 'EMERGENCY_CONTACT_FOR',
  SUPPORTS = 'SUPPORTS',
  EMPLOYS = 'EMPLOYS',
  LIVES_WITH = 'LIVES_WITH',
  MET_WITH = 'MET_WITH',
  EMAILED = 'EMAILED',
  RECEIVED_EMAIL_FROM = 'RECEIVED_EMAIL_FROM', // write-time alias → EMAILED swapped
  MESSAGED = 'MESSAGED',
  CALLED = 'CALLED',
  COMMUNICATES_WITH = 'COMMUNICATES_WITH',
  ORGANIZED_EVENT_WITH = 'ORGANIZED_EVENT_WITH',
  EDITED_WITH = 'EDITED_WITH',

  // Person ↔ place / group / item / …
  LIVES_IN = 'LIVES_IN',
  LIVES_NEAR = 'LIVES_NEAR',
  VISITED = 'VISITED',
  FREQUENTS = 'FREQUENTS',
  OWNS = 'OWNS',
  CREATED = 'CREATED',
  USES = 'USES',
  WANTS = 'WANTS',
  MAINTAINS = 'MAINTAINS',
  BORROWS = 'BORROWS',
  MEMBER_OF = 'MEMBER_OF',
  DONATES_TO = 'DONATES_TO',
  SUBSCRIBES_TO = 'SUBSCRIBES_TO',
  PARTICIPATED_IN = 'PARTICIPATED_IN',
  SENT = 'SENT',
  RECEIVED = 'RECEIVED',
  EDITED = 'EDITED',
  SIGNED = 'SIGNED',

  // Places / items / structure
  LOCATED_AT = 'LOCATED_AT',
  HAPPENED_AT = 'HAPPENED_AT', // write-time alias → LOCATED_AT
  AT_LOCATION = 'AT_LOCATION', // write-time alias → LOCATED_AT
  PART_OF = 'PART_OF',
  DOCUMENTS = 'DOCUMENTS',
  ATTACHED_TO = 'ATTACHED_TO',
  DERIVED_FROM = 'DERIVED_FROM',
  REPLIES_TO = 'REPLIES_TO',
  ASSOCIATED_WITH = 'ASSOCIATED_WITH',

  // Migration-only (normalize job retypes to MEMBER_OF Group)
  STUDIES_AT = 'STUDIES_AT',
  WORKS_AT = 'WORKS_AT',

  // Rejected at write (kept so resolveType can name it)
  IS = 'IS',
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

/**
 * Allowlist: from CTI node type → to CTI node type → permitted relationship types.
 * Keys are lowercase explorer/service node types (`person`, `place`, …).
 * Empty cell = decision; populating one is a reviewed change (#1945).
 */
export const RelationshipMap = {
  person: {
    person: [
      RelationshipType.KNOWS,
      RelationshipType.FRIENDS_WITH,
      RelationshipType.PARTNER_OF,
      RelationshipType.SPOUSE,
      RelationshipType.PARENT_OF,
      RelationshipType.SIBLING_OF,
      RelationshipType.FAMILY_MEMBER,
      RelationshipType.WORKS_WITH,
      RelationshipType.COLLABORATED_WITH,
      RelationshipType.INDUSTRY_CONNECTION,
      RelationshipType.SHARES_INTERESTS_WITH,
      RelationshipType.MENTORED,
      RelationshipType.TAUGHT,
      RelationshipType.CARES_FOR,
      RelationshipType.CLIENT_OF,
      RelationshipType.EMERGENCY_CONTACT_FOR,
      RelationshipType.SUPPORTS,
      RelationshipType.EMPLOYS,
      RelationshipType.LIVES_WITH,
      RelationshipType.MET_WITH,
      RelationshipType.EMAILED,
      RelationshipType.MESSAGED,
      RelationshipType.CALLED,
      RelationshipType.COMMUNICATES_WITH,
      RelationshipType.ORGANIZED_EVENT_WITH,
      RelationshipType.EDITED_WITH,
      RelationshipType.ASSOCIATED_WITH,
    ],
    pet: [RelationshipType.OWNS, RelationshipType.CARES_FOR],
    group: [RelationshipType.MEMBER_OF, RelationshipType.DONATES_TO, RelationshipType.SUBSCRIBES_TO],
    place: [
      RelationshipType.LIVES_IN,
      RelationshipType.OWNS,
      RelationshipType.VISITED,
      RelationshipType.FREQUENTS,
      RelationshipType.LIVES_NEAR,
      RelationshipType.WORKS_AT,
      RelationshipType.STUDIES_AT,
    ],
    item: [
      RelationshipType.OWNS,
      RelationshipType.CREATED,
      RelationshipType.USES,
      RelationshipType.WANTS,
      RelationshipType.MAINTAINS,
      RelationshipType.BORROWS,
    ],
    event: [RelationshipType.PARTICIPATED_IN],
    content: [RelationshipType.CREATED],
    communication: [RelationshipType.SENT, RelationshipType.RECEIVED],
    concept: [
      RelationshipType.PREFERS,
      RelationshipType.DISLIKES,
      RelationshipType.INTERESTED_IN,
      RelationshipType.PURSUES,
      RelationshipType.SKILLED_IN,
      RelationshipType.AVOIDS,
      RelationshipType.PRACTICES,
      RelationshipType.LEARNS,
      RelationshipType.CELEBRATES,
    ],
    file: [RelationshipType.CREATED, RelationshipType.OWNS, RelationshipType.EDITED, RelationshipType.SIGNED],
  },
  pet: {
    group: [RelationshipType.MEMBER_OF],
    place: [RelationshipType.LIVES_IN],
    event: [RelationshipType.PARTICIPATED_IN],
  },
  group: {
    group: [RelationshipType.PART_OF],
    place: [RelationshipType.LOCATED_AT, RelationshipType.OWNS],
    item: [RelationshipType.OWNS],
    event: [RelationshipType.PARTICIPATED_IN],
    concept: [RelationshipType.ABOUT],
  },
  place: {
    place: [RelationshipType.PART_OF],
  },
  item: {
    place: [RelationshipType.LOCATED_AT],
    item: [RelationshipType.PART_OF],
    concept: [RelationshipType.ASSOCIATED_WITH],
  },
  event: {
    place: [RelationshipType.LOCATED_AT],
    event: [RelationshipType.PART_OF],
    concept: [RelationshipType.ABOUT],
  },
  content: {
    person: [RelationshipType.MENTIONS],
    pet: [RelationshipType.MENTIONS],
    group: [RelationshipType.MENTIONS],
    place: [RelationshipType.MENTIONS],
    item: [RelationshipType.MENTIONS],
    event: [RelationshipType.DOCUMENTS, RelationshipType.PART_OF],
    content: [RelationshipType.DERIVED_FROM],
    concept: [RelationshipType.ABOUT],
  },
  communication: {
    event: [RelationshipType.ABOUT],
    communication: [RelationshipType.REPLIES_TO],
    concept: [RelationshipType.ABOUT],
  },
  concept: {
    concept: [RelationshipType.PART_OF, RelationshipType.ASSOCIATED_WITH],
  },
  file: {
    event: [RelationshipType.ATTACHED_TO],
    content: [RelationshipType.ATTACHED_TO],
    communication: [RelationshipType.ATTACHED_TO],
    file: [RelationshipType.DERIVED_FROM],
  },
} as const;

/**
 * Graph `entity_type` vocabulary. Canonical CTI surface (life-graph matrix):
 * Person · Pet · Group · Place · Item · Event · Content · Communication · Concept · File.
 * Legacy aliases (Location, Object, Thing, Contact, Goal, Tag) remain readable during migration.
 */
export const ENTITY_TYPES = [
  'Person',
  'Pet',
  'Group',
  'Concept',
  'Location', // legacy Place discriminator — explorer maps place → both
  'Object',
  'Event',
  'Goal',
  'File',
  'Place',
  'Contact',
  'Content',
  'Communication',
  'Item',
  'Thing',
  'Tag',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Bridges the memory explorer's entity-type vocabulary (GraphQL/search-index types such as
 * `person`, `place`, `item`) to the graph's NER-style `entity_type` values. Used so the Graph
 * view can honor the explorer's entity-type filter (view parity).
 *
 * One vocabulary direction: explorer → graph. Canonical mappings are
 * `person` → `Person`, `place` → `Location`+`Place` (rename in flight),
 * `item` → `Object`/`Item`. Notes fold to Content (user_created provenance) and
 * appear under `content`. Explorer types with no graph representation map to `[]`.
 * Connective CTI types (Concept, Pet, Group) are never excluded by the type filter.
 */
export const EXPLORER_TO_GRAPH_ENTITY_TYPES: Record<string, string[]> = {
  person: ['Person', 'Contact'],
  place: ['Location', 'Place'],
  item: ['Object', 'Item', 'Thing'],
  event: ['Event'],
  content: ['Content'],
  file: ['File'],
  note: ['Content'], // Note → Content fold (#1945)
  communication: ['Communication'],
  'browser-activity': ['Event', 'Content'],
};

/**
 * Given the explorer entity types the user currently has *selected*, returns the set of graph
 * `entity_type` values to exclude — i.e. the graph types mapped from the *deselected* explorer
 * types. Connective graph types (those not mapped from any explorer type) are never returned,
 * so they always survive the filter.
 *
 * Callers decide whether a filter is active: only invoke this when the user has actually
 * narrowed the selection. An empty `selectedExplorerTypes` therefore means "nothing selected"
 * and excludes *every* mappable graph type (keeping only connective types). Passing every
 * explorer type returns `[]` (no exclusions).
 */
export function graphTypesToExclude(selectedExplorerTypes: string[]): string[] {
  const allExplorerTypes = Object.keys(EXPLORER_TO_GRAPH_ENTITY_TYPES);
  const selected = new Set(selectedExplorerTypes);

  // Everything selected -> nothing to exclude.
  if (allExplorerTypes.every((type) => selected.has(type))) {
    return [];
  }

  const excluded = new Set<string>();
  for (const explorerType of allExplorerTypes) {
    if (selected.has(explorerType)) {
      continue;
    }

    for (const graphType of EXPLORER_TO_GRAPH_ENTITY_TYPES[explorerType]) {
      excluded.add(graphType);
    }
  }

  return Array.from(excluded);
}

/** Mirror of graph RelationshipType enum values used by memory-domain filters. */
export const RELATIONSHIP_TYPES = [
  'PREFERS',
  'DISLIKES',
  'INTERESTED_IN',
  'PURSUES',
  'ABOUT',
  'MENTIONS',
  'KNOWS',
  'FRIENDS_WITH',
  'PARTNER_OF',
  'SPOUSE',
  'PARENT_OF',
  'CHILD_OF',
  'SIBLING_OF',
  'FAMILY_MEMBER',
  'WORKS_WITH',
  'COLLABORATED_WITH',
  'INDUSTRY_CONNECTION',
  'SHARES_INTERESTS_WITH',
  'MENTORED',
  'TAUGHT',
  'LEARNED_FROM',
  'CARES_FOR',
  'CLIENT_OF',
  'LIVES_WITH',
  'MET_WITH',
  'EMAILED',
  'RECEIVED_EMAIL_FROM',
  'MESSAGED',
  'CALLED',
  'COMMUNICATES_WITH',
  'ORGANIZED_EVENT_WITH',
  'EDITED_WITH',
  'LIVES_IN',
  'STUDIES_AT',
  'WORKS_AT',
  'LIVES_NEAR',
  'VISITED',
  'FREQUENTS',
  'OWNS',
  'CREATED',
  'USES',
  'MEMBER_OF',
  'PARTICIPATED_IN',
  'SENT',
  'RECEIVED',
  'LOCATED_AT',
  'HAPPENED_AT',
  'AT_LOCATION',
  'PART_OF',
  'DOCUMENTS',
  'ATTACHED_TO',
  'DERIVED_FROM',
  'REPLIES_TO',
  'ASSOCIATED_WITH',
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

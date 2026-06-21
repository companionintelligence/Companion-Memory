export const ENTITY_TYPES = [
  'Person',
  'Concept',
  'Location',
  'Object',
  'Event',
  'Goal',
  'File',
  'Place',
  'Contact',
  'Content',
  'Thing',
  'Tag',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Bridges the memory explorer's entity-type vocabulary (GraphQL/search-index types such as
 * `person`, `place`, `item`) to the graph's NER-style `entity_type` values. Used so the Graph
 * view can honor the explorer's entity-type filter (view parity).
 *
 * Note the vocabularies only partially overlap and names differ (`place` -> `Location`,
 * `item` -> `Object`/`Thing`). Explorer types with no graph representation map to `[]`.
 * Graph types absent from any value here (e.g. `Concept`, `Goal`, `Tag`) have no explorer
 * equivalent and are treated as "connective" nodes — never excluded by the type filter.
 */
export const EXPLORER_TO_GRAPH_ENTITY_TYPES: Record<string, string[]> = {
  person: ['Person', 'Contact'],
  place: ['Location', 'Place'],
  item: ['Object', 'Thing', 'Item'],
  event: ['Event'],
  content: ['Content'],
  file: ['File'],
  note: [],
  communication: [],
  'browser-activity': [],
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
  'SENT',
  'RECEIVED',
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

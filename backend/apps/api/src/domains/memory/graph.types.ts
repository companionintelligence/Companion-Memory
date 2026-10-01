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
  // The catalog MODEL a unit is an INSTANCE_OF. Distinct from Item/Object/Thing,
  // which are the units themselves: one Product node, N Item nodes pointing at
  // it. Must satisfy the ci.entities CHECK `^[A-Z][A-Za-z]*$`.
  'Product',
  'Tag',
  // A Facebook Page the user liked (TransformFacebookLikes). No CTI table and no
  // per-type service, but ci.entities holds rows under this spelling.
  'Organization',
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
  item: ['Object', 'Item', 'Thing', 'Product'],
  event: ['Event'],
  content: ['Content'],
  file: ['File'],
  note: ['Content'], // Note → Content fold (#1945)
  communication: ['Communication'],
  'browser-activity': ['Event', 'Content'],
};

/**
 * Where the source record behind a graph node lives.
 *
 * `entity` — the node IS the record: Person/Place/Concept are stored in `ci.entities` itself
 *   (single-table inheritance), so `entity_id` is already the GraphQL id.
 * `linked` — the node MIRRORS a record in its own table (`ci.events`, `ci.communications`,
 *   `ci.content`, `ci.files`, `ci.objects`); `linked_id` is the GraphQL id. Ingest happens to
 *   reuse the source uuid as `entity_id` for most of these, but `File` is proof that is a
 *   coincidence and not a contract — resolve through `linked_id`.
 */
type GraphSourceOrigin = 'entity' | 'linked';

/**
 * Graph `entity_type` → the explorer resource its node stands for, so a node clicked on the
 * canvas can be opened in the same detail drawer List/Gallery/Map use. The resource names are
 * the `GlobalUID` vocabulary the GraphQL `node(id:)` query decodes.
 *
 * Graph types with no addressable record (Pet, Group, Goal, Tag, …) are absent: those nodes fall
 * back to the graph's own name/type card rather than resolving to something that doesn't exist.
 */
export const GRAPH_TYPE_TO_SOURCE: Record<string, { resourceType: string; origin: GraphSourceOrigin }> = {
  Person: { resourceType: 'person', origin: 'entity' },
  Contact: { resourceType: 'person', origin: 'entity' },
  Place: { resourceType: 'place', origin: 'entity' },
  Location: { resourceType: 'place', origin: 'entity' },
  Concept: { resourceType: 'concept', origin: 'entity' },
  Item: { resourceType: 'item', origin: 'linked' },
  Object: { resourceType: 'item', origin: 'linked' },
  Thing: { resourceType: 'item', origin: 'linked' },
  Event: { resourceType: 'event', origin: 'linked' },
  Content: { resourceType: 'content', origin: 'linked' },
  Communication: { resourceType: 'communication', origin: 'linked' },
  File: { resourceType: 'file', origin: 'linked' },
};

/**
 * Resolve a graph node to the explorer record it stands for, or `null` when the node has no
 * addressable record (unmapped graph type, or a mirror node whose `linked_id` was never written).
 */
export function graphNodeSourceRef(node: {
  entity_type: string;
  entity_id: string;
  linked_id?: string | null;
}): { type: string; id: string } | null {
  const mapping = GRAPH_TYPE_TO_SOURCE[node.entity_type];
  if (!mapping) {
    return null;
  }

  const id = mapping.origin === 'entity' ? node.entity_id : node.linked_id;

  return id ? { type: mapping.resourceType, id } : null;
}

/** `valid_entity_type`, the CHECK on `ci.entities.entity_type`: letters only, a capital first. */
const STORABLE_ENTITY_TYPE = /^[A-Z][A-Za-z]*$/;

/** Each type in {@link ENTITY_TYPES}, under its lower-cased spelling. */
const KNOWN_ENTITY_TYPES = new Map<string, EntityType>(
  ENTITY_TYPES.map((type) => [type.toLowerCase(), type]),
);

/**
 * The spelling `ci.entities` stores a graph type under. A type in {@link ENTITY_TYPES} comes back
 * in its own spelling whatever case and surrounding whitespace it arrived in — `person` is
 * `Person`, ` PLACE ` is `Place` — and any other type comes back exactly as given: a model may name
 * a type the graph has never held, and picking a spelling for it is not this function's call.
 *
 * The spelling is not cosmetic. `valid_entity_type` refuses a lower-case first letter outright, so
 * a `person` write fails the statement. A `PERSON` one is stored, and is then invisible to
 * PersonService, whose TypeORM STI child repository matches `entity_type = 'Person'` exactly, as do
 * the person search sweeps. `entities_linked_uniq` and an importer's upsert coordinate compare the
 * type byte for byte, so a `PERSON` also lands beside a `Person` twin on the same linked key.
 */
export function canonicalEntityType(type: string): string {
  return KNOWN_ENTITY_TYPES.get(type.trim().toLowerCase()) ?? type;
}

/** Whether `ci.entities` can store this spelling at all (`valid_entity_type`). */
export function isStorableEntityType(type: string): boolean {
  return STORABLE_ENTITY_TYPE.test(type);
}

/**
 * Whether `requested` names the type `stored` already is: in another case (`person` for a
 * Person), or as another name for it (`contact` for a Person, `place` for a Location, `thing` for
 * an Item). Two graph types name the same thing when their nodes stand for the same kind of record
 * in {@link GRAPH_TYPE_TO_SOURCE}, which groups them exactly as `GRAPH_TYPE_ALIASES` in
 * `@ci/common/embeddings` does for search.
 *
 * A write that names the stored type this way is not a retype. `entity_type` is half the coordinate
 * an importer upserts on, so turning an imported Location into a Place detaches it and the next
 * import mints a second one beside it. A Person turned into a Contact also drops out of
 * PersonService.
 */
export function sameEntityType(stored: string, requested: string): boolean {
  const storedType = canonicalEntityType(stored);
  const requestedType = canonicalEntityType(requested);

  if (storedType.trim().toLowerCase() === requestedType.trim().toLowerCase()) {
    return true;
  }

  const storedKind = GRAPH_TYPE_TO_SOURCE[storedType];
  const requestedKind = GRAPH_TYPE_TO_SOURCE[requestedType];

  return Boolean(storedKind && requestedKind && storedKind.resourceType === requestedKind.resourceType);
}

/**
 * Given the explorer entity types the user currently has *selected*, returns the set of graph
 * `entity_type` values to exclude — i.e. the graph types mapped from the *deselected* explorer
 * types, MINUS every graph type a *selected* explorer type maps to. Connective graph types
 * (those not mapped from any explorer type) are never returned, so they always survive the
 * filter.
 *
 * The subtraction is what makes the mapping's many-to-many shape safe. It is not one-to-one in
 * either direction: `note` and `content` both map to `Content`, and `browser-activity` maps to
 * `Event` *and* `Content`. Building the exclusion set purely from the deselected types therefore
 * excluded the very type the user had selected — picking "Events" alone excluded `Event` (via
 * the deselected `browser-activity`) and left the canvas painting Concepts. A selection always
 * wins over a deselection that happens to share a graph type.
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

  // Graph types the selection asks for. These can never be excluded, however many deselected
  // explorer types also map onto them.
  const kept = new Set<string>();
  for (const explorerType of selected) {
    for (const graphType of EXPLORER_TO_GRAPH_ENTITY_TYPES[explorerType] ?? []) {
      kept.add(graphType);
    }
  }

  const excluded = new Set<string>();
  for (const explorerType of allExplorerTypes) {
    if (selected.has(explorerType)) {
      continue;
    }

    for (const graphType of EXPLORER_TO_GRAPH_ENTITY_TYPES[explorerType]) {
      if (kept.has(graphType)) {
        continue;
      }

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
  // Object identity. Each must satisfy the ci.relationships CHECK
  // `^[A-Z_][A-Z0-9_]*$`.
  //
  // INSTANCE_OF is the product/instance edge — the mug on the desk is an
  // instance of a catalog model — and is what makes "how many of these do I
  // own" answerable in the graph rather than only in SQL.
  'INSTANCE_OF',
  // Where a thing was bought: PURCHASED_AT takes a place, PURCHASED_FROM takes
  // a merchant. Separate edges because a store and its location are different
  // nodes, and collapsing them loses whichever one the receipt actually named.
  'PURCHASED_AT',
  'PURCHASED_FROM',
  // A confirmed sighting of a thing at a place.
  'SEEN_AT',
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

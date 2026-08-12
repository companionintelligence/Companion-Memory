import { RelationshipType } from '@ci/domains/graph';

/**
 * One row of the deterministic-edge matrix: a source table's already-resolved
 * linkage column projected into a `ci.relationships` edge.
 *
 * The people-linking jobs (extract-people / link-communications / link-events
 * and the `enrich.person_link` pipeline stages) resolve raw metadata into
 * entity-id columns on the source rows — but nothing turned those columns into
 * graph edges, so the traversal (which only reads `ci.relationships`) never
 * saw them. Each rule here is a pure projection of one such column: no LLM, no
 * heuristics, re-runnable, and deterministic by construction (the directed
 * (from, to, type) unique index collapses re-runs).
 *
 * Rules are consumed by DeterministicEdgeBackfillService, which wraps the
 * fragments below into a windowed INSERT … SELECT that also resolves each
 * endpoint through its merge tombstone (`entities.merged_into_entity_id`) so
 * edges always land on the canonical, deduplicated person/place.
 */
/** Which source table a rule projects from — the pipeline's slice unit. */
export type DeterministicEdgeSource = 'communications' | 'events' | 'content' | 'inventory';

export interface DeterministicEdgeRule {
  /** Stable rule id, recorded on the edge as `properties.rule`. */
  id: string;
  /** What the rule projects, for operators reading results/logs. */
  description: string;
  /** Edge type written; must stay inside the graph domain's RelationshipMap. */
  relationshipType: RelationshipType;
  /** Edge strength in [0, 1]. */
  strength: number;
  /** Extra properties stamped on every edge (rule id is added automatically). */
  properties: Record<string, unknown>;
  /** Which source table the rule reads (selects rules for a pipeline slice). */
  source: DeterministicEdgeSource;
  /** FROM-clause source with alias, e.g. `ci.communications c`. */
  table: string;
  /** User-scoping column on the source table, e.g. `c.user_id`. */
  userColumn: string;
  /** Time column used for window batching (hypertable chunk exclusion). */
  timeColumn: string;
  /** Aliased id column, e.g. `c.id` — the bound for id-scoped (slice) runs. */
  idColumn: string;
  /** SQL expression yielding the edge's from-entity id (may unnest an array). */
  fromIdExpr: string;
  /** SQL expression yielding the edge's to-entity id. */
  toIdExpr: string;
  /** Candidate predicate — rows whose linkage column is populated. */
  candidateWhere: string;
}

/**
 * THE MATRIX: data type × metadata column → deterministic edge.
 *
 * | source                              | edge                                    |
 * |-------------------------------------|-----------------------------------------|
 * | communications.from_entity_id       | Person -SENT→ Communication             |
 * | communications.to_entity_ids        | Person -RECEIVED→ Communication         |
 * | events.organizer_entity_id          | Person -PARTICIPATED_IN→ Event (organizer) |
 * | events.participant_entity_ids       | Person -PARTICIPATED_IN→ Event          |
 * | events.location_entity_id           | Event -HAPPENED_AT→ Place               |
 * | events.parent_event_id              | Event -PART_OF→ Event                   |
 * | content.event_id                    | Content -PART_OF→ Event                 |
 * | inventory.last_seen_place_entity_id | Item -LOCATED_AT→ Place                 |
 *
 * Every source id column is filled by the deterministic people/place-linking
 * jobs, and every communication/event row has a same-id mirror in
 * `ci.entities` (CTI), so both endpoints of each pair are real graph nodes.
 */
export const DETERMINISTIC_EDGE_RULES: readonly DeterministicEdgeRule[] = [
  {
    id: 'communication.sent',
    description: 'Sender Person → Communication',
    relationshipType: RelationshipType.SENT,
    strength: 0.6,
    properties: { derived_from: 'communications.from_entity_id' },
    source: 'communications',
    table: 'ci.communications c',
    userColumn: 'c.user_id',
    timeColumn: 'c.time',
    idColumn: 'c.id',
    fromIdExpr: 'c.from_entity_id',
    toIdExpr: 'c.id',
    candidateWhere: 'c.from_entity_id IS NOT NULL',
  },
  {
    id: 'communication.received',
    description: 'Recipient Person → Communication',
    relationshipType: RelationshipType.RECEIVED,
    strength: 0.45,
    properties: { derived_from: 'communications.to_entity_ids' },
    source: 'communications',
    table: 'ci.communications c',
    userColumn: 'c.user_id',
    timeColumn: 'c.time',
    idColumn: 'c.id',
    fromIdExpr: 'unnest(c.to_entity_ids)',
    toIdExpr: 'c.id',
    candidateWhere: 'c.to_entity_ids IS NOT NULL AND cardinality(c.to_entity_ids) > 0',
  },
  {
    id: 'event.organized',
    description: 'Organizer Person → Event',
    relationshipType: RelationshipType.PARTICIPATED_IN,
    strength: 0.7,
    properties: { derived_from: 'events.organizer_entity_id', role: 'organizer' },
    source: 'events',
    table: 'ci.events e',
    userColumn: 'e.user_id',
    timeColumn: 'e.start_time',
    idColumn: 'e.event_id',
    fromIdExpr: 'e.organizer_entity_id',
    toIdExpr: 'e.event_id',
    candidateWhere: 'e.organizer_entity_id IS NOT NULL',
  },
  {
    id: 'event.participated',
    description: 'Participant Person → Event',
    relationshipType: RelationshipType.PARTICIPATED_IN,
    strength: 0.6,
    properties: { derived_from: 'events.participant_entity_ids' },
    source: 'events',
    table: 'ci.events e',
    userColumn: 'e.user_id',
    timeColumn: 'e.start_time',
    idColumn: 'e.event_id',
    fromIdExpr: 'unnest(e.participant_entity_ids)',
    toIdExpr: 'e.event_id',
    candidateWhere: 'e.participant_entity_ids IS NOT NULL AND cardinality(e.participant_entity_ids) > 0',
  },
  {
    id: 'event.happened_at',
    description: 'Event → Place it happened at',
    relationshipType: RelationshipType.HAPPENED_AT,
    strength: 0.6,
    properties: { derived_from: 'events.location_entity_id' },
    source: 'events',
    table: 'ci.events e',
    userColumn: 'e.user_id',
    timeColumn: 'e.start_time',
    idColumn: 'e.event_id',
    fromIdExpr: 'e.event_id',
    toIdExpr: 'e.location_entity_id',
    candidateWhere: 'e.location_entity_id IS NOT NULL',
  },
  {
    id: 'event.child_of',
    description: 'Sub-event → its parent Event',
    relationshipType: RelationshipType.PART_OF,
    strength: 0.8,
    properties: { derived_from: 'events.parent_event_id' },
    source: 'events',
    table: 'ci.events e',
    userColumn: 'e.user_id',
    timeColumn: 'e.start_time',
    idColumn: 'e.event_id',
    fromIdExpr: 'e.event_id',
    toIdExpr: 'e.parent_event_id',
    candidateWhere: 'e.parent_event_id IS NOT NULL',
  },
  {
    id: 'content.part_of_event',
    description: 'Content → the Event it belongs to',
    relationshipType: RelationshipType.PART_OF,
    strength: 0.7,
    properties: { derived_from: 'content.event_id' },
    source: 'content',
    table: 'ci.content ct',
    userColumn: 'ct.user_id',
    timeColumn: 'ct.created_at',
    idColumn: 'ct.id',
    fromIdExpr: 'ct.id',
    toIdExpr: 'ct.event_id',
    candidateWhere: 'ct.event_id IS NOT NULL',
  },
  {
    id: 'inventory.located_at',
    description: 'Item → the Place it was last seen at',
    relationshipType: RelationshipType.LOCATED_AT,
    strength: 0.6,
    properties: { derived_from: 'inventory.last_seen_place_entity_id' },
    source: 'inventory',
    table: 'ci.inventory i',
    userColumn: 'i.user_id',
    timeColumn: 'i.created_at',
    idColumn: 'i.object_id',
    fromIdExpr: 'i.object_id',
    toIdExpr: 'i.last_seen_place_entity_id',
    candidateWhere: 'i.last_seen_place_entity_id IS NOT NULL',
  },
];

/** Rule ids, for request validation (`rules` filter on the backfill body). */
export const DETERMINISTIC_EDGE_RULE_IDS = DETERMINISTIC_EDGE_RULES.map((rule) => rule.id) as [
  string,
  ...string[],
];

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
export type DeterministicEdgeSource =
  | 'communications'
  | 'events'
  | 'content'
  | 'inventory'
  | 'receipts'
  | 'observations'
  | 'positions'
  | 'devices'
  | 'files'
  | 'places';

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
 * | source                                        | edge                                       |
 * |-----------------------------------------------|--------------------------------------------|
 * | communications.from_entity_id                 | Person -SENT→ Communication                |
 * | communications.to_entity_ids                  | Person -RECEIVED→ Communication            |
 * | events.organizer_entity_id                    | Person -PARTICIPATED_IN→ Event (organizer) |
 * | events.participant_entity_ids                 | Person -PARTICIPATED_IN→ Event             |
 * | events.location_entity_id                     | Event -LOCATED_AT→ Place                   |
 * | events.parent_event_id                        | Event -PART_OF→ Event                      |
 * | content.event_id                              | Content -DOCUMENTS→ Event                  |
 * | entities.parent_place_id (Place/Location)     | Place -PART_OF→ Place                      |
 * | files.parent_id (via File entity mirror)      | File -DERIVED_FROM→ File                   |
 * | inventory.last_seen_place_entity_id           | Item -LOCATED_AT→ Place                    |
 * | receipts.merchant × place_entity_id           | Merchant -LOCATED_AT→ Place                |
 * | receipts.document_content_id × event_id       | Content -PART_OF→ Event (the purchase)     |
 * | receipts.event_id × place_entity_id           | Event -HAPPENED_AT→ Place                  |
 * | object_observations.content_id × event_id     | Content -PART_OF→ Event                    |
 * | object_observations.object × place_entity_id  | Item -LOCATED_AT→ Place                    |
 * | object_observations.object × content_id       | Item -ASSOCIATED_WITH→ Content (depicted)  |
 * | position.location_entity_id (× users)         | Owner Person -VISITED→ Place               |
 * | devices.device_entity_id (× users)            | Owner Person -OWNS→ Device                 |
 *
 * Every source id column is filled by the deterministic people/place-linking
 * jobs (or by the connector at ingest), and every communication/event/content
 * row has a same-id mirror in `ci.entities` (CTI), so both endpoints of each
 * pair are real graph nodes — the projection's ci.entities JOIN drops any pair
 * whose endpoint has no mirror yet, and a later run picks it up.
 *
 * Rules whose two endpoints are BOTH plain columns of the row (receipts,
 * observations) relate two other entities THROUGH the row: the row itself is
 * not a graph node, it is the evidence for the edge. Rules over per-owner
 * tables (position, devices) join `ci.users` to start the edge at the owner's
 * own Person entity — that's what hangs telemetry off the account anchor.
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
    description: 'Event → Place it happened at (canonical LOCATED_AT; HAPPENED_AT is a write alias)',
    relationshipType: RelationshipType.LOCATED_AT,
    strength: 0.6,
    properties: { derived_from: 'events.location_entity_id', layer: 'L0' },
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
    id: 'content.documents_event',
    description: 'Content → the Event it documents (canonical DOCUMENTS; PART_OF rows are normalised)',
    relationshipType: RelationshipType.DOCUMENTS,
    strength: 0.7,
    properties: { derived_from: 'content.event_id', layer: 'L0' },
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
  {
    id: 'receipt.merchant_at_place',
    description: 'Merchant → the Place the purchase happened at',
    relationshipType: RelationshipType.LOCATED_AT,
    strength: 0.55,
    properties: { derived_from: 'receipts.merchant_entity_id x receipts.place_entity_id' },
    source: 'receipts',
    table: 'ci.receipts r',
    userColumn: 'r.user_id',
    timeColumn: 'r.created_at',
    idColumn: 'r.receipt_id',
    fromIdExpr: 'r.merchant_entity_id',
    toIdExpr: 'r.place_entity_id',
    candidateWhere: 'r.merchant_entity_id IS NOT NULL AND r.place_entity_id IS NOT NULL',
  },
  {
    id: 'receipt.document_part_of_event',
    description: 'Receipt document Content → the purchase Event',
    relationshipType: RelationshipType.DOCUMENTS,
    strength: 0.7,
    properties: { derived_from: 'receipts.document_content_id x receipts.event_id', layer: 'L0' },
    source: 'receipts',
    table: 'ci.receipts r',
    userColumn: 'r.user_id',
    timeColumn: 'r.created_at',
    idColumn: 'r.receipt_id',
    fromIdExpr: 'r.document_content_id',
    toIdExpr: 'r.event_id',
    candidateWhere: 'r.document_content_id IS NOT NULL AND r.event_id IS NOT NULL',
  },
  {
    id: 'receipt.event_at_place',
    description: 'Purchase Event → the Place it happened at',
    relationshipType: RelationshipType.LOCATED_AT,
    strength: 0.6,
    properties: { derived_from: 'receipts.event_id x receipts.place_entity_id', layer: 'L0' },
    source: 'receipts',
    table: 'ci.receipts r',
    userColumn: 'r.user_id',
    timeColumn: 'r.created_at',
    idColumn: 'r.receipt_id',
    fromIdExpr: 'r.event_id',
    toIdExpr: 'r.place_entity_id',
    candidateWhere: 'r.event_id IS NOT NULL AND r.place_entity_id IS NOT NULL',
  },
  {
    id: 'observation.content_part_of_event',
    description: 'Observed Content → the Event it was captured in',
    relationshipType: RelationshipType.PART_OF,
    strength: 0.7,
    properties: { derived_from: 'object_observations.content_id x object_observations.event_id' },
    source: 'observations',
    table: 'ci.object_observations o',
    userColumn: 'o.user_id',
    timeColumn: 'o.observed_at',
    idColumn: 'o.observation_id',
    fromIdExpr: 'o.content_id',
    toIdExpr: 'o.event_id',
    candidateWhere: 'o.content_id IS NOT NULL AND o.event_id IS NOT NULL',
  },
  {
    id: 'observation.object_at_place',
    description: 'Resolved Item → the Place it was observed at',
    relationshipType: RelationshipType.LOCATED_AT,
    strength: 0.5,
    properties: {
      derived_from: 'object_observations.resolved_object_id x object_observations.place_entity_id',
    },
    source: 'observations',
    table: 'ci.object_observations o',
    userColumn: 'o.user_id',
    timeColumn: 'o.observed_at',
    idColumn: 'o.observation_id',
    fromIdExpr: 'o.resolved_object_id',
    toIdExpr: 'o.place_entity_id',
    candidateWhere: 'o.resolved_object_id IS NOT NULL AND o.place_entity_id IS NOT NULL',
  },
  {
    id: 'observation.object_in_content',
    description: 'Resolved Item → the Content it is depicted in',
    relationshipType: RelationshipType.ASSOCIATED_WITH,
    strength: 0.5,
    properties: {
      derived_from: 'object_observations.resolved_object_id x object_observations.content_id',
      role: 'depicted_in',
    },
    source: 'observations',
    table: 'ci.object_observations o',
    userColumn: 'o.user_id',
    timeColumn: 'o.observed_at',
    idColumn: 'o.observation_id',
    fromIdExpr: 'o.resolved_object_id',
    toIdExpr: 'o.content_id',
    candidateWhere: 'o.resolved_object_id IS NOT NULL AND o.content_id IS NOT NULL',
  },
  {
    // Millions of position fixes collapse to one edge per distinct
    // (owner, place): the projection's DISTINCT dedupes within a window and the
    // directed-unique index collapses across windows — telemetry volume in, a
    // handful of VISITED edges out.
    id: 'position.visited',
    description: 'Owner Person → a Place their position snapped to',
    relationshipType: RelationshipType.VISITED,
    strength: 0.5,
    properties: { derived_from: 'position.location_entity_id' },
    source: 'positions',
    table: 'ci.position p JOIN ci.users u ON u.id = p.user_id',
    userColumn: 'p.user_id',
    timeColumn: 'p.time',
    idColumn: 'p.id',
    fromIdExpr: 'u.entity_id',
    toIdExpr: 'p.location_entity_id',
    candidateWhere: 'p.location_entity_id IS NOT NULL AND u.entity_id IS NOT NULL',
  },
  {
    id: 'device.owned_by',
    description: 'Owner Person → their Device entity',
    relationshipType: RelationshipType.OWNS,
    strength: 0.8,
    properties: { derived_from: 'devices.device_entity_id' },
    source: 'devices',
    table: 'ci.devices d JOIN ci.users u ON u.id = d.user_id',
    userColumn: 'd.user_id',
    timeColumn: 'd.created_at',
    idColumn: 'd.device_id',
    fromIdExpr: 'u.entity_id',
    toIdExpr: 'd.device_entity_id',
    candidateWhere: 'd.device_entity_id IS NOT NULL AND u.entity_id IS NOT NULL',
  },
  {
    // Place hierarchy: child Place/Location → parent via entities.parent_place_id.
    id: 'place.child_of',
    description: 'Place → its parent Place',
    relationshipType: RelationshipType.PART_OF,
    strength: 0.9,
    properties: { derived_from: 'entities.parent_place_id', layer: 'L0' },
    source: 'places',
    table: `ci.entities e`,
    userColumn: 'e.owner_user_id',
    timeColumn: 'e.created_at',
    idColumn: 'e.entity_id',
    fromIdExpr: 'e.entity_id',
    toIdExpr: 'e.parent_place_id',
    candidateWhere: `e.parent_place_id IS NOT NULL AND e.entity_type IN ('Location', 'Place') AND e.is_active = TRUE`,
  },
  {
    // File variant → parent file, resolved through the linked File graph entity.
    id: 'file.derived_from',
    description: 'File entity → parent File entity (ci.files.parent_id)',
    relationshipType: RelationshipType.DERIVED_FROM,
    strength: 0.8,
    properties: { derived_from: 'files.parent_id', layer: 'L0' },
    source: 'files',
    table:
      `ci.files f ` +
      `JOIN ci.entities ef ON ef.linked_table = 'files' AND ef.linked_id = f.id ` +
      `AND ef.owner_user_id = f.user_id AND ef.entity_type = 'File' AND ef.is_active = TRUE ` +
      `JOIN ci.entities ep ON ep.linked_table = 'files' AND ep.linked_id = f.parent_id ` +
      `AND ep.owner_user_id = f.user_id AND ep.entity_type = 'File' AND ep.is_active = TRUE`,
    userColumn: 'f.user_id',
    timeColumn: 'f.created_at',
    idColumn: 'f.id',
    fromIdExpr: 'ef.entity_id',
    toIdExpr: 'ep.entity_id',
    candidateWhere: 'f.parent_id IS NOT NULL',
  },
];

/** Rule ids, for request validation (`rules` filter on the backfill body). */
export const DETERMINISTIC_EDGE_RULE_IDS = DETERMINISTIC_EDGE_RULES.map((rule) => rule.id) as [
  string,
  ...string[],
];

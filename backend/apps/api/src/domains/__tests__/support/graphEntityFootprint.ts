import { randomUUID } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERYTHING THAT CAN NAME A PERSON, A PLACE OR A CONCEPT BY ID.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget` purges these three through `PersonService.purge`,
 * `PlaceService.purge` and `ConceptService.purge`, and the three suites that prove
 * it all need the same things: a node with a row in every table that names a graph
 * entity with no foreign key to say so, a way to count those rows, and a way to put
 * the database back. This is that, once, so the suites are about what is different
 * between the kinds and not about the fixture.
 *
 * Each case seeds a doomed node and a CONTROL one, asserts every probe is non-zero
 * for both BEFORE the purge (so a fixture that quietly wrote nothing cannot make a
 * purge look like it cleaned something), and afterwards that the doomed one reads
 * zero everywhere and the control one has not moved.
 *
 * The rows are real and committed, on the suite's own users. The measurement of
 * what the generic delete leaves behind, which these probes were first written for,
 * was done on a throwaway database in a rolled-back transaction.
 */

/** A query function: a `DataSource`'s or a `QueryRunner`'s. */
export type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/**
 * Every table that can name a graph entity by id, with how to count the rows that name this one. The
 * probe takes the node's id as `$1`. Not here: what is particular to a kind (a person's messages, a place's
 * children), which each suite adds to this.
 */
export const BARE_FOOTPRINT: ReadonlyArray<readonly [label: string, sql: string]> = [
  ['ci.entities (the node)', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
  [
    'ci.relationships',
    `SELECT count(*) FROM ci.relationships WHERE from_entity_id = $1 OR to_entity_id = $1`,
  ],
  [
    'ci.graph_deltas (of its edges)',
    `SELECT count(*) FROM ci.graph_deltas
      WHERE node_type = 'relationship' AND (from_entity_id = $1 OR to_entity_id = $1)`,
  ],
  ['ci.graph_deltas (its own)', `SELECT count(*) FROM ci.graph_deltas WHERE entity_id = $1`],
  ['ci.pipeline_state', `SELECT count(*) FROM ci.pipeline_state WHERE entity_id = $1`],
  ['ci.pipeline_dead_letters', `SELECT count(*) FROM ci.pipeline_dead_letters WHERE entity_id = $1`],
  ['ci_search.entity_tag', `SELECT count(*) FROM ci_search.entity_tag WHERE entity_id = $1`],
  ['ci_search.entity_categories', `SELECT count(*) FROM ci_search.entity_categories WHERE entity_id = $1`],
  ['ci_search.vectors', `SELECT count(*) FROM ci_search.vectors WHERE entity_id = $1`],
  ['ci_search.embeddings', `SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1`],
  ['ci_search.index_skips', `SELECT count(*) FROM ci_search.index_skips WHERE entity_id = $1`],
  [
    'ci.merge_candidates',
    `SELECT count(*) FROM ci.merge_candidates WHERE entity_id_a = $1 OR entity_id_b = $1`,
  ],
  [
    'ci.entity_merge_blocks',
    `SELECT count(*) FROM ci.entity_merge_blocks WHERE entity_id_a = $1 OR entity_id_b = $1`,
  ],
  [
    'ci.entity_merges',
    `SELECT count(*) FROM ci.entity_merges WHERE source_entity_id = $1 OR target_entity_id = $1`,
  ],
  ['ci.entity_identifiers', `SELECT count(*) FROM ci.entity_identifiers WHERE entity_id = $1`],
  ['ci.identifier_claims (resolved to it)', `SELECT count(*) FROM ci.identifier_claims WHERE entity_id = $1`],
  ['ci_import.entity_mappings', `SELECT count(*) FROM ci_import.entity_mappings WHERE server_entity_id = $1`],
];

/** What a footprint reads when every row is gone. */
export function emptyFootprint(
  probes: ReadonlyArray<readonly [label: string, sql: string]>,
): Record<string, number> {
  return Object.fromEntries(probes.map(([label]) => [label, 0]));
}

/** Counts every probe for one node. */
export async function readFootprint(
  query: Query,
  probes: ReadonlyArray<readonly [label: string, sql: string]>,
  entityId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const [label, sql] of probes) {
    const [{ count }] = await query(sql, [entityId]);

    counts[label] = Number(count);
  }

  return counts;
}

/** What `seedNode` and `seedBareFootprint` are told about a node. */
export interface SeededNode {
  entityId: string;
  /** As `ci.entities` stores it: `Person`, `Location`, `Concept`. */
  entityType: string;
  /** What `ci_search` calls it: `person`, `place`, `concept`. */
  searchType: string;
  name: string;
  ownerId: string;
}

/** Inserts one `ci.entities` row, and reports its id to `track` so the wipe can find it. */
export async function insertNode(
  query: Query,
  track: (id: string) => void,
  node: { entityType: string; name: string; ownerId: string; id?: string },
  extra: { isActive?: boolean; mergedInto?: string; parentPlaceId?: string; placeKind?: string } = {},
): Promise<string> {
  const id = node.id ?? uuidv7();

  track(id);
  await query(
    `INSERT INTO ci.entities
       (entity_id, entity_type, name, properties, owner_user_id, is_active, merged_into_entity_id, parent_place_id, place_kind)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7, $8)`,
    [
      id,
      node.entityType,
      node.name,
      node.ownerId,
      extra.isActive ?? extra.mergedInto === undefined,
      extra.mergedInto ?? null,
      extra.parentPlaceId ?? null,
      extra.placeKind ?? null,
    ],
  );

  return id;
}

/** An edge, and the delta that recorded its creation, which names both endpoints. */
export async function insertEdge(
  query: Query,
  ownerId: string,
  from: string,
  to: string,
  type: string,
): Promise<void> {
  const [{ relationship_id: relationshipId }] = await query(
    `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING relationship_id`,
    [from, to, type, ownerId],
  );

  await query(
    `INSERT INTO ci.graph_deltas
       (node_type, relationship_id, relationship_type, from_entity_id, to_entity_id, change_type, changed_fields, owner_user_id)
     VALUES ('relationship', $1, $2, $3, $4, 'created', '{}'::jsonb, $5)`,
    [relationshipId, type, from, to, ownerId],
  );
}

/**
 * A row in every table of {@link BARE_FOOTPRINT} for this node, on top of the node itself (insert that
 * first): edges in both directions each with its delta, pipeline bookkeeping, the delta that carries its
 * name, tags, categories and search rows, merge bookkeeping, an identifier it owns, a claim that resolved
 * to it (a human has ruled on it), and the staged import entity that became it.
 */
export async function seedBareFootprint(
  query: Query,
  track: (id: string) => void,
  node: SeededNode,
): Promise<void> {
  const { entityId: id, entityType, searchType, name, ownerId } = node;

  // Graph edges, in both directions, each with the delta that recorded it.
  const outgoing = await insertNode(query, track, {
    entityType: 'Concept',
    name: `${name} (edge to)`,
    ownerId,
  });
  const incoming = await insertNode(query, track, {
    entityType: 'Concept',
    name: `${name} (edge from)`,
    ownerId,
  });

  await insertEdge(query, ownerId, id, outgoing, 'RELATED_TO');
  await insertEdge(query, ownerId, incoming, id, 'RELATED_TO');

  // Pipeline bookkeeping.
  await query(
    `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
     VALUES ($1, $2, 'graph_entity_purge_spec.stage', 'done', $3)`,
    [searchType, id, ownerId],
  );
  await query(
    `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
     VALUES ('pipeline', 'graph_entity.created', $1, $2, '{}'::jsonb, 'boom', $3)`,
    [searchType, id, ownerId],
  );

  // The graph delta the node's creation wrote, and the name in it.
  await query(
    `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
     VALUES ('entity', $1, $2, 'created', jsonb_build_object('name', jsonb_build_object('new', $3::text)), $4)`,
    [id, entityType, name, ownerId],
  );

  // Tags and categories, which live in the search schema and have no foreign key to the node, and its rows
  // in the search index.
  const [{ id: tag }] = await query(
    `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [`graph-entity-purge-spec-${id}`, ownerId],
  );

  await query(`INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ($1, $2, $3)`, [
    searchType,
    id,
    tag,
  ]);
  await query(
    `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
     VALUES ($1, $2, $3, 0)`,
    [searchType, id, tag],
  );
  await query(
    `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
     VALUES (gen_random_uuid(), $1, $2, to_tsvector('simple', $3), $4)`,
    [searchType, id, name, ownerId],
  );
  await query(
    `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [searchType, id, ownerId],
  );
  await query(
    `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ($1, $2, 'graph_entity_purge_spec')`,
    [searchType, id],
  );

  // Merge bookkeeping: the audit row of a merge into it, and a pending pair and a "never merge these" with
  // somebody who sorts BEFORE the node and somebody who sorts AFTER. A pair is stored ordered (`entity_id_a`
  // below `entity_id_b`), so which side the node is on depends on whom it is paired with. A delete that only
  // looks at one side misses half of them, and a fixture that only paired it one way would never say so.
  const before = `00000000-0000-7000-8000-${randomUUID().slice(-12)}`;
  const after = `ffffffff-ffff-7fff-bfff-${randomUUID().slice(-12)}`;

  await query(
    `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
     VALUES ($1, $2, $3, $4, jsonb_build_object('source', jsonb_build_object('name', 'a duplicate')))`,
    [ownerId, uuidv7(), id, entityType],
  );

  for (const other of [before, after]) {
    await query(
      `INSERT INTO ci.merge_candidates (owner_user_id, entity_type, entity_id_a, entity_id_b, score, detected_by, detector_version)
       VALUES ($1, $2, LEAST($3::uuid, $4::uuid), GREATEST($3::uuid, $4::uuid), 0.9, 'graph_entity_purge_spec', 1)`,
      [ownerId, entityType, id, other],
    );
    await query(
      `INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b)
       VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))`,
      [ownerId, id, other],
    );
  }

  // An identifier it owns, and a claim about some message that resolved to it, which a human has ruled on.
  // Neither has a foreign key; the unique index over the identifier is what a leftover row would hold.
  await query(
    `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized)
     VALUES ($1, $2, 'name', $3)`,
    [id, ownerId, `name-${id}`],
  );
  await query(
    `INSERT INTO ci.identifier_claims
       (owner_user_id, subject_type, subject_id, role, kind, value_normalized, entity_id, confidence, method,
        spec_version, observed_at, disposition, disposed_at)
     VALUES ($1, 'communication', $2, 'to', 'name', $3, $4, 0.6, 'name_exact', 1, now(), 'rejected', now())`,
    [ownerId, uuidv7(), `name-${id}`, id],
  );

  // The staged import entity that became it. `PushStage` reads this to write a staged message's participants.
  const runId = uuidv7();
  const stagedId = uuidv7();

  await query(`INSERT INTO ci_import.import_runs (id, user_id) VALUES ($1, $2)`, [runId, ownerId]);
  await query(`INSERT INTO ci_import.staged_entities (id, run_id, user_id) VALUES ($1, $2, $3)`, [
    stagedId,
    runId,
    ownerId,
  ]);
  await query(
    `INSERT INTO ci_import.entity_mappings (staged_entity_id, user_id, server_entity_id) VALUES ($1, $2, $3)`,
    [stagedId, ownerId, id],
  );
}

/**
 * Puts the database back after a case: everything {@link seedBareFootprint} and the suite's own rows
 * wrote for these users. The user rows stay for the suite to delete once. `ci.users.entity_id` is let go
 * first, because a case may point it at a node to stand in for a table the purge has never heard of, and
 * it would stop the delete of that node.
 */
export async function wipeGraphEntities(query: Query, userIds: string[], seededIds: string[]): Promise<void> {
  await query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [userIds]);
  await query(
    `DELETE FROM ci_search.entity_tag WHERE tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
    [userIds],
  );
  await query(
    `DELETE FROM ci_search.entity_categories WHERE category_tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
    [userIds],
  );
  await query('DELETE FROM ci_search.tags WHERE user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci_search.embeddings WHERE user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci_search.index_skips WHERE entity_id = ANY($1::uuid[])', [seededIds]);
  await query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [seededIds]);
  await query('DELETE FROM ci.pipeline_dead_letters WHERE entity_id = ANY($1::uuid[])', [seededIds]);
  await query('DELETE FROM ci.entity_identifiers WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci.identifier_claims WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci.entity_merges WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci.merge_candidates WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci.entity_merge_blocks WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci.forgotten_identifiers WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
  // Cascades to the staged entities and their mappings.
  await query('DELETE FROM ci_import.import_runs WHERE user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
  await query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [userIds]);
}

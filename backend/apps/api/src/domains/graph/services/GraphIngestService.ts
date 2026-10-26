import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type WhereExpressionBuilder } from 'typeorm';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';
import { GraphDeltaWriter } from '@ci/domains/memory';

import { NodeEntity } from '../entities/NodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';
import {
  IDENTITY_LIST_KEYS,
  mergedPropertiesSql,
  mergeIngestedProperties,
  stableJson,
  unionKeysFor,
  userEditedKeys,
  userEditedSql,
} from '../utils/ingestedProperties';

import { type EntityIdentifierBatchEntry, EntityIdentifierService } from './EntityIdentifierService';

// Stable namespace so the importer and the server derive identical linked_id
// UUIDs from the same natural key. Do not change — it is the idempotency anchor.
const IMPORT_NAMESPACE = '6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b';

// Sentinel key the importer uses to anchor an edge on the signed-in user's own
// entity (resolved server-side; the importer never knows the owner's entity_id).
const SELF_KEY = 'self';
const USER_ENTITY_TYPE = 'User';
// A provisioned self entity is a `Person` (the owner's display name), NOT an
// entity_type='User' row — see resolveSelfEntity. linked_table `import:self` +
// linked_id uuidv5(`self:user:<id>`) make it stable and idempotent so re-runs
// and concurrent ingests resolve to the same row — and onboarding creates its
// self Person under the same key (GraphIngestService.selfEntityLink), so the
// two resolve to the same row as well.
const SELF_ENTITY_TYPE = 'Person';
const SELF_SOURCE_SYSTEM = 'self';

/** The natural key of an account's self Person: one per account. */
function selfKeyFor(ownerId: string): string {
  return `self:user:${ownerId}`;
}

export interface GraphEntityInputDto {
  /** Importer-stable natural key, e.g. `apple_contacts:contact:John Doe`. */
  key: string;
  entityType: string;
  name?: string | null;
  description?: string | null;
  sourceSystem: string;
  properties?: Record<string, unknown> | null;
  /**
   * The property keys that are SETS for this entity: its parser's
   * `Entity.accumulate` declaration, carried from the staged row. A re-ingest
   * unions these into the stored row instead of replacing them. The plural
   * identity keys (`IDENTITY_LIST_KEYS`) are unioned whether declared or not.
   */
  accumulate?: readonly string[] | null;
}

export interface GraphRelationshipInputDto {
  /** An entity `key` from this batch, or the `self` sentinel. */
  fromKey: string;
  toKey: string;
  type: string;
  properties?: Record<string, unknown> | null;
  /**
   * Optional pre-resolved graph node ids for the endpoints. When set they take
   * precedence over `fromKey` / `toKey` resolution, letting a caller attach an
   * edge to an entity that already exists in the graph (and is NOT part of this
   * batch) without re-ingesting it — used by GraphEnrichmentService to wire
   * family edges between Person nodes the importer already created. The
   * importer / GraphQL path never sets these, so its behaviour is unchanged.
   */
  fromEntityId?: string;
  fromEntityType?: string;
  toEntityId?: string;
  toEntityType?: string;
}

/** A relationship whose endpoints have been resolved to concrete node ids. */
interface ResolvedEdge {
  r: GraphRelationshipInputDto;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
}

export interface GraphEntityMappingDto {
  /** The caller's entity `key`, echoed back verbatim. */
  key: string;
  /** The server-side ci.entities UUID the key resolved to or was created as. */
  entityId: string;
}

/**
 * An import coordinate: what {@link GraphIngestService.ingest} resolves an
 * entity by, less the owner — the row with this entity type, under
 * `import:<sourceSystem>`, whose linked_id is `uuidv5(key)`.
 */
export interface ImportedEntityRef {
  entityType: string;
  sourceSystem: string;
  key: string;
}

/** A row merged into another one: a merge tombstone. */
export interface MergedAwayEntity {
  entityId: string;
  name: string | null;
  properties: Record<string, unknown>;
}

/** A row holding an {@link ImportedEntityRef}. */
export interface ImportedEntityMatch extends ImportedEntityRef {
  entityId: string;
  name: string | null;
  properties: Record<string, unknown>;
  mergedIntoEntityId: string | null;
  /** The rows merged into this one. Empty for a tombstone: its sources point past it. */
  mergedFrom: MergedAwayEntity[];
}

/** Move the row holding `fromKey` onto `toKey`, same type and source. */
export interface ImportedEntityRekey {
  entityType: string;
  sourceSystem: string;
  fromKey: string;
  toKey: string;
  /**
   * Empty the row's properties as it moves, so the ingest that follows builds
   * them from scratch out of what the source now says. For a row the importer
   * has learned was several things at once: whatever {@link ingest} does with a
   * row's existing properties — replace them, or union the lists — must not
   * carry the others' details into the one it now belongs to.
   *
   * Emptied, that is, of what the SOURCE put there. The identity values the
   * row's standing Person merges brought in stay: a merge was a separate
   * decision, that another row is this row's person, and the row keeps its
   * merges. See {@link rekeyImportedEntities} for the rule.
   */
  resetProperties?: boolean;
  /**
   * With `resetProperties`: rows merged into this one whose values the reset
   * drops too, because the caller has shown them to be someone else.
   */
  dropMergedFrom?: readonly string[];
}

/**
 * What JavaScript's `String.prototype.trim` strips (the WhiteSpace and
 * LineTerminator code points), which is how `foldProperties` tells a blank
 * member from a value. Bound as `btrim`'s character set, so the database's
 * locale has no say in it.
 */
const JS_TRIM_CHARACTERS = String.fromCodePoint(
  0x09,
  0x0a,
  0x0b,
  0x0c,
  0x0d,
  0x20,
  0xa0,
  0x1680,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
);

/** A stored list key as a list: an array as it is, a lone value as one member, absent or null as none. */
function asListSql(value: string): string {
  return (
    `(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ` +
    `WHEN ${value} IS NULL OR jsonb_typeof(${value}) = 'null' THEN '[]'::jsonb ` +
    `ELSE jsonb_build_array(${value}) END)`
  );
}

/**
 * What two members of list `key` must share to be the same value, as
 * `foldProperties` compares them: the typed `Phones` / `Faxes` by digit string
 * (the trimmed text when there are no digits), a non-string matching nothing;
 * every other list by jsonb equality. `[^0-9]` rather than `\D`, which follows
 * the locale in Postgres.
 */
function foldedMemberSql(key: string, member: string, trimCharacters: string): string {
  return (
    `(CASE WHEN ${key} NOT IN ('Phones', 'Faxes') THEN ${member} ` +
    `WHEN jsonb_typeof(${member}) = 'string' THEN to_jsonb(COALESCE(` +
    `NULLIF(regexp_replace(${member} #>> '{}', '[^0-9]', '', 'g'), ''), ` +
    `btrim(${member} #>> '{}', ${trimCharacters}))) END)`
  );
}

/** Coordinates per `findImportedEntities` SELECT — three bind parameters each. */
const IMPORTED_LOOKUP_CHUNK = 1000;

function importCoordKey(entityType: string, linkedTable: string, linkedId: string): string {
  return `${entityType}||${linkedTable}||${linkedId}`;
}

export interface GraphIngestResult {
  entitiesProcessed: number;
  relationshipsProcessed: number;
  errors: string[];
  /**
   * key → ci.entities UUID for every input entity that upserted, covering both
   * freshly created rows and keys that resolved to existing ones. Callers (the
   * importer) cache this to attach later edges without re-sending entities.
   * Entities that failed to upsert are absent here and reported in `errors`.
   */
  entities: GraphEntityMappingDto[];
}

/**
 * Whether an incoming row says anything the stored one doesn't. Rows that match
 * are left untouched: a resync is overwhelmingly rows that haven't changed, and
 * writing them all back would churn the table (and its indexes) for nothing.
 *
 * "Says anything" is judged on what the MERGE would leave, not on whether the
 * two rows are equal. They rarely are once anyone else has written to the row —
 * a merge target carries its duplicates' numbers, a self Person its `is_self` —
 * and comparing bags called every such row stale on every import, only for the
 * write to put back what was already there. The comparison is sorted-key JSON,
 * because jsonb hands a bag back in its own key order, not the source's.
 *
 * A null name or description says nothing either, matching the conflict
 * action's COALESCE below.
 */
function isStale(current: NodeEntity, incoming: NodeEntity, unionKeys: readonly string[]): boolean {
  const merged = mergeIngestedProperties(current.properties, incoming.properties, unionKeys);
  const handSet = userEditedKeys(current.properties);

  return (
    (incoming.name != null && incoming.name !== current.name && !handSet.includes('name')) ||
    (incoming.description != null &&
      incoming.description !== current.description &&
      !handSet.includes('description')) ||
    stableJson(merged) !== stableJson(current.properties ?? {})
  );
}

/**
 * The entity upsert's conflict action. A conflicting row keeps its id; its
 * properties are MERGED with the incoming ones rather than replaced — see
 * `utils/ingestedProperties.ts` — and its name and description take the
 * incoming value unless that is null, the rule bulkUpsert's ingest refreshes
 * already follow. Most importers send no description at all, so the plain
 * `description = EXCLUDED.description` this replaced erased whatever a merge
 * or a person edit had written there on every refresh. A name or description a
 * person set by hand (listed in `properties.user_edited_keys`) is kept whatever
 * arrives, like the hand-set properties the merge skips.
 *
 * The merge runs in the statement, against the row as it stands once the
 * conflict has locked it, so a person merge (or any other writer) that
 * committed after this batch read the row is merged into, not overwritten.
 * `:unionKeys` is the batch's set-key list, bound per statement.
 *
 * The WHERE leaves a row alone if it became a merge tombstone after the
 * existence check read it: that row is not RETURNED, so step 3 re-resolves the
 * key through the tombstone like any other.
 */
const ENTITY_CONFLICT_ACTION =
  '(owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL ' +
  `DO UPDATE SET name = CASE WHEN ${userEditedSql('"entities"."properties"', "'name'")} ` +
  'THEN "entities"."name" ELSE COALESCE(EXCLUDED."name", "entities"."name") END, ' +
  `description = CASE WHEN ${userEditedSql('"entities"."properties"', "'description'")} ` +
  'THEN "entities"."description" ELSE COALESCE(EXCLUDED."description", "entities"."description") END, ' +
  `properties = ${mergedPropertiesSql('"entities"."properties"', 'EXCLUDED."properties"', ':unionKeys::text[]')}, ` +
  'updated_at = now() ' +
  'WHERE "entities"."merged_into_entity_id" IS NULL';

/**
 * Idempotent bulk ingest of an archive importer's knowledge graph (the
 * timeline built while parsing a source export) into `ci.entities` /
 * `ci.relationships`. Called in-process by the native import domain's
 * `PushStage` (`backend/apps/api/src/domains/import/`); the `bulkIngestGraph`
 * GraphQL mutation exposes the same path for any external caller.
 *
 * - Entities upsert on (owner_user_id, entity_type, linked_table, linked_id),
 *   where linked_table = `import:<sourceSystem>` and linked_id = uuidv5(key).
 *   Re-ingesting one MERGES into the stored row rather than replacing it, so
 *   what merges, edits and enrichment wrote there survives the next import —
 *   see `utils/ingestedProperties.ts`.
 * - Relationships reference entities by their batch `key` (resolved to entity_id
 *   here, so the importer needs no server round-trips) and upsert on the
 *   directed (from, to, type) unique index. The `self` sentinel resolves to the
 *   owner's User entity.
 *
 * Re-runs are safe: existing rows are resolved, not duplicated.
 */
@Injectable()
export class GraphIngestService {
  constructor(
    @InjectRepository(NodeEntity)
    private readonly nodeRepository: Repository<NodeEntity>,
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepository: Repository<RelationshipEntity>,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly logger: LoggerService,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {
    this.logger.setContext(GraphIngestService.name);
  }

  static linkedIdFor(key: string): string {
    return uuidv5(key, IMPORT_NAMESPACE);
  }

  /**
   * Where an account's self Person sits in the linked-key index: the
   * coordinates {@link ensureSelfEntityForOwner} upserts it on. Onboarding
   * creates its self Person under these too (`PersonService.create` resolves an
   * existing row on them instead of inserting another), so whichever of the two
   * gets there first makes the row and the other one is handed that row.
   */
  static selfEntityLink(ownerId: string): { linkedTable: string; linkedId: string } {
    return {
      linkedTable: `import:${SELF_SOURCE_SYSTEM}`,
      linkedId: GraphIngestService.linkedIdFor(selfKeyFor(ownerId)),
    };
  }

  /**
   * Ensure the owner has a canonical self Person before maintenance repairs or
   * planning enrichment run. Public so an operator-triggered backfill can heal
   * an imported account whose `ci.users.entity_id` points at a Person that was
   * never marked `is_self`.
   */
  async ensureSelfEntityForOwner(context: UserServiceContext): Promise<{ id: string; type: string } | null> {
    return this.ensureSelfEntity(context.userId);
  }

  async ingest(
    context: UserServiceContext,
    input: { entities: GraphEntityInputDto[]; relationships: GraphRelationshipInputDto[] },
  ): Promise<GraphIngestResult> {
    const ownerId = context.userId;
    const errors: string[] = [];

    // key -> resolved entity_id / entity_type, so relationships in the same
    // request can be wired without extra lookups.
    const keyToId = new Map<string, string>();
    const keyToType = new Map<string, string>();

    // Echoed back to the caller so it can cache key -> UUID (resolved-existing
    // rows included) and reference these entities in later batches.
    const entities: GraphEntityMappingDto[] = [];

    // Set-based entity upsert: resolve every input key to its ci.entities UUID
    // with a bounded number of statements (one existence SELECT + one batched
    // INSERT + one re-resolve SELECT for race losers), instead of the former
    // per-entity findOne+save round-trip. Resolution semantics are unchanged —
    // the (owner, entity_type, import:<sourceSystem>, uuidv5(key)) idempotency
    // key still maps a re-ingested key to its existing row.
    let entitiesProcessed = 0;
    const resolvedById = await this.upsertEntities(ownerId, input.entities, errors);
    // People-linking: collect every resolved entity's email/phone/name
    // identifiers and index them AFTER the loop in one set-based, chunked
    // INSERT (see indexIdentifiers) — this was the last per-row write on the
    // bulk ingest path (one statement per identifier-bearing entity).
    const identifierBatch: EntityIdentifierBatchEntry[] = [];
    for (const e of input.entities) {
      const id = resolvedById.get(e);
      if (id === undefined) {
        // Its failure was already recorded in `errors` by upsertEntities.
        continue;
      }

      keyToId.set(e.key, id);
      keyToType.set(e.key, e.entityType);
      entities.push({ key: e.key, entityId: id });

      const raw = rawIdentifiersOf(e);
      if (raw != null) {
        identifierBatch.push({ entityId: id, raw });
      }

      entitiesProcessed += 1;
    }

    // Idempotent (ON CONFLICT DO NOTHING); only entities carrying
    // emails/phones/names contribute rows. Failure to index must not fail the
    // ingest of the entities themselves — indexIdentifiers logs and swallows
    // its own errors.
    await this.indexIdentifiers(ownerId, identifierBatch);

    let relationshipsProcessed = 0;
    if (input.relationships.length > 0) {
      // Self-anchored edges (the `self` sentinel) need the owner's self entity.
      // On a from-scratch ingest — or after any wipe that NULLs
      // ci.users.entity_id — the owner has none, so provision one before wiring
      // the edges; otherwise every `self->…` edge fails "endpoint not found in
      // batch". Batches without a self edge (e.g. the family path's pre-resolved
      // Person-to-Person edges) skip this entirely.
      const needsSelf = input.relationships.some((r) => r.fromKey === SELF_KEY || r.toKey === SELF_KEY);
      const self = needsSelf ? await this.ensureSelfEntity(ownerId) : null;

      // Resolve every edge's endpoints in memory (no per-edge round-trip): a
      // pre-resolved endpoint id (an existing graph node) wins over key
      // resolution; otherwise fall back to the `self` sentinel or a batch key.
      // Unresolvable endpoints are reported and dropped, matching the prior loop.
      const resolved: ResolvedEdge[] = [];
      for (const r of input.relationships) {
        const fromId = r.fromEntityId ?? (r.fromKey === SELF_KEY ? self?.id : keyToId.get(r.fromKey));
        const toId = r.toEntityId ?? (r.toKey === SELF_KEY ? self?.id : keyToId.get(r.toKey));

        if (!fromId || !toId) {
          errors.push(`relationship ${r.fromKey}->${r.toKey}: endpoint not found in batch`);
          continue;
        }

        const fromType =
          r.fromEntityType ??
          (r.fromKey === SELF_KEY ? (self?.type ?? USER_ENTITY_TYPE) : keyToType.get(r.fromKey)!);
        const toType =
          r.toEntityType ??
          (r.toKey === SELF_KEY ? (self?.type ?? USER_ENTITY_TYPE) : keyToType.get(r.toKey)!);

        resolved.push({ r, fromId, fromType, toId, toType });
      }

      // Set-based relationship upsert over the resolved edges (one existence
      // SELECT + one batched INSERT ... ON CONFLICT DO NOTHING), replacing the
      // former per-edge findOne+save. Idempotency is unchanged: the directed
      // (from, to, type) unique index still collapses a re-ingested edge.
      relationshipsProcessed = await this.upsertRelationships(ownerId, resolved, errors);
    }

    return { entitiesProcessed, relationshipsProcessed, errors, entities };
  }

  /**
   * The rows that hold the given import coordinates — the same
   * `(entity type, import:<sourceSystem>, uuidv5(key))` {@link ingest} resolves
   * by — for a caller that must know what a key resolves to BEFORE ingesting
   * under it. A merge tombstone comes back as itself, not as its canonical row:
   * it is the row holding the coordinate.
   */
  async findImportedEntities(
    context: UserServiceContext,
    refs: ImportedEntityRef[],
  ): Promise<ImportedEntityMatch[]> {
    const refsByCoord = new Map<string, ImportedEntityRef[]>();

    for (const ref of refs) {
      const coord = importCoordKey(
        ref.entityType,
        `import:${ref.sourceSystem}`,
        GraphIngestService.linkedIdFor(ref.key),
      );
      const list = refsByCoord.get(coord);

      if (list) {
        list.push(ref);
      } else {
        refsByCoord.set(coord, [ref]);
      }
    }

    const coords = [...refsByCoord.values()].map(([ref]) => ({
      entityType: ref.entityType,
      linkedTable: `import:${ref.sourceSystem}`,
      linkedId: GraphIngestService.linkedIdFor(ref.key),
    }));
    const matches: ImportedEntityMatch[] = [];

    // Three bind parameters per coordinate in one OR-chain, so bounded well
    // under Postgres' 65,535.
    for (let offset = 0; offset < coords.length; offset += IMPORTED_LOOKUP_CHUNK) {
      const rows = await this.findExistingNodes(
        context.userId,
        coords.slice(offset, offset + IMPORTED_LOOKUP_CHUNK),
      );

      for (const row of rows) {
        for (const ref of refsByCoord.get(importCoordKey(row.entityType, row.linkedTable!, row.linkedId!)) ??
          []) {
          matches.push({
            ...ref,
            entityId: row.entityId,
            name: row.name,
            properties: row.properties ?? {},
            mergedIntoEntityId: row.mergedIntoEntityId,
            mergedFrom: [],
          });
        }
      }
    }

    // Who was merged into each live row: a caller about to rebuild one (a
    // re-key's `resetProperties`) has to tell the merges that are the row's own
    // person from any that are not. One statement, and only for live rows,
    // since path compression points a tombstone's sources past it.
    const live = [...new Set(matches.filter((m) => m.mergedIntoEntityId == null).map((m) => m.entityId))];

    if (live.length > 0) {
      const merged: Array<{
        entity_id: string;
        merged_into_entity_id: string;
        name: string | null;
        properties: Record<string, unknown> | null;
      }> = await this.nodeRepository.query(
        `SELECT entity_id, merged_into_entity_id, name, properties
           FROM ci.entities
          WHERE owner_user_id = $1::uuid
            AND merged_into_entity_id = ANY($2::uuid[])
          ORDER BY entity_id`,
        [context.userId, live],
      );

      for (const match of matches) {
        match.mergedFrom = merged
          .filter((row) => row.merged_into_entity_id === match.entityId)
          .map((row) => ({ entityId: row.entity_id, name: row.name, properties: row.properties ?? {} }));
      }
    }

    return matches;
  }

  /**
   * Move rows from one import key to another IN PLACE, for an importer whose
   * natural key for a thing changed. The row keeps its `entity_id`, so every
   * edge, identifier, merge and search-index row that points at it still does;
   * the next {@link ingest} under the new key then resolves to it rather than
   * minting a second row beside it.
   *
   * Only ever onto a FREE coordinate. The statement re-checks that itself, so a
   * row that landed on the destination in the meantime is left where it is
   * rather than raising a unique violation; such a move is simply absent from
   * the result. Tombstones move like any row — ingest resolves through them.
   *
   * No graph delta: the coordinate is provenance, not something a reader of the
   * entity sees, and whatever the following ingest changes about the row is
   * recorded there as usual. A move with `resetProperties` empties the row's
   * properties in the same statement, under the same guard.
   *
   * Except what the row's standing Person merges brought in. Of the identity
   * lists `PersonMergeService.foldProperties` unions (`emails`, `phones`,
   * `names`, `Phones`, `Faxes`), a member the row holds stays when a merge
   * that still stands brought it in: the merge's source is still a Person
   * tombstone pointing at this row, its target is this row or one merged into
   * it, and the source held the member both when it was merged (the bag
   * `ci.entity_merges.details.sourceProperties` recorded) and on its tombstone
   * today. That is the rule #2796's survivor repair restores by, so a reset
   * after that one-shot repair does not lose again what it put back. Members
   * are compared the way the fold compares them, and keep the row's order. A
   * source in `dropMergedFrom` vouches for nothing. The rule runs inside this
   * statement, not in the caller's plan, so a merge that commits between the
   * two is kept too.
   *
   * Returns the moves that happened, each with the row it moved.
   */
  async rekeyImportedEntities(
    context: UserServiceContext,
    moves: ImportedEntityRekey[],
  ): Promise<Array<ImportedEntityRekey & { entityId: string }>> {
    if (moves.length === 0) {
      return [];
    }

    const linkedTables = moves.map((move) => `import:${move.sourceSystem}`);
    const fromIds = moves.map((move) => GraphIngestService.linkedIdFor(move.fromKey));
    const toIds = moves.map((move) => GraphIngestService.linkedIdFor(move.toKey));
    const resets = moves.map((move) => move.resetProperties === true);
    // One comma-separated list per move: unnest cannot take a ragged uuid[][].
    const dropped = moves.map((move) => (move.dropMergedFrom ?? []).join(','));
    const member = (value: string) => foldedMemberSql('k.key', value, '$9::text');

    // A CTE rather than a bare UPDATE … RETURNING: through TypeORM's postgres
    // driver `query()` hands an UPDATE back as the pair `[rows, rowCount]`, not
    // as its RETURNING rows (see EstimateLocationStage).
    const rows: Array<{ entity_id: string; entity_type: string; linked_table: string; from_id: string }> =
      await this.nodeRepository.query(
        `WITH moved AS (
           UPDATE ci.entities e
              SET linked_id = m.to_id,
                  properties = CASE
                    WHEN m.reset THEN COALESCE((
                      SELECT jsonb_object_agg(kept.key, kept.members)
                        FROM (SELECT k.key, jsonb_agg(held.value ORDER BY held.position) AS members
                                FROM unnest($8::text[]) AS k(key)
                               CROSS JOIN LATERAL jsonb_array_elements(${asListSql('e.properties -> k.key')})
                                     WITH ORDINALITY AS held(value, position)
                               CROSS JOIN LATERAL (SELECT ${member('held.value')} AS match) AS h
                               WHERE jsonb_typeof(held.value) = 'string'
                                 AND btrim(held.value #>> '{}', $9::text) <> ''
                                 AND EXISTS (
                                       SELECT 1
                                         FROM ci.entities src
                                         JOIN ci.entity_merges mg
                                           ON mg.owner_user_id = src.owner_user_id
                                          AND mg.source_entity_id = src.entity_id
                                         JOIN ci.entities target
                                           ON target.owner_user_id = mg.owner_user_id
                                          AND target.entity_id = mg.target_entity_id
                                        WHERE src.owner_user_id = e.owner_user_id
                                          AND src.merged_into_entity_id = e.entity_id
                                          AND src.entity_type = 'Person'
                                          AND mg.entity_type = 'Person'
                                          AND target.entity_type = 'Person'
                                          AND COALESCE(target.merged_into_entity_id, target.entity_id) = e.entity_id
                                          AND src.entity_id <> ALL (string_to_array(m.dropped, ',')::uuid[])
                                          AND EXISTS (
                                                SELECT 1
                                                  FROM jsonb_array_elements(CASE
                                                         WHEN jsonb_typeof(mg.details -> 'sourceProperties' -> k.key) = 'array'
                                                           THEN mg.details -> 'sourceProperties' -> k.key
                                                         WHEN k.key IN ('Phones', 'Faxes')
                                                          AND jsonb_typeof(mg.details -> 'sourceProperties' -> k.key) = 'string'
                                                           THEN jsonb_build_array(mg.details -> 'sourceProperties' -> k.key)
                                                         ELSE '[]'::jsonb
                                                       END) AS given(value)
                                                 WHERE ${member('given.value')} = h.match)
                                          AND EXISTS (
                                                SELECT 1
                                                  FROM jsonb_array_elements(${asListSql('src.properties -> k.key')}) AS still(value)
                                                 WHERE ${member('still.value')} = h.match))
                               GROUP BY k.key) AS kept
                    ), '{}'::jsonb)
                    ELSE e.properties
                  END,
                  updated_at = now()
             FROM unnest($2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::boolean[], $7::text[])
                  AS m(entity_type, linked_table, from_id, to_id, reset, dropped)
            WHERE e.owner_user_id = $1::uuid
              AND e.entity_type = m.entity_type
              AND e.linked_table = m.linked_table
              AND e.linked_id = m.from_id
              AND NOT EXISTS (
                    SELECT 1
                      FROM ci.entities t
                     WHERE t.owner_user_id = $1::uuid
                       AND t.entity_type = m.entity_type
                       AND t.linked_table = m.linked_table
                       AND t.linked_id = m.to_id)
        RETURNING e.entity_id, m.entity_type, m.linked_table, m.from_id
         )
         SELECT entity_id, entity_type, linked_table, from_id::text AS from_id FROM moved`,
        [
          context.userId,
          moves.map((move) => move.entityType),
          linkedTables,
          fromIds,
          toIds,
          resets,
          dropped,
          IDENTITY_LIST_KEYS,
          JS_TRIM_CHARACTERS,
        ],
      );

    const movedByCoord = new Map(
      rows.map((row) => [importCoordKey(row.entity_type, row.linked_table, row.from_id), row.entity_id]),
    );

    return moves.flatMap((move, index) => {
      const entityId = movedByCoord.get(importCoordKey(move.entityType, linkedTables[index], fromIds[index]));

      return entityId ? [{ ...move, entityId }] : [];
    });
  }

  /**
   * Set-based upsert of a batch of entities. Returns a map from each input DTO to
   * the ci.entities UUID it resolved to (existing) or was created as. DTOs whose
   * resolution failed are absent from the map and reported in `errors` (in input
   * order), preserving the prior per-entity error isolation for the observable
   * result.
   *
   * Statement budget per call: one existence SELECT, one batched INSERT (new
   * rows only), and — only if a concurrent writer won a race — one re-resolve
   * SELECT. This replaces the former N×(findOne+save) round-trips while keeping
   * the (owner, entity_type, import:<sourceSystem>, uuidv5(key)) idempotency key.
   */
  private async upsertEntities(
    ownerId: string,
    inputs: GraphEntityInputDto[],
    errors: string[],
  ): Promise<Map<GraphEntityInputDto, string>> {
    const resolved = new Map<GraphEntityInputDto, string>();
    if (inputs.length === 0) {
      return resolved;
    }

    // Build a row per input and its idempotency coordinates. Intra-batch
    // duplicates on (entityType, linkedTable, linkedId) collapse to the first
    // occurrence's row, exactly as the prior create-cache would (two DTOs with
    // the same linked key resolve to one ci.entities row).
    interface Prepared {
      input: GraphEntityInputDto;
      entityType: string;
      linkedTable: string;
      linkedId: string;
      row: NodeEntity;
      /** The property keys a refresh unions rather than replaces. */
      unionKeys: string[];
    }
    const coordKey = (entityType: string, linkedTable: string, linkedId: string): string =>
      `${entityType}||${linkedTable}||${linkedId}`;

    const prepared: Prepared[] = [];
    const firstByCoord = new Map<string, Prepared>();
    for (const input of inputs) {
      const linkedTable = `import:${input.sourceSystem}`;
      const linkedId = GraphIngestService.linkedIdFor(input.key);
      const ck = coordKey(input.entityType, linkedTable, linkedId);

      const existingPrep = firstByCoord.get(ck);
      if (existingPrep) {
        // Same linked key as an earlier row — reuse its (to-be-resolved) id.
        prepared.push({ ...existingPrep, input });
        continue;
      }

      const row = this.nodeRepository.create({
        entityId: uuidv7(),
        entityType: input.entityType,
        name: input.name ?? null,
        description: input.description ?? null,
        properties: input.properties ?? {},
        linkedTable,
        linkedId,
        userId: ownerId,
      });
      const prep: Prepared = {
        input,
        entityType: input.entityType,
        linkedTable,
        linkedId,
        row,
        unionKeys: unionKeysFor(input.accumulate),
      };
      prepared.push(prep);
      firstByCoord.set(ck, prep);
    }

    // coordKey -> resolved entity_id (existing, freshly inserted, or race winner).
    const idByCoord = new Map<string, string>();
    // coordKey -> what step 2's statement left on a row it wrote (RETURNING).
    const written = new Map<
      string,
      { name: string | null; description: string | null; properties: Record<string, unknown> }
    >();

    try {
      // 1. Existence pre-check over the distinct linked-key coordinates. The
      // rows are kept, not just their ids: what they currently hold is how step
      // 2 tells a row that has something new to say from one that doesn't.
      const distinct = [...firstByCoord.values()];
      const existing = await this.findExistingNodes(ownerId, distinct);
      const existingByCoord = new Map<string, NodeEntity>();
      for (const row of existing) {
        const ck = coordKey(row.entityType, row.linkedTable!, row.linkedId!);
        // The id resolves THROUGH a merge tombstone; the row itself is kept
        // as-found, because step 2 needs the tombstone's own state to decide
        // whether to touch it (it must not).
        idByCoord.set(ck, canonicalIdOf(row));
        existingByCoord.set(ck, row);
      }

      // 2. Batched INSERT of the new rows AND the changed ones. ON CONFLICT DO
      // UPDATE absorbs a lost race (the 23505 the old catch handled) without
      // throwing; RETURNING yields every row the statement wrote.
      //
      // This used to be DO NOTHING, which made an entity's name/properties
      // whatever the FIRST ingest happened to say, permanently: a source that
      // later learned more about the same thing — an importer entity that
      // accumulated a second price, an entity whose mention count grew — could
      // never say so. A row's linked key is namespaced by its sourceSystem
      // (linked_table = `import:<sourceSystem>`), so a refresh only ever lands
      // on a row this same source created; it cannot reach another source's or
      // the enrichment pass's nodes.
      //
      // Other writers DO share this row, though — a person merge folds its
      // duplicates' numbers into it, a person edit adds structured names,
      // markSelfEntity adds `is_self`. So the refresh merges properties rather
      // than replacing them (ENTITY_CONFLICT_ACTION), and a row counts as stale
      // only when the merge would change it.
      //
      // A merge TOMBSTONE is excluded outright, ahead of the staleness check. A
      // tombstone keeps its linked key, so it still owns this coordinate and
      // the DO UPDATE would land on it — writing a fresh name and properties
      // onto a row that was merged away, and (via RETURNING below) handing its
      // id back as this key's resolution, undoing the tombstone-following two
      // lines up. The source's update is dropped rather than misapplied: the
      // canonical row cannot be reached through this linked key, and reaching
      // it needs the provenance table in docs/architecture/entity-merge.md §2.1b.
      const toWrite = distinct.filter((p) => {
        const current = existingByCoord.get(coordKey(p.entityType, p.linkedTable, p.linkedId));

        if (current?.mergedIntoEntityId != null) {
          return false;
        }

        return current === undefined || isStale(current, p.row, p.unionKeys);
      });
      if (toWrite.length > 0) {
        // Split into param-budget-bounded chunks so a large batch never exceeds
        // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
        // bulkInsertIdempotent uses). ON CONFLICT idempotency + RETURNING-based
        // resolution are unchanged; the returned rows are accumulated across
        // chunks.
        //
        // And one statement per set-key list, because the merge binds that list
        // as a parameter. A parser declares the same keys for every entity of
        // a kind, so a batch holds a handful of lists, not one per row.
        //
        // `entity_id` is deliberately NOT in the SET list: a conflicting row
        // keeps the id it was created with (and that everything else already
        // references), so the uuidv7 minted for the insert attempt is simply
        // discarded. RETURNING hands back the row's real id either way.
        const byUnionKeys = new Map<string, Prepared[]>();
        for (const p of toWrite) {
          const signature = JSON.stringify(p.unionKeys);
          const group = byUnionKeys.get(signature);
          if (group) {
            group.push(p);
          } else {
            byUnionKeys.set(signature, [p]);
          }
        }

        const chunkSize = computeChunkSize(this.nodeRepository.metadata.columns.length);
        for (const group of byUnionKeys.values()) {
          const rows = group.map((p) => p.row);
          for (let offset = 0; offset < rows.length; offset += chunkSize) {
            const insertResult = await this.nodeRepository
              .createQueryBuilder()
              .insert()
              .into(this.nodeRepository.metadata.target)
              .values(rows.slice(offset, offset + chunkSize))
              .onConflict(ENTITY_CONFLICT_ACTION)
              .setParameter('unionKeys', group[0].unionKeys)
              .returning([
                'entityId',
                'entityType',
                'linkedTable',
                'linkedId',
                'name',
                'description',
                'properties',
              ])
              .execute();

            for (const raw of (insertResult.raw as Array<Record<string, unknown>>) ?? []) {
              const ck = coordKey(String(raw.entity_type), String(raw.linked_table), String(raw.linked_id));
              idByCoord.set(ck, String(raw.entity_id));
              written.set(ck, {
                name: (raw.name as string | null) ?? null,
                description: (raw.description as string | null) ?? null,
                properties: (raw.properties as Record<string, unknown> | null) ?? {},
              });
            }
          }
        }

        // A row the statement left alone — one that became a merge tombstone
        // after step 1 read it — must not keep the id step 1 resolved it to.
        // Forgetting it sends the key through step 3, which follows the
        // tombstone to the row it was merged into.
        for (const p of toWrite) {
          const ck = coordKey(p.entityType, p.linkedTable, p.linkedId);
          if (!written.has(ck)) {
            idByCoord.delete(ck);
          }
        }

        await this.graphDeltaWriter.recordMany(
          toWrite.flatMap((p) => {
            const ck = coordKey(p.entityType, p.linkedTable, p.linkedId);
            const entityId = idByCoord.get(ck);
            // What the row holds now, as RETURNED — the merge's result, which is
            // not what this source sent whenever anyone else has written to it.
            const now = written.get(ck);
            if (!entityId || now === undefined) {
              return [];
            }

            const current = existingByCoord.get(ck);

            return [
              {
                nodeType: 'entity' as const,
                changeType: (current ? 'updated' : 'created') as 'created' | 'updated',
                entityId,
                entityType: p.entityType,
                ownerUserId: ownerId,
                changeSource: 'GraphIngestService.upsertEntities',
                changedFields: {
                  name: current ? { old: current.name, new: now.name } : { new: now.name },
                  description: current
                    ? { old: current.description, new: now.description }
                    : { new: now.description },
                  entity_type: { new: p.entityType },
                  properties: current
                    ? { old: current.properties, new: now.properties }
                    : { new: now.properties },
                },
              },
            ];
          }),
        );
      }

      // 3. Re-resolve any coordinate still unmapped: a concurrent writer won the
      // ON CONFLICT race, so the row exists but wasn't returned to us. One SELECT.
      const unresolved = distinct.filter(
        (p) => !idByCoord.has(coordKey(p.entityType, p.linkedTable, p.linkedId)),
      );
      if (unresolved.length > 0) {
        const winners = await this.findExistingNodes(ownerId, unresolved);
        for (const row of winners) {
          idByCoord.set(coordKey(row.entityType, row.linkedTable!, row.linkedId!), canonicalIdOf(row));
        }
      }
    } catch (err) {
      // A batch-level failure (e.g. the DB is unavailable) can't be attributed to
      // one row, so — matching the prior loop's per-entity catch — report it
      // against every unresolved input and resolve none of them.
      const message = (err as Error).message;
      for (const input of inputs) {
        errors.push(`entity ${input.key}: ${message}`);
      }

      return resolved;
    }

    // Map each input DTO (including intra-batch duplicates) to its resolved id.
    for (const p of prepared) {
      const id = idByCoord.get(coordKey(p.entityType, p.linkedTable, p.linkedId));
      if (id === undefined) {
        errors.push(`entity ${p.input.key}: could not resolve entity id after upsert`);
        continue;
      }

      resolved.set(p.input, id);
    }

    return resolved;
  }

  /** One SELECT resolving the given linked-key coordinates to existing rows. */
  private async findExistingNodes(
    ownerId: string,
    coords: Array<{ entityType: string; linkedTable: string; linkedId: string }>,
  ): Promise<NodeEntity[]> {
    if (coords.length === 0) {
      return [];
    }

    const qb = this.nodeRepository
      .createQueryBuilder('e')
      .where('e.userId = :ownerId', { ownerId })
      .andWhere(
        new Brackets((outer: WhereExpressionBuilder) => {
          coords.forEach((c, i) => {
            outer.orWhere(
              `(e.entityType = :et_${i} AND e.linkedTable = :lt_${i} AND e.linkedId = :li_${i})`,
              { [`et_${i}`]: c.entityType, [`lt_${i}`]: c.linkedTable, [`li_${i}`]: c.linkedId },
            );
          });
        }),
      );

    return qb.getMany();
  }

  /**
   * Register the batch's contact identifiers (each entity's properties.emails /
   * properties.phones / properties.names — display-name identifiers for chat
   * networks that export no email/phone) in ci.entity_identifiers for
   * people-linking, via ONE set-based chunked INSERT for the whole ingest call
   * (formerly one statement per entity). No-op on an empty batch. Defensive:
   * even though the importer pre-normalizes, the service re-applies the
   * canonical rule. Swallows + logs its own errors so a bad identifier write
   * never aborts the entity ingest.
   */
  private async indexIdentifiers(ownerId: string, batch: EntityIdentifierBatchEntry[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    try {
      await this.entityIdentifierService.upsertForEntities(ownerId, batch);
    } catch (err) {
      this.logger.warn('Failed to index entity identifiers', {
        entities: batch.length,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Set-based upsert of a batch of already-endpoint-resolved edges. Returns the
   * count that landed (existing + freshly inserted). Rows that violate a table
   * CHECK (a self-reference: from == to) are dropped with a per-edge error,
   * mirroring the prior loop where such a save() threw and was caught per edge.
   *
   * Statement budget per call: one existence SELECT + one batched INSERT ... ON
   * CONFLICT DO NOTHING, replacing the former N×(findOne+save). Idempotency is
   * unchanged — the directed (from, to, type) unique index collapses re-sends.
   */
  private async upsertRelationships(
    ownerId: string,
    edges: ResolvedEdge[],
    errors: string[],
  ): Promise<number> {
    if (edges.length === 0) {
      return 0;
    }

    const edgeKey = (fromId: string, toId: string, type: string): string => `${fromId}||${toId}||${type}`;

    // Drop self-references up front (the no_self_references CHECK would reject the
    // whole INSERT otherwise); report each, exactly as the prior per-edge catch.
    // Collapse intra-batch duplicate (from, to, type) edges to one row.
    interface Prepared {
      edge: ResolvedEdge;
      key: string;
      row: RelationshipEntity;
    }
    const prepared: Prepared[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.fromId === e.toId) {
        errors.push(`relationship ${e.r.fromKey}->${e.r.toKey}: self-reference not allowed`);
        continue;
      }

      const key = edgeKey(e.fromId, e.toId, e.r.type);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      const row = this.relationshipRepository.create({
        id: uuidv7(),
        fromNodeId: e.fromId,
        fromNodeType: e.fromType,
        toNodeId: e.toId,
        toNodeType: e.toType,
        type: e.r.type,
        strength: 1,
        isBidirectional: false,
        userId: ownerId,
        properties: e.r.properties ?? {},
      });
      prepared.push({ edge: e, key, row });
    }

    if (prepared.length === 0) {
      return 0;
    }

    try {
      // 1. Existence pre-check over the distinct (from, to, type) edges.
      const existingKeys = new Set<string>();
      const existing = await this.relationshipRepository
        .createQueryBuilder('r')
        .where('r.userId = :ownerId', { ownerId })
        .andWhere(
          new Brackets((outer: WhereExpressionBuilder) => {
            prepared.forEach((p, i) => {
              outer.orWhere(`(r.fromNodeId = :rf_${i} AND r.toNodeId = :rt_${i} AND r.type = :rtype_${i})`, {
                [`rf_${i}`]: p.row.fromNodeId,
                [`rt_${i}`]: p.row.toNodeId,
                [`rtype_${i}`]: p.row.type,
              });
            });
          }),
        )
        .getMany();
      for (const row of existing) {
        existingKeys.add(edgeKey(row.fromNodeId, row.toNodeId, row.type));
      }

      // 2. Batched INSERT of the not-yet-present edges. ON CONFLICT DO NOTHING
      // targets the directed-uniqueness partial index and absorbs any concurrent
      // race, so an edge inserted between our SELECT and INSERT is a no-op here.
      const toInsert = prepared.filter((p) => !existingKeys.has(p.key));
      if (toInsert.length > 0) {
        // Split into param-budget-bounded chunks so a large batch never exceeds
        // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
        // bulkInsertIdempotent uses). ON CONFLICT idempotency is unchanged.
        const rows = toInsert.map((p) => p.row);
        const chunkSize = computeChunkSize(this.relationshipRepository.metadata.columns.length);
        for (let offset = 0; offset < rows.length; offset += chunkSize) {
          await this.relationshipRepository
            .createQueryBuilder()
            .insert()
            .into(this.relationshipRepository.metadata.target)
            .values(rows.slice(offset, offset + chunkSize))
            .onConflict('(from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE DO NOTHING')
            .execute();
        }

        await this.graphDeltaWriter.recordMany(
          toInsert.map(({ row }) => ({
            nodeType: 'relationship' as const,
            changeType: 'created' as const,
            relationshipId: row.id,
            relationshipType: row.type,
            fromEntityId: row.fromNodeId,
            toEntityId: row.toNodeId,
            ownerUserId: ownerId,
            changeSource: 'GraphIngestService.upsertRelationships',
            changedFields: {
              relationship_type: { new: row.type },
              from_entity_id: { new: row.fromNodeId },
              to_entity_id: { new: row.toNodeId },
              properties: { new: row.properties ?? {} },
            },
          })),
        );
      }
    } catch (err) {
      // A batch-level failure can't be pinned to one edge — report it against
      // every prepared edge and count none as processed, matching how the prior
      // loop would have surfaced a non-race save() failure per edge.
      const message = (err as Error).message;
      for (const p of prepared) {
        errors.push(`relationship ${p.edge.r.fromKey}->${p.edge.r.toKey}: ${message}`);
      }

      return 0;
    }

    // Every prepared edge is now present (existing or inserted). Duplicates that
    // shared a triple were folded into one row above but each input edge counted;
    // report the count of input edges that resolved to a landed row.
    return edges.filter((e) => e.fromId !== e.toId).length;
  }

  /**
   * Resolve the owner's self entity, provisioning it when absent. The self
   * entity anchors every `self->…` edge (preferences from extract-graph, the
   * importer's own self-links). Its canonical pointer is ci.users.entity_id,
   * which a from-scratch ingest — or any data wipe — leaves NULL, so the owner
   * has no self and every self-anchored edge was silently dropped
   * ("endpoint not found in batch", preferenceEdgesWritten=0). Here we create a
   * stable `Person` for the owner (named from ci.users.name) and link
   * ci.users.entity_id to it, so a fresh import yields a complete graph with
   * preferences actually attached to the user.
   *
   * Idempotent and concurrency-safe: the Person upserts on its linked key (the
   * one onboarding creates its self Person under too), the pointer is only set
   * while still NULL, and we re-resolve before claiming the owner's identifiers
   * so a pointer a concurrent writer won is honoured — and claimed for — over
   * the row we created. Returns null only when there is no ci.users row to
   * anchor (a non-user context).
   */
  private async ensureSelfEntity(ownerId: string): Promise<{ id: string; type: string } | null> {
    const existing = await this.resolveSelfEntity(ownerId);
    if (existing) {
      const users: Array<{ name: string | null; email: string | null }> =
        await this.nodeRepository.manager.query(`SELECT name, email FROM ci.users WHERE id = $1`, [ownerId]);
      const displayName = users[0]?.name?.trim() || users[0]?.email?.trim() || 'Me';
      const email = users[0]?.email?.trim() || null;
      await this.markSelfEntity(ownerId, existing.id);
      await this.entityIdentifierService.claimForSelf(ownerId, existing.id, {
        emails: email ? [email] : [],
        names: [displayName],
      });
      if (email) {
        await this.entityIdentifierService.repointToEntity(ownerId, existing.id, 'email', email, 'self');
      }

      return existing;
    }

    const users: Array<{ name: string | null; email: string | null }> =
      await this.nodeRepository.manager.query(`SELECT name, email FROM ci.users WHERE id = $1`, [ownerId]);
    if (users.length === 0) {
      this.logger.warn('Cannot provision self entity: no ci.users row for owner', { ownerId });

      return null;
    }

    const displayName = users[0].name?.trim() || users[0].email?.trim() || 'Me';
    const email = users[0].email?.trim() || null;

    // Provision the self Person through the same set-based upsert (a batch of
    // one), so its idempotency/race handling matches every other ingested entity.
    const selfDto: GraphEntityInputDto = {
      key: selfKeyFor(ownerId),
      entityType: SELF_ENTITY_TYPE,
      name: displayName,
      sourceSystem: SELF_SOURCE_SYSTEM,
      properties: {
        is_self: true,
        ...(email ? { email, emails: [email] } : {}),
        names: [displayName],
      },
    };
    const selfErrors: string[] = [];
    const selfResolved = await this.upsertEntities(ownerId, [selfDto], selfErrors);
    const selfEntityId = selfResolved.get(selfDto);
    if (selfEntityId === undefined) {
      throw new Error(selfErrors[0] ?? 'failed to provision self entity');
    }

    await this.markSelfEntity(ownerId, selfEntityId);

    // Link the owner to it, but never clobber a pointer set concurrently.
    await this.nodeRepository.manager.query(
      `UPDATE ci.users SET entity_id = $2 WHERE id = $1 AND entity_id IS NULL`,
      [ownerId, selfEntityId],
    );

    // Honour whatever pointer actually won; fall back to the row we created.
    // The owner's identifiers go to that Person, read BEFORE claiming: a writer
    // that pointed the account between our read and our write may have named
    // another Person, and claiming the owner's address for a row the account
    // does not point at would strand it there. Onboarding creates its self
    // Person under this same key, so racing it ends on this very row.
    const self = (await this.resolveSelfEntity(ownerId)) ?? { id: selfEntityId, type: SELF_ENTITY_TYPE };
    if (self.id !== selfEntityId) {
      await this.markSelfEntity(ownerId, self.id);
      this.logger.warn('Provisioned a self entity, but the account was pointed at another one', {
        ownerId,
        selfEntityId,
        pointer: self.id,
      });
    }

    await this.entityIdentifierService.claimForSelf(ownerId, self.id, {
      emails: email ? [email] : [],
      names: [displayName],
    });
    if (email) {
      await this.entityIdentifierService.repointToEntity(ownerId, self.id, 'email', email, 'self');
    }

    this.logger.log('Provisioned self entity for owner', { ownerId, selfEntityId, displayName });

    return self;
  }

  private async markSelfEntity(ownerId: string, entityId: string): Promise<void> {
    await this.nodeRepository.manager.query(
      `UPDATE ci.entities
          SET is_self = TRUE,
              properties = COALESCE(properties, '{}'::jsonb) || jsonb_build_object('is_self', TRUE),
              updated_at = now()
        WHERE entity_id = $1::uuid
          AND owner_user_id = $2::uuid`,
      [entityId, ownerId],
    );
  }

  /**
   * The owner's own entity, used to anchor `self` edges. The canonical source is
   * `ci.users.entity_id` — a user's self entity is provisioned as a `Person`
   * (their display name), NOT an `entity_type = 'User'` row, so the previous
   * lookup by entityType found nothing and every `self->…` edge was dropped.
   * Returns the resolved id + its actual entity_type, or null if the user has no
   * self entity. The User entity_type is kept only as a fallback label.
   */
  private async resolveSelfEntity(ownerId: string): Promise<{ id: string; type: string } | null> {
    const rows: Array<{ entity_id: string; entity_type: string }> = await this.nodeRepository.manager.query(
      `SELECT e.entity_id, e.entity_type
         FROM ci.users u
         JOIN ci.entities e ON e.entity_id = u.entity_id
        WHERE u.id = $1`,
      [ownerId],
    );

    return rows[0] ? { id: rows[0].entity_id, type: rows[0].entity_type } : null;
  }
}

/**
 * The live entity a resolved row stands for.
 *
 * A merge tombstone KEEPS its linked key — that is why the row survives at all —
 * so it goes on winning the (owner, entity_type, linked_table, linked_id)
 * lookup after the merge. Returning it would re-attach the merged-away source's
 * next sync to a dead row: names and properties written onto a tombstone, and
 * this batch's relationships wired to a node nothing reads. Follow the pointer
 * instead, so a re-sync lands on the row the duplicate was merged INTO.
 *
 * One hop is enough by construction: PersonMergeService re-points existing
 * tombstones at the new target as part of merging, so `merged_into_entity_id`
 * never chains. That invariant is asserted in PersonMergeService.spec.
 */
function canonicalIdOf(row: NodeEntity): string {
  return row.mergedIntoEntityId ?? row.entityId;
}

/**
 * An ingested entity's raw identifier payload (properties.emails / .phones /
 * .names), or null when it carries none — the same "has anything to index"
 * gate the former per-entity path applied, so identifier-less entities never
 * enter the batch.
 */
function rawIdentifiersOf(e: GraphEntityInputDto): EntityIdentifierBatchEntry['raw'] | null {
  const props = e.properties;
  if (props == null) {
    return null;
  }

  const { emails, phones, names } = props;
  if (emails == null && phones == null && names == null) {
    return null;
  }

  return { emails, phones, names };
}

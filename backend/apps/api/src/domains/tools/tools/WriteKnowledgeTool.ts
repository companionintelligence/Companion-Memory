import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import {
  GraphEventService,
  type GraphNodeEntity,
  GraphQueryService,
  type RelationshipEntity,
} from '@ci/domains/memory';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { booleanish } from './booleanish';
import { coerceWriteKnowledgeInput } from './writeKnowledgeCoerce';

const EntityCreateSchema = z.object({
  kind: z.literal('entity.create'),
  entityId: z.string().uuid().optional(),
  entityType: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
  searchContent: z.string().optional(),
  linkedTable: z.string().optional(),
  linkedId: z.string().uuid().optional(),
  relationships: z
    .array(
      z.object({
        toEntityId: z.string().uuid(),
        relationshipType: z.string().min(1),
        properties: z.record(z.unknown()).optional(),
        strength: z.number().min(0).max(1).optional(),
        isBidirectional: booleanish().optional(),
      }),
    )
    .optional(),
});

const EntityUpdateSchema = z.object({
  kind: z.literal('entity.update'),
  entityId: z.string().uuid(),
  entityType: z.string().min(1).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
  mergeProperties: booleanish().optional(),
  removeProperties: z.array(z.string()).optional(),
  searchContent: z.string().optional(),
  linkedTable: z.string().optional(),
  linkedId: z.string().uuid().optional(),
});

const NamedRefSchema = z.object({
  entityType: z.string().min(1).optional(),
  name: z.string().min(1),
});

const RelationshipCreateSchema = z.object({
  kind: z.literal('relationship.create'),
  relationshipId: z.string().uuid().optional(),
  fromEntityId: z.string().uuid().optional(),
  toEntityId: z.string().uuid().optional(),
  from: NamedRefSchema.optional(),
  to: NamedRefSchema.optional(),
  relationshipType: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
  strength: z.number().min(0).max(1).optional(),
  isBidirectional: booleanish().optional(),
});

const RelationshipUpdateSchema = z.object({
  kind: z.literal('relationship.update'),
  relationshipId: z.string().uuid(),
  relationshipType: z.string().min(1).optional(),
  properties: z.record(z.unknown()).optional(),
  mergeProperties: booleanish().optional(),
  removeProperties: z.array(z.string()).optional(),
  strength: z.number().min(0).max(1).optional(),
  isBidirectional: booleanish().optional(),
});

const OperationSchema = z.discriminatedUnion('kind', [
  EntityCreateSchema,
  EntityUpdateSchema,
  RelationshipCreateSchema,
  RelationshipUpdateSchema,
]);

const WriteKnowledgeInputSchema = z.object({
  operations: z.array(OperationSchema).min(1),
  dryRun: booleanish().optional(),
});

export type WriteKnowledgeInput = z.infer<typeof WriteKnowledgeInputSchema>;

/** One of the `relationships` an `entity.create` carries, from that entity. */
type NestedRelationship = NonNullable<z.infer<typeof EntityCreateSchema>['relationships']>[number];

/**
 * Entity and relationship types compare case-insensitively: a model writing
 * `person` means the stored `Person`. They are NOT interchangeable in storage —
 * importers key rows on the exact type, and the per-type services match it
 * exactly — so a case-only difference must never reach the write as a retype.
 */
function sameGraphType(stored: string, requested: string): boolean {
  return stored.trim().toLowerCase() === requested.trim().toLowerCase();
}

/** The requested type, unless it only differs from the stored one in case or whitespace. */
function keepStoredSpelling(stored: string, requested: string | undefined): string {
  return requested === undefined || sameGraphType(stored, requested) ? stored : requested;
}

/** `valid_relationship_type`, the CHECK on `ci.relationships.relationship_type`. */
const STORABLE_RELATIONSHIP_TYPE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * A relationship type spelled the way `ci.relationships` stores it — upper snake
 * case, the CHECK above — or `null` when no spelling of it can be stored. The
 * write happens after the tool has answered, so a `knows` or a `works at` sent
 * through as is failed there, and the model had already been told the
 * relationship was saved. The stored spelling is also what finds the edge an
 * importer wrote: `KNOWS` is on the coordinate, `knows` is not. Same folding as
 * `normalizeRelationship`'s key, without its renames.
 */
function storedRelationshipType(requested: string): string | null {
  const spelled = requested
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  return STORABLE_RELATIONSHIP_TYPE.test(spelled) ? spelled : null;
}

function unstorableTypeMessage(requested: string): string {
  return (
    `Relationship type "${requested}" cannot be stored: use letters, digits and underscores, ` +
    'not starting with a digit (e.g. WORKS_AT)'
  );
}

/**
 * Whether an id-reuse write describes the edge its id names. A bidirectional
 * edge matches in either orientation — unless the write asks for a one-way edge,
 * which the stored one reversed is not (see GraphUtilityService.findActiveRelationship).
 */
function isSameEdge(
  edge: Pick<
    RelationshipEntity,
    'from_entity_id' | 'to_entity_id' | 'relationship_type' | 'is_bidirectional'
  >,
  fromEntityId: string,
  toEntityId: string,
  relationshipType: string,
  isBidirectional: boolean | undefined,
): boolean {
  if (!sameGraphType(edge.relationship_type, relationshipType)) {
    return false;
  }

  if (edge.from_entity_id === fromEntityId && edge.to_entity_id === toEntityId) {
    return true;
  }

  return (
    edge.is_bidirectional &&
    isBidirectional !== false &&
    edge.from_entity_id === toEntityId &&
    edge.to_entity_id === fromEntityId
  );
}

/** Where `entities_linked_uniq` puts an entity: its type, linked table and linked id. */
type LinkedKey = Parameters<GraphQueryService['findLinkedKeyHolder']>[1];

/**
 * Why a node write is refused: `occupant` already has the linked key it would
 * give an entity. `entityId` names the entity the write would move there, and is
 * absent when the write would create one.
 */
function linkedKeyHeldMessage(
  entityId: string | undefined,
  key: LinkedKey,
  occupant: Pick<GraphNodeEntity, 'entity_id' | 'is_active'>,
): string {
  const place = `the ${key.entityType} linked to ${key.linkedTable} record ${key.linkedId}`;
  const refused = entityId ? `Entity ${entityId} cannot become ${place}` : `Cannot create ${place}`;

  // A forgotten or merged-away entity cannot be updated through this tool, and
  // it still holds its key.
  if (!occupant.is_active) {
    const stillHeld =
      `${refused}: entity ${occupant.entity_id} still is, although it has been forgotten or merged into ` +
      'another entity.';

    return entityId
      ? stillHeld
      : `${stillHeld} Leave out linkedTable and linkedId to create a separate entity.`;
  }

  return entityId
    ? `${refused}: entity ${occupant.entity_id} already is. Update ${occupant.entity_id} instead, and forget ` +
        `${entityId} (memory.forget) if it is a duplicate of ${occupant.entity_id}.`
    : `${refused}: entity ${occupant.entity_id} already is. Update ${occupant.entity_id} instead, or leave out ` +
        'linkedTable and linkedId to create a separate entity.';
}

interface OperationResultSummary {
  kind: string;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  message: string;
  entityId?: string;
  relationshipId?: string;
}

export interface WriteKnowledgeOutput {
  dryRun: boolean;
  results: OperationResultSummary[];
  createdNodes: number;
  updatedNodes: number;
  createdRelationships: number;
  updatedRelationships: number;
  failures: number;
}

@Injectable()
export class WriteKnowledgeTool extends BaseTool<WriteKnowledgeInput, WriteKnowledgeOutput> {
  readonly schema: IntentDefinition = {
    name: 'memory.remember',
    domain: 'memory',
    title: 'Remember a fact',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    // A local write is the offline-first case: record it on-device now, let sync carry it up. It is
    // not destructive, so nothing is lost if the appliance later reconciles it.
    localCapable: true,
    produces: ['concept', 'person'],
    phrases: ['Remember that $fact', 'Note that $fact'],
    description:
      'Create or update entities and relationships in the personal knowledge graph. Prefer one call. kind must be entity.create, entity.update, relationship.create, or relationship.update. For new facts, entity.create with entityType + name; link with relationship.create using from/to {name} of entities in the same call. Do not retry a successful create.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: {
                type: 'string',
                enum: ['entity.create', 'entity.update', 'relationship.create', 'relationship.update'],
              },
              entityType: { type: 'string' },
              name: { type: 'string' },
              properties: { type: 'object' },
              relationshipType: { type: 'string' },
              from: {
                type: 'object',
                properties: { name: { type: 'string' }, entityType: { type: 'string' } },
              },
              to: {
                type: 'object',
                properties: { name: { type: 'string' }, entityType: { type: 'string' } },
              },
              fromEntityId: { type: 'string' },
              toEntityId: { type: 'string' },
            },
          },
        },
        dryRun: {
          type: 'boolean',
          description: 'If true, validates and reports operations without performing writes.',
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
    examples: [
      {
        input: {
          operations: [
            {
              kind: 'entity.create',
              entityType: 'Concept',
              name: 'Pilates',
              properties: { category: 'fitness' },
            },
          ],
        },
        output: {
          dryRun: false,
          results: [
            {
              kind: 'entity.create',
              status: 'created',
              message: 'Created entity',
            },
          ],
          createdNodes: 1,
          updatedNodes: 0,
          createdRelationships: 0,
          updatedRelationships: 0,
          failures: 0,
        },
        description: 'Add a new concept to the knowledge graph',
      },
    ],
  };

  constructor(
    private readonly graphEvents: GraphEventService,
    private readonly graphQuery: GraphQueryService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(WriteKnowledgeTool.name);
  }

  protected validateInput(input: unknown): WriteKnowledgeInput {
    return WriteKnowledgeInputSchema.parse(coerceWriteKnowledgeInput(input));
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: WriteKnowledgeInput,
  ): Promise<WriteKnowledgeOutput> {
    if (!context.userId) {
      throw new Error('User context is required to write knowledge');
    }

    const ownerId = context.userId;
    const dryRun = input.dryRun ?? false;
    const results: OperationResultSummary[] = [];

    let createdNodes = 0;
    let updatedNodes = 0;
    let createdRelationships = 0;
    let updatedRelationships = 0;
    let failures = 0;
    const createdByName = new Map<string, string>();

    const rememberName = (entityType: string, name: string | undefined, entityId: string) => {
      if (!name || name.trim() === '') {
        return;
      }

      const trimmed = name.trim().toLowerCase();
      createdByName.set(trimmed, entityId);
      createdByName.set(`${entityType.trim().toLowerCase()}::${trimmed}`, entityId);
    };

    // Entity ops first so later relationship.create can resolve from/to by name
    // against ids minted in this same batch (Qwen rarely has UUIDs).
    const ordered = [
      ...input.operations.filter((operation) => operation.kind.startsWith('entity.')),
      ...input.operations.filter((operation) => operation.kind.startsWith('relationship.')),
    ];

    for (const operation of ordered) {
      try {
        switch (operation.kind) {
          case 'entity.create': {
            const existing = operation.entityId
              ? await this.graphQuery.getNode(ownerId, operation.entityId, { includeInactive: true })
              : null;

            // A soft-deleted (forgotten) row still owns its id, so an id-reuse
            // create must not fall through to createOrUpdateNode's update
            // branch, which unconditionally flips is_active back to true.
            if (existing && !existing.is_active) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: `Entity ${existing.entity_id} was forgotten and cannot be recreated by id reuse`,
                entityId: existing.entity_id,
              });
              failures += 1;
              break;
            }

            // entity_type is half of the coordinate an importer upserts on, and
            // the per-type services match it exactly, so an id-reuse create
            // keeps the stored spelling and refuses a real change of type: a
            // model that calls a Person an Organization has most likely picked
            // up the wrong id, and its name and properties would land on that
            // row. entity.update stays the one explicit way to retype.
            if (existing && !sameGraphType(existing.entity_type, operation.entityType)) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message:
                  `Entity ${existing.entity_id} is a ${existing.entity_type}; entity.create with an existing ` +
                  `entityId cannot make it a ${operation.entityType}. Omit entityId to create a new entity.`,
                entityId: existing.entity_id,
              });
              failures += 1;
              break;
            }

            const entityType = existing?.entity_type ?? operation.entityType;
            const knownName = operation.name ?? existing?.name ?? undefined;

            // The other door onto entities_linked_uniq (see entity.update): a new
            // entity on a linked key another entity holds, or an id-reuse create
            // that re-keys its row onto one, failed after this tool had answered.
            const linkedKey = {
              entityType,
              linkedTable: operation.linkedTable ?? existing?.linked_table ?? null,
              linkedId: operation.linkedId ?? existing?.linked_id ?? null,
            };
            const occupant = await this.findLinkedKeyOccupant(ownerId, existing, linkedKey);
            if (occupant) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: linkedKeyHeldMessage(existing?.entity_id, linkedKey, occupant),
                entityId: existing?.entity_id,
              });
              failures += 1;
              break;
            }

            if (dryRun) {
              rememberName(entityType, knownName, operation.entityId ?? 'dry-run');
              if (existing) {
                updatedNodes += 1;
                results.push({
                  kind: operation.kind,
                  status: 'updated',
                  message: `Dry run: would update existing entity ${existing.entity_id}`,
                  entityId: existing.entity_id,
                });
              } else {
                createdNodes += 1;
                results.push({
                  kind: operation.kind,
                  status: 'created',
                  message: 'Dry run: would create entity',
                });
              }

              break;
            }

            const nestedRelationships = operation.relationships?.length
              ? await this.prepareNestedRelationships(ownerId, operation.entityId, operation.relationships)
              : [];

            // Only what the caller supplied goes out: every other field, the
            // linked key included, stays `undefined` through GraphEventService
            // and the listener, which createOrUpdateNode reads as "leave it".
            // An id-reuse create lands on a row that may be imported, and the
            // model sees neither its linked key nor the property keys other
            // writers own — PersonMergeService's folded identifiers, is_self,
            // structured names, planner settings. Sending `null`s and
            // `mergeProperties: false` here used to clear the key (so the next
            // import minted a duplicate) and swap the whole bag for whatever the
            // model sent.
            //
            // Merging is also what makes a retried create harmless, and it is
            // not conditional on `existing`: `entityId` can name a row whose own
            // create is still queued, so this write may meet a row the read
            // above did not. On a brand-new row the insert defaults an omitted
            // field exactly as it would a null one, so nothing changes there.
            const { entityId } = await this.graphEvents.upsertNode(ownerId, {
              entityId: operation.entityId,
              entityType,
              name: operation.name,
              description: operation.description,
              properties: operation.properties,
              searchContent: operation.searchContent,
              linkedTable: operation.linkedTable,
              linkedId: operation.linkedId,
              mergeProperties: true,
            });

            if (nestedRelationships.length) {
              const nested = await this.writeNestedRelationships(ownerId, entityId, nestedRelationships);
              createdRelationships += nested.created;
              updatedRelationships += nested.updated;
            }

            rememberName(entityType, knownName, entityId);
            if (existing) {
              updatedNodes += 1;
              results.push({
                kind: operation.kind,
                status: 'updated',
                message: `Updated existing entity ${entityId}`,
                entityId,
              });
            } else {
              createdNodes += 1;
              results.push({
                kind: operation.kind,
                status: 'created',
                message: `Created entity ${entityId}`,
                entityId,
              });
            }

            break;
          }

          case 'entity.update': {
            const existing = await this.graphQuery.getNode(ownerId, operation.entityId);
            if (!existing) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: `Entity ${operation.entityId} not found or not owned by user`,
                entityId: operation.entityId,
              });
              failures += 1;
              break;
            }

            // A retype or a re-key moves the entity to another (entity_type,
            // linked_table, linked_id), and entities_linked_uniq allows one of
            // the owner's rows on each, a forgotten or merged-away one included:
            // when another is already there the write fails after this tool has
            // answered, and the job dead-letters. A card imported once as a
            // Concept and once as a Person leaves twins on one linked key, so
            // "this Concept is really a Person" is exactly that write. The two
            // are not merged here — that would retire one of them, which is
            // memory.forget's to do, behind its own confirmation — so say which
            // entity is in the way and leave the choice to the caller.
            const entityType = keepStoredSpelling(existing.entity_type, operation.entityType);
            const linkedKey = {
              entityType,
              linkedTable: operation.linkedTable ?? existing.linked_table,
              linkedId: operation.linkedId ?? existing.linked_id,
            };
            const occupant = await this.findLinkedKeyOccupant(ownerId, existing, linkedKey);
            if (occupant) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: linkedKeyHeldMessage(existing.entity_id, linkedKey, occupant),
                entityId: operation.entityId,
              });
              failures += 1;
              break;
            }

            if (dryRun) {
              results.push({
                kind: operation.kind,
                status: 'updated',
                message: 'Dry run: would update entity',
                entityId: operation.entityId,
              });
              updatedNodes += 1;
              break;
            }

            // Same shape as an id-reuse create: send only what the caller set
            // and let the merge (or replace, or removal) run against the row as
            // it is when the queued write lands. Sending back the fields read
            // above instead would revert whatever another writer — an import
            // refresh, a person merge, the planner — changed in the meantime.
            const { entityId } = await this.graphEvents.upsertNode(ownerId, {
              entityId: operation.entityId,
              entityType,
              name: operation.name,
              description: operation.description,
              properties: operation.properties,
              mergeProperties: operation.mergeProperties !== false,
              removeProperties: operation.removeProperties,
              searchContent: operation.searchContent,
              linkedTable: operation.linkedTable,
              linkedId: operation.linkedId,
            });

            updatedNodes += 1;
            results.push({
              kind: operation.kind,
              status: 'updated',
              message: `Updated entity ${entityId}`,
              entityId,
            });
            break;
          }

          case 'relationship.create': {
            const byId = operation.relationshipId
              ? (
                  await this.graphQuery.getRelationships(ownerId, {
                    relationshipIds: [operation.relationshipId],
                    includeInactive: true,
                  })
                )[0]
              : undefined;

            // Same id-reuse guard as entity.create, mirrored for relationships.
            if (byId && !byId.is_active) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: `Relationship ${byId.relationship_id} was forgotten and cannot be recreated by id reuse`,
                relationshipId: byId.relationship_id,
              });
              failures += 1;
              break;
            }

            const relationshipType = storedRelationshipType(operation.relationshipType);
            if (!relationshipType) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: unstorableTypeMessage(operation.relationshipType),
              });
              failures += 1;
              break;
            }

            const fromEntityId = await this.resolveEndpoint(
              ownerId,
              operation.fromEntityId,
              operation.from,
              createdByName,
            );
            const toEntityId = await this.resolveEndpoint(
              ownerId,
              operation.toEntityId,
              operation.to,
              createdByName,
            );

            if (!fromEntityId || !toEntityId) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: 'Could not resolve relationship endpoints by id or name',
              });
              failures += 1;
              break;
            }

            // `no_self_references` would refuse the write after the tool had
            // answered; two names can fuzzy-match to the same entity.
            if (fromEntityId === toEntityId) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: `Both ends of the relationship resolved to entity ${fromEntityId}; a relationship needs two different entities`,
              });
              failures += 1;
              break;
            }

            // The edge counterpart of entity.create's type check. An importer
            // keys its edges on (from, to, type), so an id-reuse create may not
            // move the edge or retype it — relationship.update never moves an
            // edge either.
            if (
              byId &&
              !isSameEdge(byId, fromEntityId, toEntityId, relationshipType, operation.isBidirectional)
            ) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message:
                  `Relationship ${byId.relationship_id} is ${byId.from_entity_id} ` +
                  `-[${byId.relationship_type}]-> ${byId.to_entity_id}; relationship.create ` +
                  'with an existing relationshipId cannot move or retype it. Omit relationshipId to create ' +
                  'a new relationship.',
                relationshipId: byId.relationship_id,
              });
              failures += 1;
              break;
            }

            // Without an id — how a model restates a fact — or with one that
            // names no row, the edge may still exist on its coordinate: an
            // importer's, or one an earlier write made. The write merges into
            // it either way, since createOrUpdateRelationship resolves the same
            // coordinate when it lands; finding it here lets the result name
            // that edge and say it was updated, rather than report an id no row
            // will ever carry. One that only appears after this read is still
            // merged into — just reported as created.
            const existingRel =
              byId ??
              (await this.graphQuery.findActiveRelationship(ownerId, {
                fromEntityId,
                toEntityId,
                relationshipType,
                isBidirectional: operation.isBidirectional,
              }));

            if (dryRun) {
              if (existingRel) {
                updatedRelationships += 1;
                results.push({
                  kind: operation.kind,
                  status: 'updated',
                  message: `Dry run: would update existing relationship ${existingRel.relationship_id}`,
                  relationshipId: existingRel.relationship_id,
                });
              } else {
                createdRelationships += 1;
                results.push({
                  kind: operation.kind,
                  status: 'created',
                  message: 'Dry run: would create relationship',
                });
              }

              break;
            }

            const endpoints = await this.graphQuery.getNodesByIds(ownerId, [fromEntityId, toEntityId]);
            if (endpoints.length !== 2) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: 'Both source and target entities must exist and be owned by the user',
              });
              failures += 1;
              break;
            }

            const relationshipId = await this.queueRelationshipWrite(ownerId, existingRel, {
              relationshipId: operation.relationshipId,
              fromEntityId,
              toEntityId,
              relationshipType,
              properties: operation.properties,
              strength: operation.strength,
              isBidirectional: operation.isBidirectional,
            });

            if (existingRel) {
              updatedRelationships += 1;
              results.push({
                kind: operation.kind,
                status: 'updated',
                message: `Updated existing relationship ${relationshipId}`,
                relationshipId,
              });
            } else {
              createdRelationships += 1;
              results.push({
                kind: operation.kind,
                status: 'created',
                message: `Created relationship ${relationshipId}`,
                relationshipId,
              });
            }

            break;
          }

          case 'relationship.update': {
            const relationships = await this.graphQuery.getRelationships(ownerId, {
              relationshipIds: [operation.relationshipId],
              includeInactive: true,
            });
            const existingRel = relationships[0];
            if (!existingRel) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: `Relationship ${operation.relationshipId} not found or not owned by user`,
                relationshipId: operation.relationshipId,
              });
              failures += 1;
              break;
            }

            // The update path reaches the same reactivating write as
            // relationship.create — createOrUpdateRelationship sets
            // is_active = true on its update branch regardless — so without
            // this check `update` is simply a second door onto a forgotten
            // relationship. entity.update needs no equivalent: its existence
            // read is active-only, so a soft-deleted node already fails above
            // as not found.
            //
            // The check stays here rather than moving down to where the write
            // happens (GraphEventListener → createOrUpdateRelationship): that
            // write is shared with the importers, which legitimately re-assert
            // edges, and refusing reactivation there would change what every
            // producer means by an upsert. This is a policy on agent writes,
            // and it is a check-then-act across the queue boundary either way.
            if (!existingRel.is_active) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: `Relationship ${operation.relationshipId} was forgotten and cannot be updated`,
                relationshipId: operation.relationshipId,
              });
              failures += 1;
              break;
            }

            let relationshipType: string | undefined;
            if (operation.relationshipType !== undefined) {
              const stored = storedRelationshipType(operation.relationshipType);
              if (!stored) {
                results.push({
                  kind: operation.kind,
                  status: 'failed',
                  message: unstorableTypeMessage(operation.relationshipType),
                  relationshipId: operation.relationshipId,
                });
                failures += 1;
                break;
              }

              relationshipType = stored;
            }

            // A retype moves the edge to another (from, to, type) coordinate,
            // and relationships_unique_directed_idx allows one active edge on
            // each: when another is already there the write fails after this
            // tool has answered, and the job dead-letters. The two are not
            // merged here — that would retire this edge, which is
            // memory.forget's to do, behind its own confirmation — so say
            // which edge is in the way and leave the choice to the caller.
            // The coordinate is matched as relationship.create matches it, so
            // a bidirectional edge the other way round counts when the
            // retyped edge is bidirectional too.
            const nextType = keepStoredSpelling(existingRel.relationship_type, relationshipType);
            if (nextType !== existingRel.relationship_type) {
              const occupant = await this.graphQuery.findActiveRelationship(ownerId, {
                fromEntityId: existingRel.from_entity_id,
                toEntityId: existingRel.to_entity_id,
                relationshipType: nextType,
                isBidirectional: operation.isBidirectional ?? existingRel.is_bidirectional,
              });

              if (occupant) {
                results.push({
                  kind: operation.kind,
                  status: 'failed',
                  message:
                    `Relationship ${existingRel.relationship_id} cannot become ${nextType}: relationship ` +
                    `${occupant.relationship_id} already is one between the same entities. Update ` +
                    `${occupant.relationship_id} instead, and forget ${existingRel.relationship_id} ` +
                    `(memory.forget) if the ${existingRel.relationship_type} relationship no longer holds.`,
                  relationshipId: operation.relationshipId,
                });
                failures += 1;
                break;
              }
            }

            if (dryRun) {
              results.push({
                kind: operation.kind,
                status: 'updated',
                message: 'Dry run: would update relationship',
                relationshipId: operation.relationshipId,
              });
              updatedRelationships += 1;
              break;
            }

            // As in entity.update: only what the caller set, merged at write
            // time. The endpoints are the stored ones — update never moves an edge.
            const { relationshipId } = await this.graphEvents.upsertRelationship(ownerId, {
              relationshipId: operation.relationshipId,
              fromEntityId: existingRel.from_entity_id,
              toEntityId: existingRel.to_entity_id,
              relationshipType: nextType,
              properties: operation.properties,
              mergeProperties: operation.mergeProperties !== false,
              removeProperties: operation.removeProperties,
              strength: operation.strength,
              isBidirectional: operation.isBidirectional,
            });

            updatedRelationships += 1;
            results.push({
              kind: operation.kind,
              status: 'updated',
              message: `Updated relationship ${relationshipId}`,
              relationshipId,
            });
            break;
          }
        }
      } catch (error) {
        failures += 1;
        results.push({
          kind: operation.kind,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      dryRun,
      results,
      createdNodes,
      updatedNodes,
      createdRelationships,
      updatedRelationships,
      failures,
    };
  }

  /**
   * The other entity already holding the linked key a node write would give an
   * entity. `existing` is the entity the write lands on, or `null` for a new
   * one: an entity that keeps its key collides with nothing. Only a key
   * `entities_linked_uniq` holds — one with a linked table and a linked id — can
   * collide, so the common write, carrying neither, is never looked up.
   */
  private async findLinkedKeyOccupant(
    ownerId: string,
    existing: GraphNodeEntity | null,
    key: LinkedKey,
  ): Promise<GraphNodeEntity | null> {
    if (key.linkedTable == null || key.linkedId == null) {
      return null;
    }

    const keepsItsKey =
      existing !== null &&
      existing.entity_type === key.entityType &&
      existing.linked_table === key.linkedTable &&
      existing.linked_id === key.linkedId;

    return keepsItsKey ? null : this.graphQuery.findLinkedKeyHolder(ownerId, key);
  }

  private async resolveEndpoint(
    ownerId: string,
    entityId: string | undefined,
    ref: { entityType?: string; name: string } | undefined,
    createdByName: Map<string, string>,
  ): Promise<string | undefined> {
    if (entityId) {
      const existing = await this.graphQuery.getNode(ownerId, entityId);
      if (existing) {
        return entityId;
      }
    }

    return this.resolveNamedRef(ownerId, ref, createdByName);
  }

  private async resolveNamedRef(
    ownerId: string,
    ref: { entityType?: string; name: string } | undefined,
    createdByName: Map<string, string>,
  ): Promise<string | undefined> {
    if (!ref?.name) {
      return undefined;
    }

    const trimmed = ref.name.trim().toLowerCase();
    const typed = ref.entityType?.trim().toLowerCase();
    const fromBatch =
      (typed ? createdByName.get(`${typed}::${trimmed}`) : undefined) ?? createdByName.get(trimmed);
    if (fromBatch) {
      return fromBatch;
    }

    const containsHits = await this.graphQuery.getNodes(ownerId, {
      ...(typed ? { entityType: ref.entityType } : {}),
      nameContains: ref.name.trim(),
      limit: 8,
    });
    const exactContains = containsHits.find((node) => node.name?.trim().toLowerCase() === trimmed);
    if (exactContains) {
      return exactContains.entity_id;
    }

    if (containsHits.length === 1) {
      return containsHits[0].entity_id;
    }

    const prefixHits = await this.graphQuery.searchNodesByPrefix(ownerId, ref.name.trim(), { limit: 8 });
    const typedHits = typed
      ? prefixHits.filter((node) => node.entity_type.trim().toLowerCase() === typed)
      : prefixHits;
    const exact = typedHits.find((node) => node.name?.trim().toLowerCase() === trimmed);

    return exact?.entity_id ?? typedHits[0]?.entity_id ?? containsHits[0]?.entity_id;
  }

  /**
   * Check the `relationships` an `entity.create` carries, and spell their types
   * the stored way, BEFORE the entity is queued: a bad edge then fails the
   * operation with nothing written. Checked after, the entity was already on its
   * way while the result said the operation failed — and a model retrying a
   * failed create without an `entityId` mints a second entity. `entityId` is the
   * id the create reuses, if any; a minted one cannot be a target yet.
   */
  private async prepareNestedRelationships(
    ownerId: string,
    entityId: string | undefined,
    relationships: NestedRelationship[],
  ): Promise<NestedRelationship[]> {
    const targets = await this.graphQuery.getNodesByIds(
      ownerId,
      relationships.map((rel) => rel.toEntityId),
    );
    const targetSet = new Set(targets.map((node) => node.entity_id));

    return relationships.map((relationship) => {
      if (!targetSet.has(relationship.toEntityId)) {
        throw new Error(
          `Cannot create relationship to ${relationship.toEntityId}; target entity is missing or not owned by user`,
        );
      }

      if (relationship.toEntityId === entityId) {
        throw new Error(`Cannot create a relationship from entity ${entityId} to itself`);
      }

      const relationshipType = storedRelationshipType(relationship.relationshipType);
      if (!relationshipType) {
        throw new Error(unstorableTypeMessage(relationship.relationshipType));
      }

      return { ...relationship, relationshipType };
    });
  }

  /**
   * Queue an `entity.create`'s relationships the way `relationship.create`
   * queues one: onto the edge already on the coordinate when there is one, with
   * only what the caller set. They used to go out as fresh inserts with the
   * defaults filled in, so restating an edge an importer had written
   * dead-lettered on `relationships_unique_directed_idx` — and had one landed on
   * it, `mergeProperties: false` over `{}` would have emptied its properties and
   * the defaults reset its strength and direction.
   */
  private async writeNestedRelationships(
    ownerId: string,
    fromEntityId: string,
    relationships: NestedRelationship[],
  ): Promise<{ created: number; updated: number }> {
    const counts = { created: 0, updated: 0 };

    for (const relationship of relationships) {
      const edge = { ...relationship, fromEntityId };
      const existing = await this.graphQuery.findActiveRelationship(ownerId, edge);
      await this.queueRelationshipWrite(ownerId, existing, edge);
      counts[existing ? 'updated' : 'created'] += 1;
    }

    return counts;
  }

  /**
   * Queue a relationship write, onto `existing` when the edge is already there —
   * addressed by that edge's own id, and keeping its stored orientation and type
   * spelling. Unset fields stay `undefined` so an existing edge keeps its stored
   * strength, direction and properties (a new edge still gets strength 1,
   * one-way, `{}` from the insert defaults), and properties merge rather than
   * replace. Returns the id the write is queued under.
   */
  private async queueRelationshipWrite(
    ownerId: string,
    existing: RelationshipEntity | null | undefined,
    write: {
      relationshipId?: string;
      fromEntityId: string;
      toEntityId: string;
      relationshipType: string;
      properties?: Record<string, unknown>;
      strength?: number;
      isBidirectional?: boolean;
    },
  ): Promise<string> {
    const { relationshipId } = await this.graphEvents.upsertRelationship(ownerId, {
      relationshipId: existing?.relationship_id ?? write.relationshipId,
      fromEntityId: existing?.from_entity_id ?? write.fromEntityId,
      toEntityId: existing?.to_entity_id ?? write.toEntityId,
      relationshipType: existing?.relationship_type ?? write.relationshipType,
      properties: write.properties,
      strength: write.strength,
      isBidirectional: write.isBidirectional,
      mergeProperties: true,
    });

    return relationshipId;
  }
}

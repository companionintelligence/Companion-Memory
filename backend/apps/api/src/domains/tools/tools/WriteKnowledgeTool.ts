import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  canonicalEntityType,
  GraphEventService,
  graphEntityKindOf,
  type GraphNodeEntity,
  GraphQueryService,
  isOwnerManagedPropertyKey,
  isOwnerSettingPropertyKey,
  isStorableEntityType,
  type RelationshipEntity,
  sameEntityType,
  UserContextService,
} from '@ci/domains/memory';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, IntentPrivacy, ToolExecutionContext } from '../core/types';

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
 * Relationship types compare case-insensitively: a model writing `knows` means
 * the stored `KNOWS`. They are NOT interchangeable in storage — importers key
 * edges on the exact type — so a case-only difference must never reach the
 * write as a retype. Entity types go through `sameEntityType`, which also reads
 * another name for the stored type (`contact` for a Person) as that type.
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
 * An entity type spelled the way `ci.entities` stores it, or `null` when no row
 * can hold it. A known graph type comes back in its own spelling: Qwen writes
 * `person` and `place`, which `valid_entity_type` refuses — the write failed
 * after this tool had answered, and the job dead-lettered — and a `PERSON` got
 * stored as a type PersonService, `entities_linked_uniq` and the importers all
 * read as another one. Any other type is the caller's to spell, so it goes out
 * as written, once the CHECK can hold it.
 */
function storedEntityType(requested: string): string | null {
  const spelled = canonicalEntityType(requested);

  return isStorableEntityType(spelled) ? spelled : null;
}

function unstorableEntityTypeMessage(requested: string): string {
  return (
    `Entity type "${requested}" cannot be stored: use letters only, starting with a capital letter ` +
    '(e.g. Restaurant)'
  );
}

/**
 * The owner-managed property keys (`OWNER_MANAGED_PROPERTY_KEYS`) an entity
 * write names, as a set or as a removal. The tool refuses such a write: the
 * owner's settings, the self claim and the merged identity lists each have a
 * writer of their own, and a free-form `properties` bag is how the autonomy
 * dial used to be switched off by a model asked to "remember" it.
 *
 * A brand-new entity (an `entity.create` without `entityId`) is refused only
 * the settings and the self claim. Its identity lists overwrite nothing, so
 * "remember Dana, dana@example.com" still records the address.
 */
function ownerManagedKeysIn(
  operation: { properties?: Record<string, unknown>; removeProperties?: string[] },
  { newEntity = false }: { newEntity?: boolean } = {},
): string[] {
  const named = [...Object.keys(operation.properties ?? {}), ...(operation.removeProperties ?? [])];
  const refused = newEntity ? isOwnerSettingPropertyKey : isOwnerManagedPropertyKey;

  return [...new Set(named.filter(refused))];
}

function ownerManagedKeysMessage(keys: string[]): string {
  const list = keys.map((key) => `"${key}"`).join(', ');

  return (
    `memory.remember cannot write or remove ${list}: Companion Memory keeps ${keys.length === 1 ? 'that key' : 'those keys'} ` +
    'itself (settings such as the autonomy dial, the account-holder flag, and contact identifiers that ' +
    'imports and merges maintain). Change settings in Settings, and store other facts under another key.'
  );
}

/** Whether `next` would overwrite a non-empty stored value with a different one. */
function overwritesText(stored: string | null | undefined, next: string | undefined): boolean {
  return next !== undefined && (stored ?? '').trim() !== '' && next.trim() !== (stored ?? '').trim();
}

/** A Person row that claims to be the account holder, the way `UserContextService` falls back to one. */
function claimsSelf(node: Pick<GraphNodeEntity, 'properties'>): boolean {
  const flag = (node.properties as Record<string, unknown> | null | undefined)?.is_self;

  return flag === true || flag === 'true';
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
    local: {
      description:
        'Save a fact. One operation per entity (kind entity.create with entityType and name) and one ' +
        'per link between them (kind relationship.create with relationshipType, from.name, to.name).',
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
                relationshipType: { type: 'string' },
                from: { type: 'object', properties: { name: { type: 'string' } } },
                to: { type: 'object', properties: { name: { type: 'string' } } },
              },
            },
          },
        },
        required: ['operations'],
        additionalProperties: false,
      },
    },
    domain: 'memory',
    title: 'Remember a fact',
    // The label of its mildest use, adding a fact. A call that replaces or erases stored data, or
    // writes to the owner's own entity, is labelled destructive by `privacyFor` below, and the
    // registry judges it by that instead.
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    // A local write is the offline-first case: record it on-device now, let sync carry it up. An
    // additive write is not destructive, so nothing is lost if the appliance later reconciles it.
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
    private readonly userContext: UserContextService,
  ) {
    super();
    this.logger.setContext(WriteKnowledgeTool.name);
  }

  protected validateInput(input: unknown): WriteKnowledgeInput {
    return WriteKnowledgeInputSchema.parse(coerceWriteKnowledgeInput(input));
  }

  /**
   * Destructive for a call that can lose what is stored, so a write key is refused it and the
   * autonomy dial asks before it runs (see `ToolHandle.privacyFor`). That is a call that:
   *
   * - replaces a property bag (`mergeProperties: false` with `properties`) or removes keys, on an
   *   entity or a relationship;
   * - overwrites an existing entity's non-empty name or description with a different one, or
   *   changes its type, through `entity.update` or an id-reuse `entity.create`;
   * - retypes a relationship;
   * - writes to the owner's own Person at all. That row also holds the owner's settings, so a
   *   model told to "remember" something about it asks first.
   *
   * Adding a fact, merging new keys, and setting a property that was not there stay plain writes.
   * Overwriting a single property value through a merge does too: it is how "Alex moved to Leeds"
   * is recorded, and asking every time would make the tool unusable. A dry run writes nothing.
   *
   * Reads happen here, before the write is queued, so a row another writer changes in between can
   * be judged on what it was. The keys the appliance owns are protected at write time regardless
   * (`GraphUtilityService.nextProperties`), which is what this check cannot be.
   */
  async privacyFor(context: RequestContext, input: unknown): Promise<IntentPrivacy | undefined> {
    let parsed: WriteKnowledgeInput;

    try {
      parsed = this.validateInput(input);
    } catch {
      // `execute` refuses the same input before it touches anything.
      return undefined;
    }

    if (parsed.dryRun || !context.userId) {
      return undefined;
    }

    return (await this.losesStoredData(context.userId, parsed.operations))
      ? { ...this.schema.privacy, destructive: true }
      : undefined;
  }

  private async losesStoredData(
    ownerId: string,
    operations: WriteKnowledgeInput['operations'],
  ): Promise<boolean> {
    let selfEntityId: string | null | undefined;
    const isSelf = async (node: GraphNodeEntity): Promise<boolean> => {
      if (claimsSelf(node)) {
        return true;
      }

      if (selfEntityId === undefined) {
        selfEntityId = (await this.userContext.getSelfIdentity(ownerId))?.entityId ?? null;
      }

      return node.entity_id === selfEntityId;
    };

    for (const operation of operations) {
      switch (operation.kind) {
        case 'entity.create': {
          if (!operation.entityId) {
            break;
          }

          const existing = await this.graphQuery.getNode(ownerId, operation.entityId);

          if (
            existing &&
            ((await isSelf(existing)) ||
              overwritesText(existing.name, operation.name) ||
              overwritesText(existing.description, operation.description))
          ) {
            return true;
          }

          break;
        }

        case 'entity.update': {
          if (
            operation.removeProperties?.length ||
            (operation.mergeProperties === false && operation.properties)
          ) {
            return true;
          }

          const existing = await this.graphQuery.getNode(ownerId, operation.entityId);

          if (
            existing &&
            ((await isSelf(existing)) ||
              overwritesText(existing.name, operation.name) ||
              overwritesText(existing.description, operation.description) ||
              (operation.entityType !== undefined &&
                !sameEntityType(existing.entity_type, operation.entityType)))
          ) {
            return true;
          }

          break;
        }

        case 'relationship.update': {
          if (
            operation.removeProperties?.length ||
            (operation.mergeProperties === false && operation.properties)
          ) {
            return true;
          }

          if (operation.relationshipType !== undefined) {
            const [edge] = await this.graphQuery.getRelationships(ownerId, {
              relationshipIds: [operation.relationshipId],
            });
            const requested =
              storedRelationshipType(operation.relationshipType) ?? operation.relationshipType;

            if (edge && !sameGraphType(edge.relationship_type, requested)) {
              return true;
            }
          }

          break;
        }

        case 'relationship.create':
          break;
      }
    }

    return false;
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
            // An entity.create without an id for a name the user already has a
            // person, place or concept by lands on that one. It used to mint a
            // second one: "Remember that Jordan Lee likes jazz" made another
            // Jordan Lee beside the existing one, and the fact went with it.
            const sameNamed = operation.entityId ? null : await this.findSameNamed(ownerId, operation);
            const ownerManagedCreate = ownerManagedKeysIn(operation, {
              newEntity: !operation.entityId && !sameNamed,
            });
            if (ownerManagedCreate.length > 0) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: ownerManagedKeysMessage(ownerManagedCreate),
                entityId: operation.entityId,
              });
              failures += 1;
              break;
            }

            const existing = operation.entityId
              ? await this.graphQuery.getNode(ownerId, operation.entityId, { includeInactive: true })
              : sameNamed;
            // A name match keeps the stored description: overwriting one is
            // what entity.update (with its approval) is for, and the model did
            // not name this row.
            const keptDescription =
              sameNamed != null &&
              operation.description !== undefined &&
              overwritesText(sameNamed.description, operation.description);

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
            // keeps the stored type — named in any case, or by another name for
            // it — and refuses a real change of type: a model that calls a
            // Person an Organization has most likely picked up the wrong id,
            // and its name and properties would land on that row. entity.update
            // stays the one explicit way to retype.
            if (existing && !sameEntityType(existing.entity_type, operation.entityType)) {
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

            const entityType = existing?.entity_type ?? storedEntityType(operation.entityType);
            if (!entityType) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: unstorableEntityTypeMessage(operation.entityType),
              });
              failures += 1;
              break;
            }

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
              rememberName(entityType, knownName, operation.entityId ?? sameNamed?.entity_id ?? 'dry-run');
              if (existing) {
                updatedNodes += 1;
                results.push({
                  kind: operation.kind,
                  status: 'updated',
                  message: `Dry run: would update existing entity ${existing.entity_id}${sameNamed ? ' (matched by name)' : ''}`,
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
              ? await this.prepareNestedRelationships(
                  ownerId,
                  operation.entityId ?? sameNamed?.entity_id,
                  operation.relationships,
                )
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
              entityId: operation.entityId ?? sameNamed?.entity_id,
              entityType,
              // Same name, so nothing to write; the stored spelling stays.
              name: sameNamed ? undefined : operation.name,
              description: keptDescription ? undefined : operation.description,
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
                message: sameNamed
                  ? `Updated the existing ${sameNamed.entity_type} "${sameNamed.name}" (${entityId}), matched by name` +
                    (keptDescription
                      ? '; its description was kept, so use entity.update with this entityId to change it'
                      : '')
                  : `Updated existing entity ${entityId}`,
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
            const ownerManagedUpdate = ownerManagedKeysIn(operation);
            if (ownerManagedUpdate.length > 0) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: ownerManagedKeysMessage(ownerManagedUpdate),
                entityId: operation.entityId,
              });
              failures += 1;
              break;
            }

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

            // A type that names the stored one in another case or by another
            // name (`person` or `contact` for a Person) is not a retype. A real
            // one is sent in its canonical spelling: `person` for a Concept
            // means Person, which is also the key the check below must look on.
            let entityType = existing.entity_type;
            if (
              operation.entityType !== undefined &&
              !sameEntityType(existing.entity_type, operation.entityType)
            ) {
              const stored = storedEntityType(operation.entityType);
              if (!stored) {
                results.push({
                  kind: operation.kind,
                  status: 'failed',
                  message: unstorableEntityTypeMessage(operation.entityType),
                  entityId: operation.entityId,
                });
                failures += 1;
                break;
              }

              entityType = stored;
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
      // That filter matches entity_type exactly, so it takes the stored
      // spelling: a model's `person` found no Person here.
      ...(typed && ref.entityType ? { entityType: canonicalEntityType(ref.entityType) } : {}),
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
  /**
   * The one active person, place or concept of this type that already carries
   * this name (ignoring case and surrounding space), for an `entity.create`
   * that names no entity. None when there are several (which one is meant is
   * not this tool's guess), when the create carries a linked key (an import's
   * coordinate says which row it is), for other entity types (two events or
   * notes may share a title), and for the account holder's own Person, whose
   * row has writers and protections of its own.
   */
  private async findSameNamed(
    ownerId: string,
    operation: { entityType: string; name?: string; linkedTable?: string; linkedId?: string },
  ): Promise<GraphNodeEntity | null> {
    const name = operation.name?.trim();
    const entityType = storedEntityType(operation.entityType);

    if (!name || !entityType || graphEntityKindOf(entityType) == null) {
      return null;
    }

    if (operation.linkedTable || operation.linkedId) {
      return null;
    }

    const candidates = await this.graphQuery.getNodes(ownerId, { entityType, nameContains: name, limit: 25 });
    const matches = candidates.filter(
      (node) => node.is_active && node.name?.trim().toLowerCase() === name.toLowerCase(),
    );

    if (matches.length !== 1 || claimsSelf(matches[0])) {
      return null;
    }

    const selfEntityId = (await this.userContext.getSelfIdentity(ownerId))?.entityId ?? null;

    return matches[0].entity_id === selfEntityId ? null : matches[0];
  }

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

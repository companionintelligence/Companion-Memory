import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { GraphEventService, GraphQueryService } from '@ci/domains/memory';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

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
        isBidirectional: z.boolean().optional(),
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
  mergeProperties: z.boolean().optional(),
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
  isBidirectional: z.boolean().optional(),
});

const RelationshipUpdateSchema = z.object({
  kind: z.literal('relationship.update'),
  relationshipId: z.string().uuid(),
  relationshipType: z.string().min(1).optional(),
  properties: z.record(z.unknown()).optional(),
  mergeProperties: z.boolean().optional(),
  removeProperties: z.array(z.string()).optional(),
  strength: z.number().min(0).max(1).optional(),
  isBidirectional: z.boolean().optional(),
});

const OperationSchema = z.discriminatedUnion('kind', [
  EntityCreateSchema,
  EntityUpdateSchema,
  RelationshipCreateSchema,
  RelationshipUpdateSchema,
]);

const WriteKnowledgeInputSchema = z.object({
  operations: z.array(OperationSchema).min(1),
  dryRun: z.boolean().optional(),
});

export type WriteKnowledgeInput = z.infer<typeof WriteKnowledgeInputSchema>;

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
            if (operation.entityId) {
              // A soft-deleted (forgotten) row still owns its id, so an id-reuse
              // create must not fall through to createOrUpdateNode's update
              // branch, which unconditionally flips is_active back to true.
              const existing = await this.graphQuery.getNode(ownerId, operation.entityId, {
                includeInactive: true,
              });

              if (existing && !existing.is_active) {
                results.push({
                  kind: operation.kind,
                  status: 'failed',
                  message: `Entity ${operation.entityId} was forgotten and cannot be recreated by id reuse`,
                  entityId: operation.entityId,
                });
                failures += 1;
                break;
              }
            }

            if (dryRun) {
              rememberName(operation.entityType, operation.name, operation.entityId ?? 'dry-run');
              results.push({
                kind: operation.kind,
                status: 'created',
                message: 'Dry run: would create entity',
              });
              createdNodes += 1;
              break;
            }

            const { entityId } = await this.graphEvents.upsertNode(ownerId, {
              entityId: operation.entityId,
              entityType: operation.entityType,
              name: operation.name ?? null,
              description: operation.description ?? null,
              properties: operation.properties ?? {},
              searchContent: operation.searchContent ?? null,
              linkedTable: operation.linkedTable ?? null,
              linkedId: operation.linkedId ?? null,
              mergeProperties: false,
            });

            if (operation.relationships?.length) {
              await this.handleRelationshipCreations(ownerId, entityId, operation.relationships, dryRun);
              createdRelationships += operation.relationships.length;
            }

            rememberName(operation.entityType, operation.name, entityId);
            createdNodes += 1;
            results.push({
              kind: operation.kind,
              status: 'created',
              message: `Created entity ${entityId}`,
              entityId,
            });
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

            const mergedProperties = this.mergeProperties(
              existing.properties ?? {},
              operation.properties ?? {},
              operation.mergeProperties !== false,
              operation.removeProperties ?? [],
            );

            const { entityId } = await this.graphEvents.upsertNode(ownerId, {
              entityId: operation.entityId,
              entityType: operation.entityType ?? existing.entity_type,
              name: operation.name ?? existing.name,
              description: operation.description ?? existing.description,
              properties: mergedProperties,
              searchContent: operation.searchContent ?? existing.search_content,
              linkedTable: operation.linkedTable ?? existing.linked_table,
              linkedId: operation.linkedId ?? existing.linked_id,
              mergeProperties: false,
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
            if (operation.relationshipId) {
              // Same id-reuse guard as entity.create, mirrored for relationships.
              const existingRels = await this.graphQuery.getRelationships(ownerId, {
                relationshipIds: [operation.relationshipId],
                includeInactive: true,
              });

              if (existingRels[0] && !existingRels[0].is_active) {
                results.push({
                  kind: operation.kind,
                  status: 'failed',
                  message: `Relationship ${operation.relationshipId} was forgotten and cannot be recreated by id reuse`,
                  relationshipId: operation.relationshipId,
                });
                failures += 1;
                break;
              }
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

            if (dryRun) {
              results.push({
                kind: operation.kind,
                status: 'created',
                message: 'Dry run: would create relationship',
              });
              createdRelationships += 1;
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

            const { relationshipId } = await this.graphEvents.upsertRelationship(ownerId, {
              relationshipId: operation.relationshipId,
              fromEntityId,
              toEntityId,
              relationshipType: operation.relationshipType,
              properties: operation.properties ?? {},
              strength: operation.strength ?? 1,
              isBidirectional: operation.isBidirectional ?? false,
              mergeProperties: false,
            });

            createdRelationships += 1;
            results.push({
              kind: operation.kind,
              status: 'created',
              message: `Created relationship ${relationshipId}`,
              relationshipId,
            });
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

            const mergedRelProperties = this.mergeProperties(
              existingRel.properties ?? {},
              operation.properties ?? {},
              operation.mergeProperties !== false,
              operation.removeProperties ?? [],
            );

            const { relationshipId } = await this.graphEvents.upsertRelationship(ownerId, {
              relationshipId: operation.relationshipId,
              fromEntityId: existingRel.from_entity_id,
              toEntityId: existingRel.to_entity_id,
              relationshipType: operation.relationshipType ?? existingRel.relationship_type,
              properties: mergedRelProperties,
              strength: operation.strength ?? existingRel.strength,
              isBidirectional: operation.isBidirectional ?? existingRel.is_bidirectional,
              mergeProperties: false,
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

  private mergeProperties(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
    merge: boolean,
    removeKeys: string[],
  ): Record<string, unknown> {
    const base = merge ? { ...existing, ...incoming } : { ...incoming };
    if (removeKeys.length) {
      for (const key of removeKeys) {
        delete base[key];
      }
    }

    return base;
  }

  private async handleRelationshipCreations(
    ownerId: string,
    fromEntityId: string,
    relationships: Array<{
      toEntityId: string;
      relationshipType: string;
      properties?: Record<string, unknown>;
      strength?: number;
      isBidirectional?: boolean;
    }>,
    dryRun: boolean,
  ): Promise<void> {
    if (relationships.length === 0 || dryRun) {
      return;
    }

    const targetIds = relationships.map((rel) => rel.toEntityId);
    const targets = await this.graphQuery.getNodesByIds(ownerId, targetIds);
    const targetSet = new Set(targets.map((node) => node.entity_id));

    for (const relationship of relationships) {
      if (!targetSet.has(relationship.toEntityId)) {
        throw new Error(
          `Cannot create relationship to ${relationship.toEntityId}; target entity is missing or not owned by user`,
        );
      }

      await this.graphEvents.upsertRelationship(ownerId, {
        fromEntityId,
        toEntityId: relationship.toEntityId,
        relationshipType: relationship.relationshipType,
        properties: relationship.properties ?? {},
        strength: relationship.strength ?? 1,
        isBidirectional: relationship.isBidirectional ?? false,
        mergeProperties: false,
      });
    }
  }
}

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GraphUtilityService } from '@ci/domains/memory';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

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

const RelationshipCreateSchema = z.object({
  kind: z.literal('relationship.create'),
  relationshipId: z.string().uuid().optional(),
  fromEntityId: z.string().uuid(),
  toEntityId: z.string().uuid(),
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
  readonly schema = {
    name: 'writeKnowledge',
    description: 'Create or update entities and relationships in the personal knowledge graph.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            description: 'Operation describing how to mutate entities or relationships.',
          },
          minItems: 1,
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

  constructor(private readonly graphUtility: GraphUtilityService) {
    super();
  }

  protected validateInput(input: unknown): WriteKnowledgeInput {
    return WriteKnowledgeInputSchema.parse(input);
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

    for (const operation of input.operations) {
      try {
        switch (operation.kind) {
          case 'entity.create': {
            if (dryRun) {
              results.push({
                kind: operation.kind,
                status: 'created',
                message: 'Dry run: would create entity',
              });
              createdNodes += 1;
              break;
            }

            const { node } = await this.graphUtility.createOrUpdateNode(ownerId, {
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
              await this.handleRelationshipCreations(
                ownerId,
                node.entity_id,
                operation.relationships,
                dryRun,
              );
              createdRelationships += operation.relationships.length;
            }

            createdNodes += 1;
            results.push({
              kind: operation.kind,
              status: 'created',
              message: `Created entity ${node.entity_id}`,
              entityId: node.entity_id,
            });
            break;
          }

          case 'entity.update': {
            const existing = await this.graphUtility.getNodeById(operation.entityId, ownerId);
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

            const { node } = await this.graphUtility.createOrUpdateNode(ownerId, {
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
              message: `Updated entity ${node.entity_id}`,
              entityId: node.entity_id,
            });
            break;
          }

          case 'relationship.create': {
            if (dryRun) {
              results.push({
                kind: operation.kind,
                status: 'created',
                message: 'Dry run: would create relationship',
              });
              createdRelationships += 1;
              break;
            }

            const endpoints = await this.graphUtility.getNodesByIds(
              [operation.fromEntityId, operation.toEntityId],
              ownerId,
            );
            if (endpoints.length !== 2) {
              results.push({
                kind: operation.kind,
                status: 'failed',
                message: 'Both source and target entities must exist and be owned by the user',
              });
              failures += 1;
              break;
            }

            const { relationship } = await this.graphUtility.createOrUpdateRelationship(ownerId, {
              relationshipId: operation.relationshipId,
              fromEntityId: operation.fromEntityId,
              toEntityId: operation.toEntityId,
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
              message: `Created relationship ${relationship.relationship_id}`,
              relationshipId: relationship.relationship_id,
            });
            break;
          }

          case 'relationship.update': {
            const relationships = await this.graphUtility.getRelationships(ownerId, {
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

            const { relationship } = await this.graphUtility.createOrUpdateRelationship(ownerId, {
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
              message: `Updated relationship ${relationship.relationship_id}`,
              relationshipId: relationship.relationship_id,
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
    const targets = await this.graphUtility.getNodesByIds(targetIds, ownerId);
    const targetSet = new Set(targets.map((node) => node.entity_id));

    for (const relationship of relationships) {
      if (!targetSet.has(relationship.toEntityId)) {
        throw new Error(
          `Cannot create relationship to ${relationship.toEntityId}; target entity is missing or not owned by user`,
        );
      }

      await this.graphUtility.createOrUpdateRelationship(ownerId, {
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

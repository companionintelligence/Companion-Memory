import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GraphUtilityService, GraphNodeEntity, RelationshipEntity } from '@ci/domains/graph';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

const ForgetKnowledgeInputBaseSchema = z.object({
  entityIds: z.array(z.string().uuid()).optional(),
  relationshipIds: z.array(z.string().uuid()).optional(),
  mode: z.enum(['archive', 'archive_and_delete']).default('archive'),
  reason: z.string().min(1).optional(),
});

const ForgetKnowledgeInputSchema = ForgetKnowledgeInputBaseSchema.refine(
  (value) => value.entityIds?.length || value.relationshipIds?.length,
  {
    message: 'Provide entityIds and/or relationshipIds to forget',
  },
);

export type ForgetKnowledgeInput = z.infer<typeof ForgetKnowledgeInputSchema>;

export interface ForgetKnowledgeOutput {
  archivedEntityIds: string[];
  archivedRelationshipIds: string[];
  entityFactIds: string[];
  relationshipFactIds: string[];
  mode: 'archive' | 'archive_and_delete';
  warnings?: string[];
}

@Injectable()
export class ForgetKnowledgeTool extends BaseTool<ForgetKnowledgeInput, ForgetKnowledgeOutput> {
  readonly schema = {
    name: 'forgetKnowledge',
    description: 'Archive or remove entities and relationships from the knowledge graph.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        entityIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Entity identifiers to archive or delete.',
        },
        relationshipIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Relationship identifiers to archive or delete.',
        },
        mode: {
          type: 'string',
          enum: ['archive', 'archive_and_delete'],
          default: 'archive',
          description:
            'Archive keeps data available in the facts table while leaving nodes inactive; archive_and_delete also removes from the active graph.',
        },
        reason: {
          type: 'string',
          description: 'Optional description for why the knowledge was forgotten.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    examples: [
      {
        input: {
          entityIds: ['11111111-1111-1111-1111-111111111111'],
          mode: 'archive',
        },
        output: {
          archivedEntityIds: ['11111111-1111-1111-1111-111111111111'],
          archivedRelationshipIds: [],
          entityFactIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
          relationshipFactIds: [],
          mode: 'archive',
        },
        description: 'Archive an entity and its outgoing relationships into the facts table',
      },
    ],
  };

  constructor(private readonly graphUtility: GraphUtilityService) {
    super();
  }

  protected validateInput(input: unknown): ForgetKnowledgeInput {
    return ForgetKnowledgeInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: ForgetKnowledgeInput,
  ): Promise<ForgetKnowledgeOutput> {
    if (!context.userId) {
      throw new Error('User context is required to forget knowledge');
    }

    const ownerId = context.userId;
    const mode = input.mode ?? 'archive';
    const reason = input.reason ?? 'forgetKnowledge.tool';

    const entityIds = Array.from(new Set(input.entityIds ?? []));
    const relationshipIds = Array.from(new Set(input.relationshipIds ?? []));

    const warnings: string[] = [];

    const entitySnapshots = [] as Array<{
      node: GraphNodeEntity;
      relationships: RelationshipEntity[];
    }>;

    const relationshipIdsToDisable = new Set<string>();

    for (const entityId of entityIds) {
      const snapshot = await this.graphUtility.collectEntitySnapshot(entityId, ownerId, {
        includeRelationships: true,
      });

      if (!snapshot.node) {
        warnings.push(`Entity ${entityId} not found or not owned by user`);
        continue;
      }

      snapshot.relationships.forEach((rel) => relationshipIdsToDisable.add(rel.relationship_id));
      entitySnapshots.push({
        node: snapshot.node,
        relationships: snapshot.relationships,
      });
    }

    const uniqueEntitySnapshots = entitySnapshots;

    const entityFactIds = uniqueEntitySnapshots.length
      ? await this.graphUtility.archiveEntities(
          ownerId,
          uniqueEntitySnapshots.map((entry) => ({
            node: entry.node,
            relationships: entry.relationships,
            reason,
          })),
        )
      : [];

    const explicitRelationships = relationshipIds.length
      ? await this.graphUtility.getRelationships(ownerId, {
          relationshipIds,
          includeInactive: true,
        })
      : [];

    explicitRelationships.forEach((rel) => relationshipIdsToDisable.add(rel.relationship_id));

    const relationshipFactIds = explicitRelationships.length
      ? await this.graphUtility.archiveRelationships(ownerId, explicitRelationships, reason)
      : [];

    // Deactivate or delete entities and relationships according to mode
    const hardDelete = mode === 'archive_and_delete';

    if (uniqueEntitySnapshots.length) {
      await this.graphUtility.deactivateEntities(
        uniqueEntitySnapshots.map((entry) => entry.node.entity_id),
        ownerId,
        hardDelete,
      );
    }

    if (relationshipIdsToDisable.size > 0) {
      await this.graphUtility.deactivateRelationships(
        Array.from(relationshipIdsToDisable),
        ownerId,
        hardDelete,
      );
    }

    return {
      archivedEntityIds: uniqueEntitySnapshots.map((entry) => entry.node.entity_id),
      archivedRelationshipIds: Array.from(new Set(explicitRelationships.map((rel) => rel.relationship_id))),
      entityFactIds,
      relationshipFactIds,
      mode,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}

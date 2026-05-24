/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { GraphQueryService, GraphReadService, GraphNodeEntity } from '@ci/domains/memory';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

// Input schema for the tool
const getUserPreferencesInputSchema = z.object({
  category: z
    .enum(['food', 'entertainment', 'activity', 'beverage', 'music', 'all'])
    .optional()
    .default('all'),
  personName: z.string().optional(),
  includeContext: z.boolean().default(true),
});

type GetUserPreferencesInput = z.infer<typeof getUserPreferencesInputSchema>;

// Output interfaces
interface PreferenceNode {
  id: string;
  type: string;
  name: string;
  strength: number;
  relationship: 'PREFERS' | 'DISLIKES';
  properties?: Record<string, any>;
}

interface GetUserPreferencesOutput {
  preferences: PreferenceNode[];
  dislikes: PreferenceNode[];
  totalPreferences: number;
  totalDislikes: number;
  personId: string;
  personName: string;
  debugInfo?: DebugInfo;
}

interface DebugInfo {
  userId: string;
  entityLookupMethod: string;
  queryInfo: string;
}

const CATEGORY_TYPE_MAP: Record<string, string[]> = {
  food: ['food', 'cuisine', 'dietary_preference', 'food_category'],
  entertainment: ['movie_genre', 'tv_genre', 'book_genre'],
  activity: ['activity', 'sport', 'hobby'],
  beverage: ['beverage', 'drink'],
  music: ['music_genre', 'music_style'],
};

const RELATIONSHIP_DESCRIPTOR_PATTERNS: Array<{
  keywords: string[];
  relationshipTypes: string[];
}> = [
  {
    keywords: ['wife', 'husband', 'spouse', 'partner', 'significant other'],
    relationshipTypes: ['SPOUSE', 'PARTNER', 'ROMANTIC_PARTNER'],
  },
  {
    keywords: ['mother', 'mom', 'father', 'dad', 'parent'],
    relationshipTypes: ['PARENT_OF', 'CHILD_OF'],
  },
  {
    keywords: ['son', 'daughter', 'child', 'kid', 'children', 'kids'],
    relationshipTypes: ['PARENT_OF', 'CHILD_OF'],
  },
  { keywords: ['brother', 'sister', 'sibling'], relationshipTypes: ['SIBLING_OF'] },
];

/**
 * Tool to retrieve user preferences from the graph database
 * Uses the event-driven graph domain for reads via GraphQueryService
 */
@Injectable()
export class GetUserPreferencesTool extends BaseTool<GetUserPreferencesInput, GetUserPreferencesOutput> {
  readonly schema = {
    name: 'getUserPreferences',
    description:
      'Get user preferences including likes and dislikes for food, entertainment, activities, music, and beverages. ' +
      'Can query preferences for the current user or family members (e.g., "my wife", "John"). ' +
      'Returns detailed information about each preference including strength and rich context.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['food', 'entertainment', 'activity', 'beverage', 'music', 'all'],
          description: 'Filter preferences by category (default: all)',
          default: 'all',
        },
        personName: {
          type: 'string',
          description:
            'Name of the person to get preferences for (e.g., "my wife", "Sarah", "John Smith"). If not provided, returns current user preferences.',
        },
        includeContext: {
          type: 'boolean',
          description:
            'Include detailed properties about each preference (cuisine style, movie themes, etc.)',
          default: true,
        },
      },
      required: [],
    },
    examples: [
      {
        input: { category: 'food' },
        output: {
          preferences: [
            {
              id: 'uuid-123',
              type: 'cuisine',
              name: 'Italian',
              strength: 0.9,
              relationship: 'PREFERS',
              properties: {
                description: 'Mediterranean cuisine from Italy',
                signature_dishes: ['pasta', 'pizza', 'risotto'],
                regional_styles: ['Northern Italian', 'Southern Italian'],
              },
            },
          ],
          dislikes: [
            {
              id: 'uuid-456',
              type: 'food',
              name: 'Seafood',
              strength: 0.7,
              relationship: 'DISLIKES',
              properties: {
                category: 'protein',
                description: 'Fish and shellfish',
              },
            },
          ],
          totalPreferences: 1,
          totalDislikes: 1,
          personId: 'user-uuid',
          personName: 'Current User',
        },
        description: 'Get food preferences including likes and dislikes with rich context',
      },
    ],
  };

  constructor(
    private readonly graphQuery: GraphQueryService,
    private readonly graphRead: GraphReadService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(GetUserPreferencesTool.name);
  }

  protected validateInput(input: unknown): GetUserPreferencesInput {
    return getUserPreferencesInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: GetUserPreferencesInput,
  ): Promise<GetUserPreferencesOutput> {
    if (!context.userId) {
      throw new Error('User context is required to load preferences');
    }

    const ownerUserId = context.userId;
    const debugInfo: DebugInfo = {
      userId: ownerUserId,
      entityLookupMethod: '',
      queryInfo: '',
    };

    const userNode = await this.resolveUserEntity(ownerUserId);
    if (!userNode) {
      debugInfo.queryInfo = 'User entity not found in graph';

      return {
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: '',
        personName: 'User not found',
        debugInfo,
      };
    }

    let targetPersonId = userNode.entityId;
    let targetPersonName = userNode.name ?? 'Current User';
    debugInfo.entityLookupMethod = 'current user entity';

    if (input.personName) {
      debugInfo.entityLookupMethod = 'personName resolution';
      const resolved = await this.resolvePersonEntity(ownerUserId, targetPersonId, input.personName);

      if (!resolved) {
        debugInfo.queryInfo = `Person '${input.personName}' not found in graph relationships`;

        return {
          preferences: [],
          dislikes: [],
          totalPreferences: 0,
          totalDislikes: 0,
          personId: '',
          personName: `${input.personName} (not found)`,
          debugInfo,
        };
      }

      targetPersonId = resolved.entityId;
      targetPersonName = resolved.name ?? input.personName;
    }

    const relationshipSummaries = await this.graphRead.getPreferences(ownerUserId, {
      personEntityId: targetPersonId,
    });

    if (relationshipSummaries.length === 0) {
      debugInfo.queryInfo = 'No PREFERS or DISLIKES relationships found for this entity';

      return {
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: targetPersonId,
        personName: targetPersonName,
        debugInfo,
      };
    }

    const allowedTypes = this.buildCategoryTypeSet(input.category);
    const includeContext = input.includeContext;

    const preferences: PreferenceNode[] = [];
    const dislikes: PreferenceNode[] = [];

    for (const summary of relationshipSummaries) {
      const normalizedType = summary.type.toLowerCase();
      if (allowedTypes && !allowedTypes.has(normalizedType)) {
        continue;
      }

      const payload: PreferenceNode = {
        id: summary.entityId,
        type: normalizedType,
        name: summary.name ?? normalizedType,
        strength: summary.strength,
        relationship: summary.relationship,
        properties: includeContext ? (summary.properties ?? undefined) : undefined,
      };

      if (payload.relationship === 'PREFERS') {
        preferences.push(payload);
      } else {
        dislikes.push(payload);
      }
    }

    preferences.sort((a, b) => b.strength - a.strength);
    dislikes.sort((a, b) => b.strength - a.strength);

    debugInfo.queryInfo = `Found ${preferences.length} preferences and ${dislikes.length} dislikes`;

    return {
      preferences,
      dislikes,
      totalPreferences: preferences.length,
      totalDislikes: dislikes.length,
      personId: targetPersonId,
      personName: targetPersonName,
      debugInfo,
    };
  }

  private buildCategoryTypeSet(category: string): Set<string> | null {
    if (!category || category === 'all') {
      return null;
    }

    const types = CATEGORY_TYPE_MAP[category];
    if (!types || types.length === 0) {
      return null;
    }

    return new Set(types.map((type) => type.toLowerCase()));
  }

  private async resolveUserEntity(ownerUserId: string): Promise<{ entityId: string; name?: string } | null> {
    const node = await this.graphQuery.getUserEntity(ownerUserId);
    if (!node) {
      return null;
    }

    return {
      entityId: node.entity_id,
      name: node.name ?? undefined,
    };
  }

  private async resolvePersonEntity(
    ownerUserId: string,
    userEntityId: string,
    personName: string,
  ): Promise<{ entityId: string; name?: string } | null> {
    const lowerName = personName.toLowerCase().trim();

    for (const { keywords, relationshipTypes } of RELATIONSHIP_DESCRIPTOR_PATTERNS) {
      if (keywords.some((keyword) => lowerName.includes(keyword))) {
        const candidate = await this.findRelatedEntityByRelationships(
          ownerUserId,
          userEntityId,
          relationshipTypes,
        );
        if (candidate) {
          return candidate;
        }
      }
    }

    return this.findRelatedEntityByName(ownerUserId, userEntityId, lowerName);
  }

  private async findRelatedEntityByRelationships(
    ownerUserId: string,
    userEntityId: string,
    relationshipTypes: string[],
  ): Promise<{ entityId: string; name?: string } | null> {
    if (relationshipTypes.length === 0) {
      return null;
    }

    const relationships = await this.graphQuery.getRelationships(ownerUserId, {
      entityIds: [userEntityId],
      relationshipTypes,
      direction: 'both',
    });

    if (relationships.length === 0) {
      return null;
    }

    relationships.sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));

    const otherIds = Array.from(
      new Set(
        relationships.map((rel) =>
          rel.from_entity_id === userEntityId ? rel.to_entity_id : rel.from_entity_id,
        ),
      ),
    );

    if (otherIds.length === 0) {
      return null;
    }

    const nodes = await this.graphQuery.getNodesByIds(ownerUserId, otherIds);
    const person = nodes.find((node) => node.entity_type === 'Person');

    if (!person) {
      return null;
    }

    return {
      entityId: person.entity_id,
      name: person.name ?? undefined,
    };
  }

  private async findRelatedEntityByName(
    ownerUserId: string,
    userEntityId: string,
    lowerName: string,
  ): Promise<{ entityId: string; name?: string } | null> {
    if (!lowerName) {
      return null;
    }

    const traversal = await this.graphQuery.traverseGraph(ownerUserId, [userEntityId], {
      relationshipTypes: [
        'SPOUSE',
        'PARTNER',
        'ROMANTIC_PARTNER',
        'PARENT_OF',
        'CHILD_OF',
        'SIBLING_OF',
        'FAMILY_MEMBER',
        'FRIEND',
        'KNOWS',
      ],
      direction: 'both',
      maxDepth: 1,
      maxNodes: 50,
      maxEdges: 100,
    });

    const candidates = Array.from(traversal.nodes.values()).filter(
      (node) => node.entity_id !== userEntityId && node.entity_type === 'Person',
    );

    const exactMatch = candidates.find((node) => node.name?.toLowerCase() === lowerName);
    if (exactMatch) {
      return {
        entityId: exactMatch.entity_id,
        name: exactMatch.name ?? undefined,
      };
    }

    const partialMatch = candidates.find(
      (node) =>
        (node.name ?? '').toLowerCase().includes(lowerName) ||
        this.extractNameFromProperties(node).some((value) => value.includes(lowerName)),
    );

    if (partialMatch) {
      return {
        entityId: partialMatch.entity_id,
        name: partialMatch.name ?? undefined,
      };
    }

    const fallbackNodes = await this.graphQuery.getNodes(ownerUserId, {
      entityType: 'Person',
      nameContains: lowerName,
      limit: 5,
    });

    if (fallbackNodes.length === 0) {
      return null;
    }

    const bestMatch =
      fallbackNodes.find((node) => node.name?.toLowerCase() === lowerName) ?? fallbackNodes[0];

    return {
      entityId: bestMatch.entity_id,
      name: bestMatch.name ?? undefined,
    };
  }

  private extractNameFromProperties(node: GraphNodeEntity): string[] {
    const output: string[] = [];

    const first = node.properties?.first_name;
    const last = node.properties?.last_name;

    if (typeof first === 'string' && first.trim()) {
      output.push(first.toLowerCase());
    }

    if (typeof last === 'string' && last.trim()) {
      output.push(last.toLowerCase());
    }

    return output;
  }

  protected sanitizeInputForLogging(input: unknown): any {
    return input;
  }
}

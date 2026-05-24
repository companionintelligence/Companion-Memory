/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { GraphNodeEntity, GraphQueryService, GraphReadService } from '@ci/domains/memory';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

// Input schema for the tool
const getEntertainmentPreferencesInputSchema = z.object({
  mediaType: z.enum(['movies', 'tv', 'music', 'books', 'all']).optional().default('all'),
  personName: z.string().optional(),
  includeContext: z.boolean().default(true),
});

type GetEntertainmentPreferencesInput = z.infer<typeof getEntertainmentPreferencesInputSchema>;

// Output interface
interface EntertainmentPreference {
  id: string;
  type: string; // movie_genre, music_genre, book_genre, etc.
  name: string;
  strength: number;
  relationship: 'PREFERS' | 'DISLIKES';
  properties?: Record<string, any>;
}

interface GetEntertainmentPreferencesOutput {
  preferences: EntertainmentPreference[];
  dislikes: EntertainmentPreference[];
  totalPreferences: number;
  totalDislikes: number;
  personId: string;
  personName: string;
}

const MEDIA_TYPE_MAP: Record<string, string[]> = {
  movies: ['movie_genre', 'film_style'],
  tv: ['tv_genre', 'tv_style'],
  music: ['music_genre', 'music_style'],
  books: ['book_genre', 'literary_genre'],
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
  { keywords: ['friend', 'best friend', 'buddy'], relationshipTypes: ['FRIEND', 'KNOWS'] },
  {
    keywords: ['colleague', 'coworker', 'boss', 'manager'],
    relationshipTypes: ['WORKS_WITH', 'COLLEAGUE'],
  },
];

/**
 * Tool to retrieve entertainment preferences from the graph
 * Focuses on movies, TV, music, and books for recommendation systems
 */
@Injectable()
export class GetEntertainmentPreferencesTool extends BaseTool<
  GetEntertainmentPreferencesInput,
  GetEntertainmentPreferencesOutput
> {
  readonly schema = {
    name: 'getEntertainmentPreferences',
    description:
      'Get entertainment preferences including movie genres, TV preferences, music tastes, and book interests. ' +
      'Returns both likes and dislikes with detailed context. ' +
      'Can query for current user or family members (e.g., "my wife").',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        mediaType: {
          type: 'string',
          enum: ['movies', 'tv', 'music', 'books', 'all'],
          description: 'Filter by media type (default: all)',
          default: 'all',
        },
        personName: {
          type: 'string',
          description:
            'Name of person to get preferences for (e.g., "my wife", "John"). Defaults to current user.',
        },
        includeContext: {
          type: 'boolean',
          description: 'Include detailed properties (themes, sub-genres, example works)',
          default: true,
        },
      },
      required: [],
    },
    examples: [
      {
        input: { mediaType: 'movies' },
        output: {
          preferences: [
            {
              id: 'uuid-123',
              type: 'movie_genre',
              name: 'Science Fiction',
              strength: 0.9,
              relationship: 'PREFERS',
              properties: {
                description: 'Speculative fiction based on scientific concepts',
                themes: ['space exploration', 'time travel', 'artificial intelligence'],
                example_films: ['Blade Runner', 'The Matrix', 'Interstellar'],
              },
            },
          ],
          dislikes: [
            {
              id: 'uuid-456',
              type: 'movie_genre',
              name: 'Horror',
              strength: 0.8,
              relationship: 'DISLIKES',
              properties: {
                description: 'Movies designed to elicit fear and suspense',
                sub_genres: ['psychological', 'supernatural', 'slasher'],
              },
            },
          ],
          totalPreferences: 1,
          totalDislikes: 1,
          personId: 'user-uuid',
          personName: 'Current User',
        },
        description: 'Get movie preferences with detailed context for recommendations',
      },
    ],
  };

  constructor(
    private readonly graphQuery: GraphQueryService,
    private readonly graphRead: GraphReadService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(GetEntertainmentPreferencesTool.name);
  }

  protected validateInput(input: unknown): GetEntertainmentPreferencesInput {
    return getEntertainmentPreferencesInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: GetEntertainmentPreferencesInput,
  ): Promise<GetEntertainmentPreferencesOutput> {
    if (!context.userId) {
      throw new Error('User context is required to load entertainment preferences');
    }

    const ownerUserId = context.userId;
    const userProfile = await this.resolveUserProfile(ownerUserId);

    if (!userProfile?.entityId) {
      return {
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: '',
        personName: 'User not found',
      };
    }

    let targetPersonId = userProfile.entityId;
    let targetPersonName = userProfile.username ?? 'Current User';

    if (input.personName) {
      const resolved = await this.resolvePersonEntity(ownerUserId, targetPersonId, input.personName);

      if (!resolved) {
        return {
          preferences: [],
          dislikes: [],
          totalPreferences: 0,
          totalDislikes: 0,
          personId: '',
          personName: `${input.personName} (not found)`,
        };
      }

      targetPersonId = resolved.entityId;
      targetPersonName = resolved.name ?? input.personName;
    }

    const relationshipSummaries = await this.graphRead.getPreferences(ownerUserId, {
      personEntityId: targetPersonId,
    });

    if (relationshipSummaries.length === 0) {
      return {
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: targetPersonId,
        personName: targetPersonName,
      };
    }

    const mediaFilter = this.buildMediaTypeSet(input.mediaType);

    const includeContext = input.includeContext;
    const preferences: EntertainmentPreference[] = [];
    const dislikes: EntertainmentPreference[] = [];

    for (const summary of relationshipSummaries) {
      const conceptType = summary.type.toLowerCase();
      if (mediaFilter && !mediaFilter.has(conceptType)) {
        continue;
      }

      const item: EntertainmentPreference = {
        id: summary.entityId,
        type: conceptType,
        name: summary.name ?? conceptType,
        strength: summary.strength,
        relationship: summary.relationship,
        properties: includeContext ? (summary.properties ?? undefined) : undefined,
      };

      if (item.relationship === 'PREFERS') {
        preferences.push(item);
      } else {
        dislikes.push(item);
      }
    }

    preferences.sort((a, b) => b.strength - a.strength);
    dislikes.sort((a, b) => b.strength - a.strength);

    return {
      preferences,
      dislikes,
      totalPreferences: preferences.length,
      totalDislikes: dislikes.length,
      personId: targetPersonId,
      personName: targetPersonName,
    };
  }

  private async resolveUserProfile(
    ownerUserId: string,
  ): Promise<{ entityId: string | null; username: string | null }> {
    const node = await this.graphQuery.getUserEntity(ownerUserId);
    if (!node) {
      return {
        entityId: null,
        username: null,
      };
    }

    return {
      entityId: node.entity_id,
      username: node.name ?? null,
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
        'WORKS_WITH',
        'COLLEAGUE',
      ],
      direction: 'both',
      maxDepth: 1,
      maxNodes: 75,
      maxEdges: 150,
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
        this.extractNameFragments(node).some((value) => value.includes(lowerName)),
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

  private buildMediaTypeSet(mediaType: string): Set<string> | null {
    if (!mediaType || mediaType === 'all') {
      return new Set(
        Object.values(MEDIA_TYPE_MAP)
          .flat()
          .map((type) => type.toLowerCase()),
      );
    }

    const types = MEDIA_TYPE_MAP[mediaType];
    if (!types || types.length === 0) {
      return null;
    }

    return new Set(types.map((type) => type.toLowerCase()));
  }

  private extractNameFragments(node: GraphNodeEntity): string[] {
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

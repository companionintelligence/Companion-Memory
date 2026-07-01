/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { GraphQueryService, GraphReadService } from '@ci/domains/memory';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const FAMILY_RELATIONSHIP_TYPES = [
  'SPOUSE',
  'PARTNER',
  'ROMANTIC_PARTNER',
  'PARENT_OF',
  'CHILD_OF',
  'SIBLING_OF',
  'FAMILY_MEMBER',
];

// Input schema
const getFamilyMembersInputSchema = z.object({
  relationshipType: z.enum(['family', 'romantic_partner', 'all']).optional().default('all'),
  includePreferences: z.boolean().default(false),
});

type GetFamilyMembersInput = z.infer<typeof getFamilyMembersInputSchema>;

// Output interfaces
interface FamilyMember {
  id: string;
  name: string;
  relationshipType: string;
  relationshipSubtype?: string;
  closenessScore: number;
  interactionFrequency: string;
  preferences?: {
    likes: string[];
    dislikes: string[];
  };
}

interface GetFamilyMembersOutput {
  familyMembers: FamilyMember[];
  totalCount: number;
  userId: string;
}

@Injectable()
export class GetFamilyMembersTool extends BaseTool<GetFamilyMembersInput, GetFamilyMembersOutput> {
  readonly schema: IntentDefinition = {
    name: 'people.relationships',
    domain: 'people',
    title: 'List relationships',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    produces: ['person'],
    phrases: ['Who is my family', 'List my relationships'],
    description:
      'Get information about family members, friends, and social connections. ' +
      'Returns relationship details including closeness scores and interaction frequency. ' +
      'Can optionally include their preferences (likes/dislikes) for planning activities.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        relationshipType: {
          type: 'string',
          enum: ['family', 'romantic_partner', 'all'],
          description: 'Filter by relationship subtype (default: all family relationships)',
          default: 'all',
        },
        includePreferences: {
          type: 'boolean',
          description: 'Whether to include likes and dislikes for each person',
          default: false,
        },
      },
      required: [],
    },
    examples: [
      {
        input: { relationshipType: 'family', includePreferences: true },
        output: {
          familyMembers: [
            {
              id: 'uuid',
              name: 'Sarah Smith',
              relationshipType: 'family',
              relationshipSubtype: 'spouse',
              closenessScore: 1.0,
              interactionFrequency: 'daily',
              preferences: {
                likes: ['Italian cuisine', 'Hiking', 'Jazz music'],
                dislikes: ['Horror movies', 'Seafood'],
              },
            },
          ],
          totalCount: 1,
          userId: 'user-uuid',
        },
        description: 'Get family members with their preferences',
      },
    ],
  };

  constructor(
    private readonly graphQuery: GraphQueryService,
    private readonly graphRead: GraphReadService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(GetFamilyMembersTool.name);
  }

  protected validateInput(input: unknown): GetFamilyMembersInput {
    return getFamilyMembersInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: GetFamilyMembersInput,
  ): Promise<GetFamilyMembersOutput> {
    if (!context.userId) {
      throw new Error('User context is required to load family members');
    }

    const ownerUserId = context.userId;
    const userProfile = await this.resolveUserProfile(ownerUserId);

    if (!userProfile?.entityId) {
      return {
        familyMembers: [],
        totalCount: 0,
        userId: ownerUserId,
      };
    }

    const relationshipTypes = this.mapRelationshipFilter(input.relationshipType);
    const effectiveRelationshipTypes =
      relationshipTypes.length > 0 ? relationshipTypes : FAMILY_RELATIONSHIP_TYPES;

    const familySummaries = await this.graphRead.getFamilyMembers(ownerUserId, {
      relationshipTypes: effectiveRelationshipTypes,
      personEntityId: userProfile.entityId ?? undefined,
    });

    if (familySummaries.length === 0) {
      return {
        familyMembers: [],
        totalCount: 0,
        userId: ownerUserId,
      };
    }

    const familyMembers: FamilyMember[] = familySummaries.map((summary) => ({
      id: summary.entityId,
      name: summary.name ?? this.extractDisplayName(summary.properties),
      relationshipType: summary.relationshipType,
      relationshipSubtype: undefined,
      closenessScore: summary.strength ?? 0.5,
      interactionFrequency:
        (summary.properties?.interaction_frequency as string | undefined) ??
        (summary.properties?.frequency as string | undefined) ??
        'unknown',
    }));

    if (input.includePreferences) {
      await Promise.all(
        familyMembers.map(async (member) => {
          member.preferences = await this.loadPersonPreferences(member.id, ownerUserId);
        }),
      );
    }

    return {
      familyMembers,
      totalCount: familyMembers.length,
      userId: ownerUserId,
    };
  }

  private async resolveUserProfile(
    ownerUserId: string,
  ): Promise<{ entityId: string | null; username: string | null }> {
    const node = await this.graphQuery.getUserEntity(ownerUserId);
    if (!node) {
      return { entityId: null, username: null };
    }

    return {
      entityId: node.entity_id,
      username: node.name ?? null,
    };
  }

  private mapRelationshipFilter(filter: string): string[] {
    const mapping: Record<string, string[]> = {
      romantic_partner: ['SPOUSE', 'PARTNER', 'ROMANTIC_PARTNER'],
      family: FAMILY_RELATIONSHIP_TYPES,
    };

    if (!filter || filter === 'all') {
      return [];
    }

    return mapping[filter] ?? [];
  }

  private async loadPersonPreferences(
    personEntityId: string,
    ownerUserId: string,
  ): Promise<{ likes: string[]; dislikes: string[] }> {
    const relationshipSummaries = await this.graphRead.getPreferences(ownerUserId, {
      personEntityId,
      relationship: 'PREFERS',
      limit: 10,
    });

    const dislikeSummaries = await this.graphRead.getPreferences(ownerUserId, {
      personEntityId,
      relationship: 'DISLIKES',
      limit: 10,
    });

    if (relationshipSummaries.length === 0 && dislikeSummaries.length === 0) {
      return { likes: [], dislikes: [] };
    }

    return {
      likes: relationshipSummaries.map((summary) => summary.name ?? summary.type),
      dislikes: dislikeSummaries.map((summary) => summary.name ?? summary.type),
    };
  }

  private extractDisplayName(properties?: Record<string, unknown>): string {
    const first = properties?.first_name as string | undefined;
    const last = properties?.last_name as string | undefined;

    if ((first && first.trim()) || (last && last.trim())) {
      return [first, last]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ')
        .trim();
    }

    return 'Unknown';
  }

  protected sanitizeInputForLogging(input: unknown): any {
    return input;
  }
}

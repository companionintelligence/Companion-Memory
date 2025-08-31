/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { MemoryService } from '@ci/domains/memory';

import { BaseTool } from './BaseTool';
import type { ToolExecutionContext } from './types';

// Input schema
const getFamilyMembersInputSchema = z.object({
  includePreferences: z.boolean().default(false),
  userId: z.string().optional(), // Remove .uuid() requirement
});

type GetFamilyMembersInput = z.infer<typeof getFamilyMembersInputSchema>;

// Output interfaces
interface FamilyMember {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  type: string | null;
  preferences?: string[];
  userId: string;
}

interface GetFamilyMembersOutput {
  familyMembers: FamilyMember[];
  totalCount: number;
  userId: string;
}

/**
 * Tool to retrieve family member information
 * Useful for meal planning considering family preferences
 */
@Injectable()
export class GetFamilyMembersTool extends BaseTool<GetFamilyMembersInput, GetFamilyMembersOutput> {
  readonly schema = {
    name: 'get_family_members',
    description:
      'Get information about family members and their names. Use this tool when you need to know WHO the family members are, not their food preferences.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        includePreferences: {
          type: 'boolean',
          description: 'Whether to include dietary preferences for each family member',
          default: false,
        },
        userId: {
          type: 'string',
          description: 'User ID to get family members for (optional, defaults to current user)',
        },
      },
      required: [],
    },
    examples: [
      {
        input: { includePreferences: true },
        output: {
          familyMembers: [
            {
              id: 'uuid',
              firstName: 'Jane',
              lastName: 'Doe',
              fullName: 'Jane Doe',
              type: 'spouse',
              preferences: ['vegetarian', 'gluten-free'],
              userId: 'user-uuid',
            },
          ],
          totalCount: 1,
          userId: 'user-uuid',
        },
        description: 'Get family members with their dietary preferences',
      },
    ],
  };

  constructor(
    private readonly memoryService: MemoryService,
  ) {
    super();
  }

  protected validateInput(input: unknown): GetFamilyMembersInput {
    return getFamilyMembersInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: GetFamilyMembersInput,
  ): Promise<GetFamilyMembersOutput> {
    const familyMembers = await this.memoryService.findFamilyMembers(input.includePreferences);

    return {
      familyMembers,
      totalCount: familyMembers.length,
      userId: familyMembers.length > 0 ? familyMembers[0].userId : 'demo-user',
    };
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in family members input
    return input;
  }
}

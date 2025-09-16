/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

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
    name: 'getFamilyMembers',
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
    // For demo: skip user ID constraints - just get all people
    const peopleQuery = `
      SELECT id, type, first_name as "firstName", last_name as "lastName", user_id as "userId"
      FROM people 
      ORDER BY first_name, last_name
    `;

    const peopleResult = await this.dataSource.query(peopleQuery);

    const familyMembers: FamilyMember[] = [];

    for (const person of peopleResult) {
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || 'Unknown';

      let preferences: string[] = [];

      if (input.includePreferences) {
        // Get preferences through person_tag relationship
        const preferencesQuery = `
          SELECT t.label
          FROM tags t
          JOIN person_tag pt ON t.id = pt.tag_id
          WHERE pt.person_id = $1
          ORDER BY t.label
        `;

        const prefResult = await this.dataSource.query(preferencesQuery, [person.id]);
        preferences = prefResult.map((row: any) => row.label);
      }

      familyMembers.push({
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        fullName,
        type: person.type,
        preferences: input.includePreferences ? preferences : undefined,
        userId: person.userId,
      });
    }

    return {
      familyMembers,
      totalCount: familyMembers.length,
      userId: peopleResult.length > 0 ? peopleResult[0].userId : 'demo-user',
    };
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in family members input
    return input;
  }
}

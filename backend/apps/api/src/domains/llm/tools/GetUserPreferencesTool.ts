import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import type { RequestContext } from '@ci/common/types';
import type { ToolExecutionContext } from './types';
import { BaseTool } from './BaseTool';

// Input schema for the tool
const getUserPreferencesInputSchema = z.object({
  category: z.enum(['dietary', 'cuisine', 'food', 'cooking']).optional(),
  userId: z.string().uuid().optional(),
});

type GetUserPreferencesInput = z.infer<typeof getUserPreferencesInputSchema>;

// Output interface
interface UserPreference {
  id: string;
  label: string;
  category?: string;
  userId: string;
  createdAt: Date;
}

interface GetUserPreferencesOutput {
  preferences: UserPreference[];
  totalCount: number;
  userId: string;
}

/**
 * Tool to retrieve user preferences from the database
 * Useful for dinner planning and food-related conversations
 */
@Injectable()
export class GetUserPreferencesTool extends BaseTool<
  GetUserPreferencesInput,
  GetUserPreferencesOutput
> {
  readonly schema = {
    name: 'get_user_preferences',
    description: 'Get user dietary preferences, food restrictions, and cooking preferences for meal planning',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['dietary', 'cuisine', 'food', 'cooking'],
          description: 'Filter preferences by category (optional)',
        },
        userId: {
          type: 'string',
          description: 'User ID to get preferences for (optional, defaults to current user)',
        },
      },
      required: [],
    },
    examples: [
      {
        input: { category: 'dietary' },
        output: {
          preferences: [
            { id: 'uuid', label: 'vegetarian', category: 'dietary', userId: 'user-uuid', createdAt: new Date() },
            { id: 'uuid', label: 'gluten-free', category: 'dietary', userId: 'user-uuid', createdAt: new Date() },
          ],
          totalCount: 2,
          userId: 'user-uuid',
        },
        description: 'Get dietary preferences for meal planning',
      },
    ],
  };

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  protected validateInput(input: unknown): GetUserPreferencesInput {
    return getUserPreferencesInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: GetUserPreferencesInput,
  ): Promise<GetUserPreferencesOutput> {
    const targetUserId = input.userId || context.userId;
    
    if (!targetUserId) {
      throw new Error('User ID is required');
    }

    // Build query with optional category filter
    let query = `
      SELECT id, label, user_id as "userId", created_at as "createdAt"
      FROM tags 
      WHERE user_id = $1
    `;
    
    const params: any[] = [targetUserId];

    if (input.category) {
      // Simple category filtering based on label content
      // You might want to add a proper category column later
      query += ` AND LOWER(label) LIKE $2`;
      params.push(`%${input.category.toLowerCase()}%`);
    }

    query += ` ORDER BY created_at DESC`;

    const result = await this.dataSource.query(query, params);
    
    const preferences: UserPreference[] = result.map((row: any) => ({
      id: row.id,
      label: row.label,
      category: this.inferCategory(row.label),
      userId: row.userId,
      createdAt: row.createdAt,
    }));

    return {
      preferences,
      totalCount: preferences.length,
      userId: targetUserId,
    };
  }

  /**
   * Simple category inference based on label content
   * This could be improved with proper categorization logic
   */
  private inferCategory(label: string): string {
    const lowerLabel = label.toLowerCase();
    
    if (lowerLabel.includes('vegetarian') || lowerLabel.includes('vegan') || 
        lowerLabel.includes('gluten') || lowerLabel.includes('dairy')) {
      return 'dietary';
    }
    
    if (lowerLabel.includes('italian') || lowerLabel.includes('chinese') || 
        lowerLabel.includes('mexican') || lowerLabel.includes('cuisine')) {
      return 'cuisine';
    }
    
    if (lowerLabel.includes('cooking') || lowerLabel.includes('baking') || 
        lowerLabel.includes('grilling')) {
      return 'cooking';
    }
    
    return 'food';
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in preferences input
    return input;
  }
}

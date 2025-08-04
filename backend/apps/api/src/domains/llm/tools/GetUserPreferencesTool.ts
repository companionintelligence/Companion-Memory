import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import type { RequestContext } from '@ci/common/types';
import type { ToolExecutionContext } from './types';
import { BaseTool } from './BaseTool';

// Input schema for the tool
const getUserPreferencesInputSchema = z.object({
  category: z.enum(['food', 'environment', 'learning', 'general']).optional(),
  userId: z.string().optional(), // Remove .uuid() requirement since LLM might not pass it
});

type GetUserPreferencesInput = z.infer<typeof getUserPreferencesInputSchema>;

// Output interface
interface UserPreference {
  id: string;
  label: string;
  category?: string;
  userId: string;
  createdAt: Date;
  question?: string;
  answer?: string;
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
    description: 'Get user personal preferences from their profile questions and answers, including food preferences, lifestyle, and personal tastes for meal planning and personalized recommendations',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['food', 'environment', 'learning', 'general'],
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
        input: { category: 'food' },
        output: {
          preferences: [
            { 
              id: 'uuid-123', 
              label: 'Do you prefer sweet or savory foods?: Savory; I love a good, hearty stew', 
              category: 'food', 
              userId: 'user-uuid', 
              createdAt: new Date(),
              question: 'Do you prefer sweet or savory foods?',
              answer: 'Savory; I love a good, hearty stew',
            },
          ],
          totalCount: 1,
          userId: 'user-uuid',
        },
        description: 'Get food preferences for meal planning with detailed question/answer pairs',
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
    // For demo: skip user ID constraints - just get all Personal Preferences
    const query = `
      SELECT 
        q.text as question,
        a.give_answer_1 as answer,
        q.category,
        a.user_id as "userId",
        q.created_at as "createdAt"
      FROM questions q
      JOIN answers a ON q.id = a.question_id  
      WHERE q.category = 'Personal Preferences'
        AND a.give_answer_1 IS NOT NULL
      ORDER BY q.created_at
    `;

    const result = await this.dataSource.query(query);
    
    const preferences: UserPreference[] = result.map((row: any) => ({
      id: `${row.userId}-${row.createdAt.getTime()}`, // Generate a unique ID
      label: `${row.question}: ${row.answer}`,
      category: this.inferCategory(row.question, row.answer),
      userId: row.userId,
      createdAt: row.createdAt,
      question: row.question,
      answer: row.answer,
    }));

    return {
      preferences,
      totalCount: preferences.length,
      userId: result.length > 0 ? result[0].userId : 'demo-user',
    };
  }

  /**
   * Infer category based on question and answer content
   */
  private inferCategory(question: string, answer: string): string {
    const lowerQuestion = question.toLowerCase();
    const lowerAnswer = answer.toLowerCase();
    
    if (lowerQuestion.includes('food') || lowerQuestion.includes('eat') || 
        lowerQuestion.includes('sweet') || lowerQuestion.includes('savory') ||
        lowerAnswer.includes('food') || lowerAnswer.includes('cuisine') ||
        lowerAnswer.includes('meal') || lowerAnswer.includes('cook')) {
      return 'food';
    }
    
    if (lowerQuestion.includes('environment') || lowerQuestion.includes('work') ||
        lowerAnswer.includes('quiet') || lowerAnswer.includes('organized')) {
      return 'environment';
    }
    
    if (lowerQuestion.includes('learn') || lowerQuestion.includes('activity') ||
        lowerAnswer.includes('reading') || lowerAnswer.includes('practice')) {
      return 'learning';
    }
    
    return 'general';
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in preferences input
    return input;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AnswerService } from '@ci/domains/intelligence';

import { BaseTool } from './BaseTool';
import type { ToolExecutionContext } from './types';

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
  subcategory?: string;
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
export class GetUserPreferencesTool extends BaseTool<GetUserPreferencesInput, GetUserPreferencesOutput> {
  readonly schema = {
    name: 'get_user_preferences',
    description:
      'Get user food preferences, dietary restrictions, allergies, and eating habits. Use this tool when planning meals, cooking, or discussing food choices.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['food', 'environment', 'learning', 'general'],
          description:
            'Filter preferences by category (optional) - not used currently as we focus on food subcategory',
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
        input: {},
        output: {
          preferences: [
            {
              id: 'uuid-123',
              label: 'Do you have any food allergies?: No known allergies',
              category: 'Physical Health',
              subcategory: 'Food',
              userId: 'user-uuid',
              createdAt: new Date(),
              question: 'Do you have any food allergies?',
              answer: 'No known allergies',
            },
          ],
          totalCount: 1,
          userId: 'user-uuid',
        },
        description: 'Get food-related preferences for comprehensive meal planning',
      },
    ],
  };

  constructor(
    private readonly answerService: AnswerService,
  ) {
    super();
  }

  protected validateInput(input: unknown): GetUserPreferencesInput {
    return getUserPreferencesInputSchema.parse(input);
  }

  protected async executeInternal(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: ToolExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _input: GetUserPreferencesInput,
  ): Promise<GetUserPreferencesOutput> {
    // Query for questions with subcategory = 'Food' (much more focused than all Personal Preferences)
    const preferences = await this.answerService.findPreferencesBySubcategory('Food');

    return {
      preferences,
      totalCount: preferences.length,
      userId: preferences.length > 0 ? preferences[0].userId : 'demo-user',
    };
  }

  /**
   * Infer category based on question and answer content
   */
  private inferCategory(question: string, answer: string): string {
    const lowerQuestion = question.toLowerCase();
    const lowerAnswer = answer.toLowerCase();

    if (
      lowerQuestion.includes('food') ||
      lowerQuestion.includes('eat') ||
      lowerQuestion.includes('sweet') ||
      lowerQuestion.includes('savory') ||
      lowerAnswer.includes('food') ||
      lowerAnswer.includes('cuisine') ||
      lowerAnswer.includes('meal') ||
      lowerAnswer.includes('cook')
    ) {
      return 'food';
    }

    if (
      lowerQuestion.includes('environment') ||
      lowerQuestion.includes('work') ||
      lowerAnswer.includes('quiet') ||
      lowerAnswer.includes('organized')
    ) {
      return 'environment';
    }

    if (
      lowerQuestion.includes('learn') ||
      lowerQuestion.includes('activity') ||
      lowerAnswer.includes('reading') ||
      lowerAnswer.includes('practice')
    ) {
      return 'learning';
    }

    return 'general';
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in preferences input
    return input;
  }
}

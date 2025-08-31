/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AnswerService } from '@ci/domains/intelligence';

import { BaseTool } from './BaseTool';
import type { ToolExecutionContext } from './types';

// Input schema for the tool
const getEntertainmentPreferencesInputSchema = z.object({
  category: z.enum(['movies', 'tv', 'streaming', 'general']).optional(),
  userId: z.string().optional(), // Optional for demo
});

type GetEntertainmentPreferencesInput = z.infer<typeof getEntertainmentPreferencesInputSchema>;

// Output interface
interface EntertainmentPreference {
  id: string;
  label: string;
  category?: string;
  subcategory?: string;
  userId: string;
  createdAt: Date;
  question?: string;
  answer?: string;
}

interface GetEntertainmentPreferencesOutput {
  preferences: EntertainmentPreference[];
  totalCount: number;
  userId: string;
}

/**
 * Tool to retrieve user entertainment preferences from the database
 * Focuses on movie, TV, and streaming preferences for recommendation systems
 *
 * FUTURE INTEGRATIONS PLANNED:
 * - Movie theater APIs (Fandango, AMC) for current showtimes
 * - TV guide APIs for current programming
 * - Review aggregation APIs (Rotten Tomatoes, Metacritic)
 *
 * This tool serves as the foundation for understanding user preferences
 * before querying external entertainment APIs for personalized recommendations.
 * *Meant to be used in conjunction with GetStreamingAvailabilityTool*
 */
@Injectable()
export class GetEntertainmentPreferencesTool extends BaseTool<
  GetEntertainmentPreferencesInput,
  GetEntertainmentPreferencesOutput
> {
  readonly schema = {
    name: 'get_entertainment_preferences',
    description:
      'Get user entertainment preferences including movie genres, TV show types, streaming preferences, and viewing habits. Use this tool when recommending movies, TV shows, or planning entertainment.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['movies', 'tv', 'streaming', 'general'],
          description: 'Filter preferences by entertainment category (optional)',
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
              label: 'What movie genres do you enjoy?: I love sci-fi and thriller movies',
              category: 'Personal Preferences',
              subcategory: 'Entertainment',
              userId: 'user-uuid',
              createdAt: new Date(),
              question: 'What movie genres do you enjoy?',
              answer: 'I love sci-fi and thriller movies',
            },
          ],
          totalCount: 1,
          userId: 'user-uuid',
        },
        description: 'Get entertainment preferences for movie and TV recommendations',
      },
    ],
  };

  constructor(
    private readonly answerService: AnswerService,
  ) {
    super();
  }

  protected validateInput(input: unknown): GetEntertainmentPreferencesInput {
    return getEntertainmentPreferencesInputSchema.parse(input);
  }

  protected async executeInternal(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: ToolExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _input: GetEntertainmentPreferencesInput,
  ): Promise<GetEntertainmentPreferencesOutput> {
    // Query for questions with subcategory = 'Entertainment'
    const preferences = await this.answerService.findPreferencesBySubcategory('Entertainment');

    return {
      preferences,
      totalCount: preferences.length,
      userId: preferences.length > 0 ? preferences[0].userId : 'demo-user',
    };
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in entertainment preferences input
    return input;
  }
}

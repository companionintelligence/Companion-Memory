/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

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
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
    const query = `
      SELECT
        q.text as question,
        a.give_answer_1 as answer,
        q.category,
        q.subcategory,
        a.user_id as "userId",
        q.created_at as "createdAt"
      FROM questions q
      JOIN answers a ON q.id = a.question_id
      WHERE q.subcategory = 'Entertainment'
        AND a.give_answer_1 IS NOT NULL
      ORDER BY q.created_at
    `;

    const result = await this.dataSource.query(query);

    const preferences: EntertainmentPreference[] = result.map((row: any) => ({
      id: `${row.userId}-${row.createdAt.getTime()}`, // Generate a unique ID
      label: `${row.question}: ${row.answer}`,
      category: row.category, // Use the actual category from the database
      subcategory: row.subcategory,
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

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in entertainment preferences input
    return input;
  }
}

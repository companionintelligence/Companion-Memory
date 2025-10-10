/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

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

/**
 * Tool to retrieve entertainment preferences from the graph database
 * Focuses on movies, TV, music, and books for recommendation systems
 *
 * FUTURE INTEGRATIONS PLANNED:
 * - Movie theater APIs (Fandango, AMC) for current showtimes
 * - TV guide APIs for current programming
 * - Music streaming APIs (Spotify, Apple Music)
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    super();
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

    // Determine target person
    let targetPersonId: string | null = null;
    let targetPersonName = 'Current User';

    const ownerUserId = context.userId;

    const userProfile = await this.loadUserGraphProfile(ownerUserId);

    if (!userProfile) {
      return {
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: '',
        personName: 'User not found',
      };
    }

    if (!userProfile.entityId) {
      return {
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: '',
        personName: userProfile.username || 'Current User',
      };
    }

    if (input.personName) {
      const resolved = await this.resolvePersonEntity(userProfile.entityId, ownerUserId, input.personName);
      if (!resolved) {
        return {
          preferences: [],
          dislikes: [],
          totalPreferences: 0,
          totalDislikes: 0,
          personId: '',
          personName: input.personName + ' (not found)',
        };
      }

      targetPersonId = resolved.entityId;
      targetPersonName = resolved.name ?? input.personName;
    } else {
      targetPersonId = userProfile.entityId;
      targetPersonName = userProfile.username || 'Current User';
    }

    if (!targetPersonId) {
      return {
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: '',
        personName: targetPersonName,
      };
    }

    // Build media type filter
    const mediaFilter = this.buildMediaTypeFilter(input.mediaType);

    // Query preferences
    const prefersQuery = `
      SELECT 
        e.entity_id,
        e.entity_type,
        e.name,
        e.properties,
        r.strength,
        'PREFERS' as relationship
      FROM relationships r
      JOIN entities e ON r.to_entity_id = e.entity_id
      WHERE r.from_entity_id = $1
        AND r.relationship_type = 'PREFERS'
        AND r.is_active = TRUE
        AND r.owner_user_id = $2
        AND e.owner_user_id = $2
        ${mediaFilter}
      ORDER BY r.strength DESC, e.name ASC
    `;

    // Query dislikes
    const dislikesQuery = `
      SELECT 
        e.entity_id,
        e.entity_type,
        e.name,
        e.properties,
        r.strength,
        'DISLIKES' as relationship
      FROM relationships r
      JOIN entities e ON r.to_entity_id = e.entity_id
      WHERE r.from_entity_id = $1
        AND r.relationship_type = 'DISLIKES'
        AND r.is_active = TRUE
        AND r.owner_user_id = $2
        AND e.owner_user_id = $2
        ${mediaFilter}
      ORDER BY r.strength DESC, e.name ASC
    `;

    const [prefersResult, dislikesResult] = await Promise.all([
      this.dataSource.query(prefersQuery, [targetPersonId, ownerUserId]),
      this.dataSource.query(dislikesQuery, [targetPersonId, ownerUserId]),
    ]);

    const preferences: EntertainmentPreference[] = prefersResult.map((row: any) => ({
      id: row.entity_id,
      type: row.entity_type,
      name: row.name,
      strength: parseFloat(row.strength),
      relationship: 'PREFERS' as const,
      properties: input.includeContext ? row.properties : undefined,
    }));

    const dislikes: EntertainmentPreference[] = dislikesResult.map((row: any) => ({
      id: row.entity_id,
      type: row.entity_type,
      name: row.name,
      strength: parseFloat(row.strength),
      relationship: 'DISLIKES' as const,
      properties: input.includeContext ? row.properties : undefined,
    }));

    return {
      preferences,
      dislikes,
      totalPreferences: preferences.length,
      totalDislikes: dislikes.length,
      personId: targetPersonId,
      personName: targetPersonName,
    };
  }

  private async loadUserGraphProfile(
    userId: string,
  ): Promise<{ entityId: string | null; username: string | null } | null> {
    const query = `
      SELECT entity_id, COALESCE(username, name) AS display_name
      FROM users
      WHERE id = $1
    `;

    const result = await this.dataSource.query(query, [userId]);

    if (result.length === 0) {
      return null;
    }

    let entityId: string | null = result[0].entity_id ?? null;

    if (!entityId) {
      const linkedQuery = `
        SELECT entity_id
        FROM entities
        WHERE linked_table = 'users'
          AND linked_id = $1
          AND is_active = TRUE
          AND owner_user_id = $2
        LIMIT 1
      `;

      const linkedResult = await this.dataSource.query(linkedQuery, [userId, userId]);
      if (linkedResult.length > 0) {
        entityId = linkedResult[0].entity_id;

        await this.dataSource.query(`UPDATE users SET entity_id = $2 WHERE id = $1`, [userId, entityId]);
      }
    }

    return {
      entityId,
      username: result[0].display_name ?? null,
    };
  }

  private async resolvePersonEntity(
    userEntityId: string,
    ownerUserId: string,
    personName: string,
  ): Promise<{ entityId: string; name: string | null } | null> {
    const lowerName = personName.toLowerCase().trim();

    const relationshipPatterns: Array<{ patterns: string[]; relationshipTypes: string[] }> = [
      {
        patterns: ['wife', 'husband', 'spouse', 'partner', 'significant other'],
        relationshipTypes: ['SPOUSE', 'PARTNER', 'ROMANTIC_PARTNER'],
      },
      {
        patterns: ['mother', 'mom', 'father', 'dad', 'parent'],
        relationshipTypes: ['PARENT_OF', 'CHILD_OF'],
      },
      { patterns: ['son', 'daughter', 'child', 'kid'], relationshipTypes: ['PARENT_OF', 'CHILD_OF'] },
      { patterns: ['brother', 'sister', 'sibling'], relationshipTypes: ['SIBLING_OF'] },
      { patterns: ['friend', 'best friend', 'buddy'], relationshipTypes: ['FRIEND', 'KNOWS'] },
      {
        patterns: ['colleague', 'coworker', 'boss', 'manager'],
        relationshipTypes: ['WORKS_WITH', 'COLLEAGUE'],
      },
    ];

    for (const { patterns, relationshipTypes } of relationshipPatterns) {
      if (patterns.some((pattern) => lowerName.includes(pattern))) {
        const candidate = await this.findRelatedEntityByRelationships(
          userEntityId,
          ownerUserId,
          relationshipTypes,
        );
        if (candidate) {
          return candidate;
        }
      }
    }

    return this.findRelatedEntityByName(userEntityId, ownerUserId, lowerName);
  }

  private async findRelatedEntityByRelationships(
    userEntityId: string,
    ownerUserId: string,
    relationshipTypes: string[],
  ): Promise<{ entityId: string; name: string | null } | null> {
    if (relationshipTypes.length === 0) {
      return null;
    }

    const query = `
      SELECT
        CASE WHEN r.from_entity_id = $1 THEN r.to_entity_id ELSE r.from_entity_id END AS entity_id,
        e.name
      FROM relationships r
      JOIN entities e ON e.entity_id = CASE WHEN r.from_entity_id = $1 THEN r.to_entity_id ELSE r.from_entity_id END
      WHERE (r.from_entity_id = $1 OR r.to_entity_id = $1)
        AND r.is_active = TRUE
        AND r.owner_user_id = $2
        AND e.is_active = TRUE
        AND e.entity_type = 'Person'
        AND e.owner_user_id = $2
        AND r.relationship_type = ANY($3::text[])
      ORDER BY r.strength DESC NULLS LAST, e.name ASC
      LIMIT 1
    `;

    const result = await this.dataSource.query(query, [userEntityId, ownerUserId, relationshipTypes]);

    if (result.length === 0) {
      return null;
    }

    return {
      entityId: result[0].entity_id,
      name: result[0].name,
    };
  }

  private async findRelatedEntityByName(
    userEntityId: string,
    ownerUserId: string,
    lowerName: string,
  ): Promise<{ entityId: string; name: string | null } | null> {
    if (!lowerName) {
      return null;
    }

    const likeValue = `%${lowerName}%`;

    const query = `
      SELECT
        CASE WHEN r.from_entity_id = $1 THEN r.to_entity_id ELSE r.from_entity_id END AS entity_id,
        e.name,
        r.strength
      FROM relationships r
      JOIN entities e ON e.entity_id = CASE WHEN r.from_entity_id = $1 THEN r.to_entity_id ELSE r.from_entity_id END
      WHERE (r.from_entity_id = $1 OR r.to_entity_id = $1)
        AND r.is_active = TRUE
        AND r.owner_user_id = $2
        AND e.is_active = TRUE
        AND e.entity_type = 'Person'
        AND e.owner_user_id = $2
        AND (
          LOWER(e.name) = $3
          OR LOWER(e.name) LIKE $4
          OR LOWER(e.properties->>'first_name') = $3
          OR LOWER(e.properties->>'last_name') = $3
        )
      ORDER BY r.strength DESC NULLS LAST, e.name ASC
      LIMIT 1
    `;

    const result = await this.dataSource.query(query, [userEntityId, ownerUserId, lowerName, likeValue]);

    if (result.length === 0) {
      return null;
    }

    return {
      entityId: result[0].entity_id,
      name: result[0].name,
    };
  }

  private buildMediaTypeFilter(mediaType: string): string {
    // Define entertainment-specific types
    const entertainmentTypes: Record<string, string[]> = {
      movies: ['movie_genre', 'film_style'],
      tv: ['tv_genre', 'tv_style'],
      music: ['music_genre', 'music_style'],
      books: ['book_genre', 'literary_genre'],
    };

    let types: string[];

    if (mediaType === 'all') {
      // When 'all', include all entertainment types but exclude food/beverage/activity
      types = Object.values(entertainmentTypes).flat();
    } else {
      types = entertainmentTypes[mediaType] || [];
    }

    if (types.length === 0) {
      return '';
    }

    const typeList = types.map((t) => `'${t}'`).join(', ');

    return `AND e.properties->>'type' IN (${typeList})`;
  }

  protected sanitizeInputForLogging(input: unknown): any {
    return input;
  }
}

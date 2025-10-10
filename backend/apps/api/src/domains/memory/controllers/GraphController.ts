import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';

import { GraphUtilityService } from '../services/GraphUtilityService';
import { UserContextService } from '../services/UserContextService';

/**
 * Controller for high-level graph operations
 * Provides simple REST endpoints for frontend to add data to the knowledge graph
 */
@Controller('graph')
@UseGuards(JwtAuthGuard)
export class GraphController {
  constructor(
    private readonly graphUtility: GraphUtilityService,
    private readonly userContext: UserContextService,
  ) {}

  private ensureUserId(ctx: RequestContext): string {
    if (!ctx.userId) {
      throw new Error('User ID is required');
    }

    return ctx.userId;
  }

  /**
   * Add a person to the graph with optional relationships
   * POST /graph/person
   */
  @Post('person')
  async addPerson(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      name: string;
      firstName?: string;
      lastName?: string;
      age?: number;
      bio?: string;
      occupation?: string;
      familyRole?: string;
      email?: string;
      phone?: string;
      properties?: Record<string, unknown>;
      relationships?: Array<{
        toPersonEntityId: string;
        type: 'SPOUSE' | 'PARENT_OF' | 'CHILD_OF' | 'SIBLING_OF' | 'FRIEND' | 'COLLEAGUE' | 'KNOWS';
        strength?: number;
        bidirectional?: boolean;
      }>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const { relationships, ...personData } = body;

    const result = await this.graphUtility.addPerson(userId, personData, relationships);

    return {
      success: true,
      person: {
        entityId: result.personEntity.entity_id,
        name: result.personEntity.name,
        properties: result.personEntity.properties,
      },
      relationshipsCreated: result.relationshipsCreated,
    };
  }

  /**
   * Batch add family members
   * POST /graph/family
   */
  @Post('family')
  async addFamilyMembers(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      userEntityId: string;
      familyMembers: Array<{
        name: string;
        relationship: 'SPOUSE' | 'PARENT_OF' | 'CHILD_OF' | 'SIBLING_OF';
        age?: number;
        firstName?: string;
        lastName?: string;
        properties?: Record<string, unknown>;
      }>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const result = await this.graphUtility.addFamilyMembers(userId, body.userEntityId, body.familyMembers);

    return {
      success: true,
      created: result.created,
      familyMembers: result.entities.map((entity) => ({
        entityId: entity.entity_id,
        name: entity.name,
        properties: entity.properties,
      })),
    };
  }

  /**
   * Add a preference for a person
   * POST /graph/preference
   */
  @Post('preference')
  async addPreference(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      personEntityId: string;
      name: string;
      type:
        | 'food'
        | 'cuisine'
        | 'activity'
        | 'movie_genre'
        | 'tv_genre'
        | 'music_genre'
        | 'book_genre'
        | 'beverage';
      isDislike?: boolean;
      strength?: number;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const { personEntityId, ...preference } = body;

    const result = await this.graphUtility.addPreference(userId, personEntityId, preference);

    return {
      success: true,
      concept: {
        entityId: result.conceptEntity.entity_id,
        name: result.conceptEntity.name,
        type: result.conceptEntity.properties?.['type'],
      },
      relationship: {
        id: result.relationship.relationship_id,
        type: result.relationship.relationship_type,
        strength: result.relationship.strength,
      },
    };
  }

  /**
   * Batch add preferences for a person
   * POST /graph/preferences
   */
  @Post('preferences')
  async addPreferences(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      personEntityId: string;
      preferences: Array<{
        name: string;
        type: string;
        isDislike?: boolean;
        strength?: number;
        properties?: Record<string, unknown>;
      }>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const result = await this.graphUtility.addPreferences(userId, body.personEntityId, body.preferences);

    return {
      success: true,
      created: result.created,
      preferences: result.results.map((r) => ({
        conceptId: r.conceptEntity.entity_id,
        name: r.conceptEntity.name,
        relationshipType: r.relationship.relationship_type,
      })),
    };
  }

  /**
   * Add a location to the graph
   * POST /graph/location
   */
  @Post('location')
  async addLocation(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      name: string;
      type: 'city' | 'country' | 'venue' | 'address' | 'region';
      coordinates?: { lat: number; lng: number };
      address?: string;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const location = await this.graphUtility.addLocation(userId, body);

    return {
      success: true,
      location: {
        entityId: location.entity_id,
        name: location.name,
        type: location.properties?.['type'],
        coordinates: location.properties?.['coordinates'],
      },
    };
  }

  /**
   * Record that a person visited a location
   * POST /graph/visit
   */
  @Post('visit')
  async addVisit(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      personEntityId: string;
      locationEntityId: string;
      date?: string; // ISO date string
      duration?: string;
      notes?: string;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const { personEntityId, locationEntityId, date, ...visitDetails } = body;

    const relationship = await this.graphUtility.addVisit(userId, personEntityId, locationEntityId, {
      date: date ? new Date(date) : undefined,
      ...visitDetails,
    });

    return {
      success: true,
      visit: {
        relationshipId: relationship.relationship_id,
        from: relationship.from_entity_id,
        to: relationship.to_entity_id,
        properties: relationship.properties,
      },
    };
  }

  /**
   * Add a social connection between two people
   * POST /graph/connection
   */
  @Post('connection')
  async addSocialConnection(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      fromPersonId: string;
      toPersonId: string;
      connectionType:
        | 'KNOWS'
        | 'FRIEND'
        | 'WORKS_WITH'
        | 'COLLEAGUE'
        | 'MENTORED'
        | 'TAUGHT'
        | 'LEARNED_FROM';
      since?: string; // ISO date string
      context?: string;
      strength?: number;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const { fromPersonId, toPersonId, connectionType, since, ...details } = body;

    const relationship = await this.graphUtility.addSocialConnection(
      userId,
      fromPersonId,
      toPersonId,
      connectionType,
      {
        since: since ? new Date(since) : undefined,
        ...details,
      },
    );

    return {
      success: true,
      connection: {
        relationshipId: relationship.relationship_id,
        from: relationship.from_entity_id,
        to: relationship.to_entity_id,
        type: relationship.relationship_type,
        strength: relationship.strength,
      },
    };
  }

  /**
   * Get user context for LLM (useful for debugging/preview)
   * GET /graph/context
   */
  @Get('context')
  async getUserContext(@Context() ctx: RequestContext) {
    const userId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(userId);

    if (!context) {
      return {
        success: false,
        message: 'User context not available. User may need to complete onboarding.',
      };
    }

    return {
      success: true,
      context,
    };
  }

  /**
   * Get user context formatted for LLM system prompt
   * GET /graph/context/formatted
   */
  @Get('context/formatted')
  async getUserContextFormatted(@Context() ctx: RequestContext) {
    const userId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(userId);

    if (!context) {
      return {
        success: false,
        message: 'User context not available.',
      };
    }

    const formatted = this.userContext.formatContextForSystemPrompt(context);

    return {
      success: true,
      formatted,
    };
  }
}

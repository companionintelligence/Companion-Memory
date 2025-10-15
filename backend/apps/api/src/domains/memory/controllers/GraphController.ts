import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';

import { LocationGraphService } from '../services/graph/LocationGraphService';
import { PersonGraphService } from '../services/graph/PersonGraphService';
import { PreferenceService } from '../services/graph/PreferenceService';
import { RelationshipService } from '../services/graph/RelationshipService';
import { UserContextService } from '../services/UserContextService';

/**
 * Controller for high-level graph operations
 * Provides simple REST endpoints for frontend to add data to the knowledge graph
 */
@Controller('graph')
@UseGuards(JwtAuthGuard)
export class GraphController {
  constructor(
    private readonly personService: PersonGraphService,
    private readonly preferenceService: PreferenceService,
    private readonly locationService: LocationGraphService,
    private readonly relationshipService: RelationshipService,
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
        type: string;
        strength?: number;
        bidirectional?: boolean;
      }>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const { relationships, ...personData } = body;

    const result = await this.personService.addPerson(userId, personData, relationships);

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
        relationship: string;
        age?: number;
        firstName?: string;
        lastName?: string;
        properties?: Record<string, unknown>;
      }>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const result = await this.personService.addFamilyMembers(userId, body.userEntityId, body.familyMembers);

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
   * Add a single preference
   * POST /graph/preference
   */
  @Post('preference')
  async addPreference(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      personEntityId: string;
      name: string;
      type: string;
      isDislike?: boolean;
      strength?: number;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const result = await this.preferenceService.addPreference(userId, body.personEntityId, {
      name: body.name,
      type: body.type,
      isDislike: body.isDislike,
      strength: body.strength,
      properties: body.properties,
    });

    return {
      success: true,
      concept: {
        entityId: result.conceptEntity.entity_id,
        name: result.conceptEntity.name,
        type: body.type,
      },
      relationship: {
        id: result.relationship.relationship_id,
        type: result.relationship.relationship_type,
        strength: result.relationship.strength,
      },
    };
  }

  /**
   * Batch add preferences
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
    const result = await this.preferenceService.addPreferences(userId, body.personEntityId, body.preferences);

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
   * Add a location
   * POST /graph/location
   */
  @Post('location')
  async addLocation(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      name: string;
      type: string;
      coordinates?: { lat: number; lng: number };
      address?: string;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const location = await this.locationService.addLocation(userId, body);

    return {
      success: true,
      location: {
        entityId: location.entity_id,
        name: location.name,
        type: body.type,
        coordinates: body.coordinates,
      },
    };
  }

  /**
   * Record a visit
   * POST /graph/visit
   */
  @Post('visit')
  async addVisit(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      personEntityId: string;
      locationEntityId: string;
      date?: Date;
      duration?: string;
      notes?: string;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const relationship = await this.relationshipService.addVisit(
      userId,
      body.personEntityId,
      body.locationEntityId,
      {
        date: body.date,
        duration: body.duration,
        notes: body.notes,
        properties: body.properties,
      },
    );

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
   * Add a social connection
   * POST /graph/connection
   */
  @Post('connection')
  async addSocialConnection(
    @Context() ctx: RequestContext,
    @Body()
    body: {
      fromPersonId: string;
      toPersonId: string;
      connectionType: string;
      since?: Date;
      context?: string;
      strength?: number;
      properties?: Record<string, unknown>;
    },
  ) {
    const userId = this.ensureUserId(ctx);
    const relationship = await this.relationshipService.addSocialConnection(
      userId,
      body.fromPersonId,
      body.toPersonId,
      body.connectionType,
      {
        since: body.since,
        context: body.context,
        strength: body.strength,
        properties: body.properties,
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
   * Get user context (for debugging/preview)
   * GET /graph/context
   */
  @Get('context')
  async getUserContext(@Context() ctx: RequestContext) {
    const userId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(userId);

    return {
      success: true,
      context,
    };
  }

  /**
   * Get formatted user context for LLM
   * GET /graph/context/formatted
   */
  @Get('context/formatted')
  async getFormattedUserContext(@Context() ctx: RequestContext) {
    const userId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(userId);

    if (!context) {
      return {
        success: false,
        message: 'User context not available',
      };
    }

    const formatted = this.userContext.formatContextForSystemPrompt(context);

    return {
      success: true,
      formatted,
    };
  }
}

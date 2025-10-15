import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';

import { LocationGraphService } from '../services/graph/LocationGraphService';
import { PersonGraphService } from '../services/graph/PersonGraphService';
import { PreferenceService } from '../services/graph/PreferenceService';
import { RelationshipService } from '../services/graph/RelationshipService';
import { UserContextService } from '../services/UserContextService';

const propertiesSchema = z.record(z.unknown());
const optionalPropertiesSchema = propertiesSchema.optional();

const addPersonSchema = z.object({
  name: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  age: z.number().optional(),
  bio: z.string().optional(),
  occupation: z.string().optional(),
  familyRole: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  properties: optionalPropertiesSchema,
  relationships: z
    .array(
      z.object({
        toPersonEntityId: z.string(),
        type: z.string(),
        strength: z.number().optional(),
        bidirectional: z.boolean().optional(),
        properties: optionalPropertiesSchema,
      }),
    )
    .optional(),
});

const addFamilyMembersSchema = z.object({
  userEntityId: z.string(),
  familyMembers: z
    .array(
      z.object({
        name: z.string(),
        relationship: z.string(),
        age: z.number().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        properties: optionalPropertiesSchema,
      }),
    )
    .min(1),
});

const addPreferenceSchema = z.object({
  personEntityId: z.string(),
  name: z.string(),
  type: z.string(),
  isDislike: z.boolean().optional(),
  strength: z.number().optional(),
  properties: optionalPropertiesSchema,
});

const addPreferencesSchema = z.object({
  personEntityId: z.string(),
  preferences: z
    .array(
      addPreferenceSchema.pick({
        name: true,
        type: true,
        isDislike: true,
        strength: true,
        properties: true,
      }),
    )
    .min(1),
});

const addLocationSchema = z.object({
  name: z.string(),
  type: z.string(),
  coordinates: z
    .object({
      lat: z.number(),
      lng: z.number(),
    })
    .optional(),
  address: z.string().optional(),
  properties: optionalPropertiesSchema,
});

const addVisitSchema = z.object({
  personEntityId: z.string(),
  locationEntityId: z.string(),
  date: z.string().optional(),
  duration: z.string().optional(),
  notes: z.string().optional(),
  properties: optionalPropertiesSchema,
});

const addConnectionSchema = z.object({
  fromPersonId: z.string(),
  toPersonId: z.string(),
  connectionType: z.string(),
  since: z.string().optional(),
  context: z.string().optional(),
  strength: z.number().optional(),
  properties: optionalPropertiesSchema,
});

const deleteNodeSchema = z.object({ entityId: z.string() });

const updateNodeSchema = z.object({
  entityId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  properties: optionalPropertiesSchema,
});

const deleteRelationshipSchema = z.object({ relationshipId: z.string() });

type AddPersonDto = z.infer<typeof addPersonSchema>;
type AddFamilyMembersDto = z.infer<typeof addFamilyMembersSchema>;
type AddPreferenceDto = z.infer<typeof addPreferenceSchema>;
type AddPreferencesDto = z.infer<typeof addPreferencesSchema>;
type AddLocationDto = z.infer<typeof addLocationSchema>;
type AddVisitDto = z.infer<typeof addVisitSchema>;
type AddConnectionDto = z.infer<typeof addConnectionSchema>;
type DeleteNodeDto = z.infer<typeof deleteNodeSchema>;
type UpdateNodeDto = z.infer<typeof updateNodeSchema>;
type DeleteRelationshipDto = z.infer<typeof deleteRelationshipSchema>;

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

  private parseOptionalDate(value?: string): Date | undefined {
    if (!value) {
      return undefined;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date format. Expected ISO string.');
    }

    return date;
  }

  /**
   * Add a person to the graph with optional relationships
   * POST /graph/person
   */
  @Post('person')
  async addPerson(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addPersonSchema)) body: AddPersonDto,
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
    @Body(new ValidationPipe(addFamilyMembersSchema)) body: AddFamilyMembersDto,
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
    @Body(new ValidationPipe(addPreferenceSchema)) body: AddPreferenceDto,
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
    @Body(new ValidationPipe(addPreferencesSchema)) body: AddPreferencesDto,
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
    @Body(new ValidationPipe(addLocationSchema)) body: AddLocationDto,
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
    @Body(new ValidationPipe(addVisitSchema)) body: AddVisitDto,
  ) {
    const userId = this.ensureUserId(ctx);
    const relationship = await this.relationshipService.addVisit(
      userId,
      body.personEntityId,
      body.locationEntityId,
      {
        date: this.parseOptionalDate(body.date),
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
    @Body(new ValidationPipe(addConnectionSchema)) body: AddConnectionDto,
  ) {
    const userId = this.ensureUserId(ctx);
    const relationship = await this.relationshipService.addSocialConnection(
      userId,
      body.fromPersonId,
      body.toPersonId,
      body.connectionType,
      {
        since: this.parseOptionalDate(body.since),
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

  /**
   * Get all nodes and relationships for the current user
   * GET /graph/data
   */
  @Get('data')
  async getGraphData(@Context() ctx: RequestContext) {
    const userId = this.ensureUserId(ctx);

    // Get all nodes for this user
    const nodes = await this.personService.getAllNodes(userId, { limit: 200 });

    // Get all relationships for this user
    const relationships = await this.relationshipService.getRelationships(userId, {});

    return {
      success: true,
      data: {
        nodes: nodes.map((node) => ({
          id: node.entity_id,
          entity_id: node.entity_id,
          entity_type: node.entity_type,
          name: node.name,
          description: node.description,
          properties: node.properties || {},
        })),
        links: relationships.map((rel) => ({
          id: rel.relationship_id,
          relationship_id: rel.relationship_id,
          source: rel.from_entity_id,
          target: rel.to_entity_id,
          relationship_type: rel.relationship_type,
          strength: rel.strength || 0.5,
          properties: rel.properties || {},
        })),
      },
    };
  }

  /**
   * Delete a node from the graph
   * POST /graph/node/delete
   */
  @Post('node/delete')
  async deleteNode(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(deleteNodeSchema)) body: DeleteNodeDto,
  ) {
    const userId = this.ensureUserId(ctx);
    await this.personService.deleteNode(userId, body.entityId);

    return {
      success: true,
      message: 'Node deleted successfully',
    };
  }

  /**
   * Update a node in the graph
   * POST /graph/node/update
   */
  @Post('node/update')
  async updateNode(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(updateNodeSchema)) body: UpdateNodeDto,
  ) {
    const userId = this.ensureUserId(ctx);
    const node = await this.personService.updateNode(userId, body.entityId, {
      name: body.name,
      description: body.description,
      properties: body.properties,
    });

    return {
      success: true,
      node: {
        entityId: node.entity_id,
        name: node.name,
        description: node.description,
        properties: node.properties,
      },
    };
  }

  /**
   * Delete a relationship from the graph
   * POST /graph/relationship/delete
   */
  @Post('relationship/delete')
  async deleteRelationship(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(deleteRelationshipSchema)) body: DeleteRelationshipDto,
  ) {
    const userId = this.ensureUserId(ctx);
    await this.relationshipService.deleteRelationship(userId, body.relationshipId);

    return {
      success: true,
      message: 'Relationship deleted successfully',
    };
  }
}

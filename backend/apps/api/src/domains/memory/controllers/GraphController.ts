import { Body, Controller, Get, NotFoundException, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';
import { GraphQueryService, UserContextService } from '@ci/domains/graph';
import { EmbeddingService } from '@ci/domains/search';

import { GraphEventService } from '../services/GraphEventService';

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
const getNodeDetailsSchema = z.object({ entityId: z.string() });
const graphSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

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
type GetNodeDetailsDto = z.infer<typeof getNodeDetailsSchema>;
type GraphSearchDto = z.infer<typeof graphSearchSchema>;

@Controller('graph')
@UseGuards(JwtAuthGuard)
export class GraphController {
  constructor(
    private readonly graphEvents: GraphEventService,
    private readonly graphQuery: GraphQueryService,
    private readonly userContext: UserContextService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  private ensureUserId(ctx: RequestContext): string {
    if (!ctx.userId) {
      throw new Error('User ID is required');
    }

    return ctx.userId;
  }

  @Post('person')
  async addPerson(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addPersonSchema)) body: AddPersonDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const result = await this.graphEvents.addPerson(ownerId, body);

    return {
      success: true,
      person: result.person,
      relationshipsCreated: result.relationshipsCreated,
    };
  }

  @Post('family')
  async addFamilyMembers(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addFamilyMembersSchema)) body: AddFamilyMembersDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const result = await this.graphEvents.addFamilyMembers(ownerId, body.userEntityId, body.familyMembers);

    return {
      success: true,
      created: result.created,
      familyMembers: result.familyMembers,
    };
  }

  @Post('preference')
  async addPreference(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addPreferenceSchema)) body: AddPreferenceDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const result = await this.graphEvents.addPreference(ownerId, body);

    return {
      success: true,
      concept: result.concept,
      relationship: result.relationship,
    };
  }

  @Post('preferences')
  async addPreferences(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addPreferencesSchema)) body: AddPreferencesDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const result = await this.graphEvents.addPreferences(ownerId, {
      personEntityId: body.personEntityId,
      preferences: body.preferences,
    });

    return {
      success: true,
      created: result.created,
      preferences: result.preferences,
    };
  }

  @Post('location')
  async addLocation(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addLocationSchema)) body: AddLocationDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const result = await this.graphEvents.addLocation(ownerId, body);

    return {
      success: true,
      location: result.location,
    };
  }

  @Post('visit')
  async addVisit(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addVisitSchema)) body: AddVisitDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const result = await this.graphEvents.addVisit(ownerId, body);

    return {
      success: true,
      visit: result.visit,
    };
  }

  @Post('connection')
  async addSocialConnection(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(addConnectionSchema)) body: AddConnectionDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const result = await this.graphEvents.addConnection(ownerId, body);

    return {
      success: true,
      connection: result.connection,
    };
  }

  @Get('context')
  async getUserContext(@Context() ctx: RequestContext) {
    const ownerId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(ownerId);

    return {
      success: true,
      context,
    };
  }

  @Get('context/formatted')
  async getFormattedUserContext(@Context() ctx: RequestContext) {
    const ownerId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(ownerId);

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

  @Get('data')
  async getGraphData(@Context() ctx: RequestContext) {
    const ownerId = this.ensureUserId(ctx);

    const nodes = await this.graphQuery.getNodes(ownerId, { limit: 200 });
    const relationships = await this.graphQuery.getRelationships(ownerId, {});

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

  @Get('search')
  async searchGraph(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(graphSearchSchema)) query: GraphSearchDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const limit = query.limit ?? 10;

    const results = await this.embeddingService.findNearest(ctx, query.query, ['graph_node'], limit);
    const nodeIds = results
      .filter((result) => result.type === 'graph_node')
      .map((result) => result.id)
      .slice(0, limit);

    if (nodeIds.length === 0) {
      return {
        success: true,
        nodes: [],
      };
    }

    const nodes = await this.graphQuery.getNodesByIds(ownerId, nodeIds);
    const nodeMap = new Map(nodes.map((node) => [node.entity_id, node]));
    const distanceMap = new Map(results.map((result) => [result.id, result.distance]));

    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: nodeIds,
      direction: 'both',
      includeInactive: false,
    });
    const filteredRelationships = relationships.filter(
      (rel) => nodeIds.includes(rel.from_entity_id) && nodeIds.includes(rel.to_entity_id),
    );

    const responseNodes = nodeIds
      .map((id) => {
        const node = nodeMap.get(id);
        if (!node) {
          return null;
        }

        return {
          id: node.entity_id,
          entity_id: node.entity_id,
          entity_type: node.entity_type,
          name: node.name,
          description: node.description,
          properties: node.properties ?? {},
          score: distanceMap.get(id) ?? null,
        };
      })
      .filter(
        (
          value,
        ): value is {
          id: string;
          entity_id: string;
          entity_type: string;
          name: string | null;
          description: string | null;
          properties: Record<string, unknown>;
          score: number | null;
        } => value !== null,
      );

    return {
      success: true,
      nodes: responseNodes,
      links: filteredRelationships.map((rel) => ({
        id: rel.relationship_id,
        relationship_id: rel.relationship_id,
        source: rel.from_entity_id,
        target: rel.to_entity_id,
        relationship_type: rel.relationship_type,
        strength: rel.strength ?? 0.5,
        properties: rel.properties ?? {},
      })),
    };
  }

  @Get('node')
  async getNodeDetails(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(getNodeDetailsSchema)) query: GetNodeDetailsDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    const node = await this.graphQuery.getNode(ownerId, query.entityId);
    if (!node) {
      throw new NotFoundException(`Node ${query.entityId} not found`);
    }

    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: [node.entity_id],
      direction: 'both',
      includeInactive: true,
    });

    const neighborIds = new Set<string>();
    for (const rel of relationships) {
      const otherId = rel.from_entity_id === node.entity_id ? rel.to_entity_id : rel.from_entity_id;
      neighborIds.add(otherId);
    }

    const neighborNodes = neighborIds.size
      ? await this.graphQuery.getNodesByIds(ownerId, Array.from(neighborIds))
      : [];
    const neighborMap = new Map(neighborNodes.map((n) => [n.entity_id, n]));

    return {
      success: true,
      node: {
        entityId: node.entity_id,
        entityType: node.entity_type,
        name: node.name,
        description: node.description,
        properties: node.properties ?? {},
        createdAt: node.created_at,
        updatedAt: node.updated_at,
      },
      relationships: relationships.map((rel) => {
        const isOutbound = rel.from_entity_id === node.entity_id;
        const otherId = isOutbound ? rel.to_entity_id : rel.from_entity_id;
        const otherNode = neighborMap.get(otherId) ?? null;

        return {
          relationshipId: rel.relationship_id,
          relationshipType: rel.relationship_type,
          direction: isOutbound ? 'outbound' : 'inbound',
          strength: rel.strength,
          isBidirectional: rel.is_bidirectional,
          properties: rel.properties ?? {},
          otherEntity: otherNode
            ? {
                entityId: otherNode.entity_id,
                entityType: otherNode.entity_type,
                name: otherNode.name,
                description: otherNode.description,
                properties: otherNode.properties ?? {},
              }
            : null,
        };
      }),
    };
  }

  @Post('node/delete')
  async deleteNode(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(deleteNodeSchema)) body: DeleteNodeDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    await this.graphEvents.deleteNode(ownerId, body.entityId);

    return {
      success: true,
      message: 'Node deleted successfully',
    };
  }

  @Post('node/update')
  async updateNode(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(updateNodeSchema)) body: UpdateNodeDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const updated = await this.graphEvents.updateNode(ownerId, body.entityId, {
      name: body.name,
      description: body.description,
      properties: body.properties,
    });

    return {
      success: true,
      node: updated,
    };
  }

  @Post('relationship/delete')
  async deleteRelationship(
    @Context() ctx: RequestContext,
    @Body(new ValidationPipe(deleteRelationshipSchema)) body: DeleteRelationshipDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    await this.graphEvents.deleteRelationship(ownerId, body.relationshipId);

    return {
      success: true,
      message: 'Relationship deleted successfully',
    };
  }
}

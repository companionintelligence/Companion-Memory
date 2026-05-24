import { UseGuards } from '@nestjs/common';
import { Mutation, Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { RelationshipService } from '@ci/domains/graph';
import { CreateRelationshipPayload } from '@ci/domains/graphql/types/CreateRelationshipPayload';
import { DeleteByIdInput } from '@ci/domains/graphql/types/DeleteByIdInput';
import { DeleteByIdPayload } from '@ci/domains/graphql/types/DeleteByIdPayload';
import { PaginationArgs } from '@ci/domains/graphql/types/PaginationArgs';
import { RelationshipConnection } from '@ci/domains/graphql/types/RelationshipConnection';
import { RelationshipEdge } from '@ci/domains/graphql/types/RelationshipEdge';
import { UpdateRelationshipPayload } from '@ci/domains/graphql/types/UpdateRelationshipPayload';
import { Paginator } from '@ci/domains/graphql/utils/Paginator';

import { CreateRelationshipInput } from '../types/CreateRelationshipInput';
import { GlobalUID } from '../types/GlobalUID';
import { RelationshipType } from '../types/RelationshipType';
import { UpdateRelationshipInput } from '../types/UpdateRelationshipInput';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => RelationshipType)
export class RelationshipResolver {
  constructor(private readonly relationshipService: RelationshipService) {}

  @Mutation(() => CreateRelationshipPayload)
  async createRelationship(
    @Context() context: RequestContext,
    @Args('input') input: CreateRelationshipInput,
  ): Promise<CreateRelationshipPayload> {
    const serviceContext = toServiceContext(context);

    const entity = await this.relationshipService.create(serviceContext, {
      fromNodeId: input.fromNodeId,
      fromNodeType: input.fromNodeType,
      toNodeId: input.toNodeId,
      toNodeType: input.toNodeType,
      type: input.type,
      strength: input.strength || 1,
      properties: input.properties || {},
      isBidirectional: input.isBidirectional || false,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      relationship: entity ? RelationshipType.toType(entity) : undefined,
    };
  }

  @Mutation(() => UpdateRelationshipPayload)
  async updateRelationship(
    @Context() context: RequestContext,
    @Args('input') input: UpdateRelationshipInput,
  ): Promise<UpdateRelationshipPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('relationship', input.id);

    const entity = await this.relationshipService.update(serviceContext, id, {
      strength: input.strength,
      properties: input.properties,
      isBidirectional: input.isBidirectional,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      relationship: entity ? RelationshipType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteRelationship(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('relationship', input.id);

    const success = await this.relationshipService.delete(serviceContext, id);

    if (!success) {
      return {
        success: false,
      };
    }

    return {
      success,
      deletedId: input.id,
    };
  }

  @Query(() => RelationshipConnection)
  async relationships(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<RelationshipConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.relationshipService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('relationship', entity.id),
    });

    const edges: RelationshipEdge[] = slice.map((entity) => {
      const node = RelationshipType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => RelationshipType, { nullable: true })
  async relationship(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<RelationshipType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('relationship', gid);

    const entity = await this.relationshipService.findById(serviceContext, id);

    return entity ? RelationshipType.toType(entity) : null;
  }
}

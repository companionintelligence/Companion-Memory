import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { toServiceContext } from '@ci/common/utils';
import { type TaggableEntity, TagService } from '@ci/domains/search-next';

import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { TagConnection } from '../types/TagConnection';
import { TagEdge } from '../types/TagEdge';
import { TagEntitiesInput } from '../types/TagEntitiesInput';
import { TagType } from '../types/TagType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtAuthGuard)
@Resolver()
export class TagResolver {
  constructor(private readonly tagService: TagService) {}

  @Query(() => TagConnection)
  async tags(@Context() context: RequestContext, @Args() pagination: PaginationArgs): Promise<TagConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.tagService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('tag', entity.id),
    });

    const edges: TagEdge[] = slice.map((entity) => {
      const node = TagType.toType(entity);

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

  @Query(() => TagType, { nullable: true })
  async tag(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TagType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('tag', gid);

    const entity = await this.tagService.findById(serviceContext, id);

    return entity ? TagType.toType(entity) : null;
  }

  @Mutation(() => Boolean)
  async tagEntities(
    @Context() context: RequestContext,
    @Args('input') input: TagEntitiesInput,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    const entities = input.ids.map((gid) => {
      const { type, id } = GlobalUID.decode(gid);

      if (!isTaggableEntity(type)) {
        throw new Error(`Invalid entity type: ${type}`);
      }

      return {
        type,
        id,
      };
    });

    return this.tagService.tagEntities(serviceContext, {
      label: input.label,
      entities,
    });
  }

  @Mutation(() => Boolean)
  async untagEntities(
    @Context() context: RequestContext,
    @Args('input') input: TagEntitiesInput,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    const entities = input.ids.map((gid) => {
      const { type, id } = GlobalUID.decode(gid);

      if (!isTaggableEntity(type)) {
        throw new Error(`Invalid entity type: ${type}`);
      }

      return {
        type,
        id,
      };
    });

    return this.tagService.untagEntities(serviceContext, {
      label: input.label,
      entities,
    });
  }
}

function isTaggableEntity(type: string): type is TaggableEntity {
  const validTypes: TaggableEntity[] = ['person'];

  return validTypes.includes(type as TaggableEntity);
}

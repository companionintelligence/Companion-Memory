import { BadRequestException, UseGuards } from '@nestjs/common';
import { Mutation, Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { SavedSearchService } from '@ci/domains/files';
import { UpdateSavedSearchPayload } from '@ci/domains/graphql/types/UpdateSavedSearchPayload';
import type { IndexableEntity } from '@ci/domains/search-next';
import { INDEXABLE_ENTITIES } from '@ci/domains/search-next';

import { CreateSavedSearchInput } from '../types/CreateSavedSearchInput';
import { CreateSavedSearchPayload } from '../types/CreateSavedSearchPayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { SavedSearchConnection } from '../types/SavedSearchConnection';
import { SavedSearchEdge } from '../types/SavedSearchEdge';
import { SavedSearchType } from '../types/SavedSearchType';
import { UpdateSavedSearchInput } from '../types/UpdateSavedSearchInput';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => SavedSearchType)
export class SavedSearchResolver {
  constructor(private readonly savedSearchService: SavedSearchService) {}

  @Mutation(() => CreateSavedSearchPayload)
  async createSavedSearch(
    @Context() context: RequestContext,
    @Args('input') input: CreateSavedSearchInput,
  ): Promise<CreateSavedSearchPayload> {
    const serviceContext = toServiceContext(context);

    if (input.entityTypes) {
      input.entityTypes.map((entity) => {
        if (!isIndexableEntity(entity)) {
          throw new BadRequestException(`Entity type ${entity} is not valid`);
        }
      });
    }

    const entity = await this.savedSearchService.create(serviceContext, {
      name: input.name,
      description: input.description,
      query: input.query,
      entityTypes: input.entityTypes,
      tags: input.tags,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      savedSearch: entity ? SavedSearchType.toType(entity) : undefined,
    };
  }

  @Mutation(() => UpdateSavedSearchPayload)
  async updateSavedSearch(
    @Context() context: RequestContext,
    @Args('input') input: UpdateSavedSearchInput,
  ): Promise<UpdateSavedSearchPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('saved-search', input.id);

    const entity = await this.savedSearchService.update(serviceContext, id, {
      name: input.name,
      description: input.description,
      query: input.query,
      entityTypes: input.entityTypes,
      tags: input.tags,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      savedSearch: entity ? SavedSearchType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteSavedSearch(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('saved-search', input.id);

    const success = await this.savedSearchService.remove(serviceContext, id);

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

  @Query(() => SavedSearchConnection)
  async savedSearches(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<SavedSearchConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.savedSearchService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('saved-search', entity.id),
    });

    const edges: SavedSearchEdge[] = slice.map((entity) => {
      const node = SavedSearchType.toType(entity);

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

  @Query(() => SavedSearchType, { nullable: true })
  async savedSearch(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<SavedSearchType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('saved-search', gid);

    const entity = await this.savedSearchService.findById(serviceContext, id);

    return entity ? SavedSearchType.toType(entity) : null;
  }
}

function isIndexableEntity(type: string): type is IndexableEntity {
  return INDEXABLE_ENTITIES.includes(type as IndexableEntity);
}

import { BadRequestException, UseGuards } from '@nestjs/common';
import { Mutation, Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
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
import { SetSavedSearchSharingInput } from '../types/SetSavedSearchSharingInput';
import { UpdateSavedSearchInput } from '../types/UpdateSavedSearchInput';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => SavedSearchType)
export class SavedSearchResolver {
  constructor(
    private readonly savedSearchService: SavedSearchService,
    private readonly featureService: FeatureService,
  ) {}

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
      filters: input.filters,
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
      filters: input.filters,
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
  async setSavedSearchSharing(
    @Context() context: RequestContext,
    @Args('input') input: SetSavedSearchSharingInput,
  ): Promise<UpdateSavedSearchPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('saved-search', input.id);

    const entity = await this.savedSearchService.setSharing(serviceContext, id, input.isPublic);

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      savedSearch: SavedSearchType.toType(entity),
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

    // First visit (or a fresh Memory) gets the starter library. No-ops when the
    // user already has any saved search, so a reboot cannot duplicate seeds.
    await this.savedSearchService.ensureDefaults(serviceContext);

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

  /**
   * Resolve a shared saved search by its capability token (the `/shared/<token>`
   * link). Guarded like everything else — sharing is limited to signed-in users —
   * but not owner-scoped: any authenticated viewer holding a valid token gets the
   * search definition (name/description/filters) to drive the read-only viewer.
   * Returns null for unknown/revoked tokens.
   */
  @Query(() => SavedSearchType, { nullable: true })
  async sharedSavedSearch(@Args('token') token: string): Promise<SavedSearchType | null> {
    // Gated behind 'shared.search': while the access model is being hardened the
    // shared-URL surface stays dark. Disabled resolves to null — indistinguishable
    // from an unknown/revoked token — so the viewer shows "link unavailable".
    if (!(await this.featureService.isFeatureEnabled('shared.search'))) {
      return null;
    }

    const entity = await this.savedSearchService.findByShareToken(token);

    if (entity == null) {
      return null;
    }

    // Never echo the capability token back on the viewer path — the holder
    // already has it, and reflecting it only widens where the secret lands
    // (logs, response bodies, client caches). The owner-scoped savedSearch /
    // setSavedSearchSharing paths remain the only places shareToken is exposed.
    return { ...SavedSearchType.toType(entity), shareToken: null };
  }
}

function isIndexableEntity(type: string): type is IndexableEntity {
  return INDEXABLE_ENTITIES.includes(type as IndexableEntity);
}

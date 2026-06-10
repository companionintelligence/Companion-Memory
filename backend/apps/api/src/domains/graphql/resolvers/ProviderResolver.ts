import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver, ResolveField, Parent } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ClientFactory, ProviderKeyService, ProviderService } from '@ci/domains/connections';

import { ProviderKeyLoader } from '../loaders/ProviderKeyLoader';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { ProviderConnection } from '../types/ProviderConnection';
import { ProviderEdge } from '../types/ProviderEdge';
import { ProviderKeyType } from '../types/ProviderKeyType';
import { ProviderType } from '../types/ProviderType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ProviderType)
export class ProviderResolver {
  constructor(
    private readonly providerService: ProviderService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly providerKeyLoader: ProviderKeyLoader,
    private readonly clientFactory: ClientFactory,
  ) {}

  @Query(() => ProviderConnection)
  async providers(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ProviderConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.providerService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('provider', entity.id),
    });

    const edges: ProviderEdge[] = slice.map((entity) => {
      const node = ProviderType.toType(entity);

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

  @Query(() => ProviderType, { nullable: true })
  async provider(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ProviderType | null> {
    const serviceContext = toServiceContext(context);
    const { id: decodedId } = GlobalUID.decode(id);

    const entity = await this.providerService.findById(serviceContext, decodedId);

    return entity ? ProviderType.toType(entity) : null;
  }

  @Query(() => String)
  oAuthCallbackUrl(): string {
    return this.providerService.getOAuthCallbackUrl();
  }

  @ResolveField(() => ProviderKeyType, { nullable: true })
  async providerKeys(
    @Context() context: RequestContext,
    @Parent() provider: ProviderType,
  ): Promise<ProviderKeyType | null> {
    const serviceContext = toServiceContext(context);
    const { id: decodedId } = GlobalUID.decode(provider.id);

    const providerKeys = await this.providerKeyService.findByProviderId(serviceContext, decodedId);

    if (!providerKeys) {
      return null;
    }

    const providerKeyLoad = await this.providerKeyLoader.load(serviceContext, providerKeys.id);

    return ProviderKeyType.toType(providerKeyLoad!);
  }

  @ResolveField(() => [String], { nullable: true })
  scopes(@Parent() provider: ProviderType): string[] | null {
    const { id: decodedId } = GlobalUID.decode(provider.id);

    try {
      // Steam (and other OpenID providers) have no scopes — getScopes() returns null.
      return this.clientFactory.getClientByProviderId(decodedId).getScopes();
    } catch {
      // No client registered for this provider id.
      return null;
    }
  }
}

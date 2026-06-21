import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ConnectionService } from '@ci/domains/connections';

import { ProviderLoader } from '../loaders/ProviderLoader';
import { ConnectionConnection } from '../types/ConnectionConnection';
import { ConnectionEdge } from '../types/ConnectionEdge';
import { ConnectionType } from '../types/ConnectionType';
import { CreateConnectionInput } from '../types/CreateConnectionInput';
import { CreateConnectionPayload } from '../types/CreateConnectionPayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { ProviderType } from '../types/ProviderType';
import { UpdateConnectionInput } from '../types/UpdateConnectionInput';
import { UpdateConnectionPayload } from '../types/UpdateConnectionPayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ConnectionType)
export class ConnectionResolver {
  constructor(
    private readonly connectionService: ConnectionService,
    private readonly providerLoader: ProviderLoader,
  ) {}

  @Mutation(() => CreateConnectionPayload)
  async createConnection(
    @Context() context: RequestContext,
    @Args('input') input: CreateConnectionInput,
  ): Promise<CreateConnectionPayload> {
    const serviceContext = toServiceContext(context);

    const entity = await this.connectionService.create(serviceContext, {
      name: input.name,
      schedule: input.schedule || undefined,
      endpoints: input.activeEndpoints || [],
      providerId: input.providerId,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      connection: entity ? ConnectionType.toType(entity) : undefined,
    };
  }

  @Mutation(() => UpdateConnectionPayload)
  async updateConnection(
    @Context() context: RequestContext,
    @Args('input') input: UpdateConnectionInput,
  ): Promise<UpdateConnectionPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('connection', input.id);

    const entity = await this.connectionService.update(serviceContext, id, {
      name: input.name ? input.name : undefined,
      active: input.active,
      schedule: input.schedule ? input.schedule : undefined,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      tokenExpiry: input.tokenExpiry,
      syncState: input.syncState,
      endpoints: input.activeEndpoints,
      needsReauth: input.needsReauth,
      externalId: input.externalId ? input.externalId : undefined,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      connection: entity ? ConnectionType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteConnection(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('connection', input.id);

    const success = await this.connectionService.remove(serviceContext, id);

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

  @Query(() => ConnectionConnection)
  async connections(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ConnectionConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.connectionService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('connection', entity.id),
    });

    const edges: ConnectionEdge[] = slice.map((entity) => {
      const node = ConnectionType.toType(entity);

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

  @Query(() => ConnectionType, { nullable: true })
  async connection(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ConnectionType | null> {
    const serviceContext = toServiceContext(context);
    const { id: decodedId } = GlobalUID.decode(id);

    const entity = await this.connectionService.findById(serviceContext, decodedId);

    return entity ? ConnectionType.toType(entity) : null;
  }

  @ResolveField(() => ProviderType)
  async provider(
    @Context() context: RequestContext,
    @Parent() answer: ConnectionType,
  ): Promise<ProviderType | null> {
    const serviceContext = toServiceContext(context);

    if (!answer.__source.provider?.id) {
      return null;
    }

    const provider = await this.providerLoader.load(serviceContext, answer.__source.provider.id);

    return ProviderType.toType(provider!);
  }
}

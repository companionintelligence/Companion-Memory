import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ClientFactory, ConnectionService, type Connection } from '@ci/domains/connections';
import { DataDeletionService } from '@ci/domains/privacy';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
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
    private readonly clientFactory: ClientFactory,
    private readonly dataDeletionService: DataDeletionService,
    private readonly providerLoader: ProviderLoader,
  ) {}

  @Mutation(() => CreateConnectionPayload)
  // Plain create. Despite CreateConnectionInput declaring accessToken/refreshToken
  // fields, this method never forwards them to ConnectionService.create — only
  // name/schedule/endpoints/providerId are persisted, so no credential material
  // is written here (contrast updateConnection, which does write tokens).
  @GraphqlPrivacy({ destructive: false })
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
  // Field-level patch of this connection's own row — not destructive. Flagged
  // `sensitive`, not the default `personal`, because it can write raw OAuth
  // accessToken/refreshToken values straight onto the record.
  @GraphqlPrivacy({ destructive: false, sensitivity: 'sensitive' })
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

  /**
   * Disconnect a connection: revoke its OAuth grant with the provider and
   * HARD-delete the connection plus the data derived from it (CASA ASVS V8).
   * Routes through {@link DataDeletionService} — the same owner-scoped,
   * audit-logged purge as the REST DELETE /connections/:id — so this GraphQL
   * path no longer leaves the token stored and derived data orphaned.
   */
  @Mutation(() => DeleteByIdPayload)
  // Per the method's own doc comment above: DataDeletionService.disconnectConnection
  // revokes the OAuth grant WITH THE PROVIDER (an external call) and then
  // hard-deletes the connection plus its derived data, with no restore path.
  @GraphqlPrivacy({ access: 'delete', destructive: true, external: true })
  async deleteConnection(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('connection', input.id);

    // Throws NotFoundException if the connection is not owned by the caller.
    await this.dataDeletionService.disconnectConnection(serviceContext, id);

    return {
      success: true,
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

  @ResolveField(() => String, { nullable: true })
  async accountLabel(@Parent() connection: ConnectionType): Promise<string | null> {
    if (connection.__source.accountLabel) {
      return connection.__source.accountLabel;
    }

    try {
      const source = await this.withFreshAccessToken(connection.__source);
      const label = await this.clientFactory.getClientByProviderId(source.providerId).getAccountLabel(source);
      if (!label) {
        return null;
      }

      await this.connectionService.update({ userId: source.userId }, source.id, { accountLabel: label });

      return label;
    } catch {
      return null;
    }
  }

  private async withFreshAccessToken(connection: Connection): Promise<Connection> {
    const expired = !connection.tokenExpiry || new Date(connection.tokenExpiry) < new Date();
    if (!connection.refreshToken || !expired) {
      return connection;
    }

    const client = this.clientFactory.getClientByProviderId(connection.providerId);
    const refreshed = await client.refreshAccessToken(connection);
    const credentials =
      refreshed.refreshToken == null
        ? { accessToken: refreshed.accessToken, tokenExpiry: refreshed.tokenExpiry }
        : refreshed;

    return (
      (await this.connectionService.update({ userId: connection.userId }, connection.id, credentials)) ?? {
        ...connection,
        ...credentials,
      }
    );
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

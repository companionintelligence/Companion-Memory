import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ConnectionSyncJobService } from '@ci/domains/etl';

import { ConnectionLoader } from '../loaders/ConnectionLoader';
import { ConnectionSyncJobConnection } from '../types/ConnectionSyncJobConnection';
import { ConnectionSyncJobEdge } from '../types/ConnectionSyncJobEdge';
import { ConnectionSyncJobType } from '../types/ConnectionSyncJobType';
import { ConnectionType } from '../types/ConnectionType';
import { CreateConnectionSyncJobInput } from '../types/CreateConnectionSyncJobInput';
import { CreateConnectionSyncJobPayload } from '../types/CreateConnectionSyncJobPayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateConnectionSyncJobInput } from '../types/UpdateConnectionSyncJobInput';
import { UpdateConnectionSyncJobPayload } from '../types/UpdateConnectionSyncJobPayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ConnectionSyncJobType)
export class ConnectionSyncJobResolver {
  constructor(
    private readonly connectionSyncJobService: ConnectionSyncJobService,
    private readonly connectionLoader: ConnectionLoader,
  ) {}

  @Mutation(() => CreateConnectionSyncJobPayload)
  async createConnectionSyncJob(
    @Context() context: RequestContext,
    @Args('input') input: CreateConnectionSyncJobInput,
  ): Promise<CreateConnectionSyncJobPayload> {
    const serviceContext = toServiceContext(context);

    const userId = input.userId ? GlobalUID.parse('user', input.userId) : serviceContext.userId;
    const connectionId = GlobalUID.parse('connection', input.connectionId);

    const entity = await this.connectionSyncJobService.create(serviceContext, {
      id: input.id,
      userId,
      connectionId,
      jobId: input.jobId,
      endpointName: input.endpointName,
      status: input.status,
      data: input.data,
      type: input.type,
      cursor: input.cursor,
      nextCursor: input.nextCursor,
      properties: input.properties,
      error: input.error,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      connectionSyncJob: entity ? ConnectionSyncJobType.toType(entity) : undefined,
    };
  }

  @Mutation(() => UpdateConnectionSyncJobPayload)
  async updateConnectionSyncJob(
    @Context() context: RequestContext,
    @Args('input') input: UpdateConnectionSyncJobInput,
  ): Promise<UpdateConnectionSyncJobPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('connectionSyncJob', input.id);

    const entity = await this.connectionSyncJobService.update(serviceContext, id, {
      jobId: input.jobId,
      endpointName: input.endpointName,
      status: input.status,
      data: input.data,
      type: input.type,
      cursor: input.cursor,
      nextCursor: input.nextCursor,
      properties: input.properties,
      error: input.error,
      completedAt: input.completedAt,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      connectionSyncJob: entity ? ConnectionSyncJobType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteConnectionSyncJob(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('connectionSyncJob', input.id);

    const success = await this.connectionSyncJobService.delete(serviceContext, id);

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

  @Query(() => ConnectionSyncJobConnection)
  async connectionSyncJobs(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
    @Args('connectionId', { type: () => ID, nullable: true }) connectionId?: string,
    @Args('endpointName', { type: () => String, nullable: true }) endpointName?: string,
    @Args('type', { type: () => String, nullable: true }) type?: string,
  ): Promise<ConnectionSyncJobConnection> {
    const serviceContext = toServiceContext(context);

    let entities;
    if (connectionId) {
      const decodedConnectionId = GlobalUID.parse('connection', connectionId);
      entities = await this.connectionSyncJobService.findByConnectionId(
        serviceContext,
        decodedConnectionId,
        endpointName ?? undefined,
        type ?? undefined,
      );
    } else {
      entities = await this.connectionSyncJobService.findAll(serviceContext);
    }

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('connectionSyncJob', entity.id),
    });

    const edges: ConnectionSyncJobEdge[] = slice.map((entity) => {
      const node = ConnectionSyncJobType.toType(entity);

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

  @Query(() => ConnectionSyncJobType, { nullable: true })
  async connectionSyncJob(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ConnectionSyncJobType | null> {
    const serviceContext = toServiceContext(context);
    const { id: decodedId } = GlobalUID.decode(id);

    const entity = await this.connectionSyncJobService.findById(serviceContext, decodedId);

    return entity ? ConnectionSyncJobType.toType(entity) : null;
  }

  @ResolveField(() => ConnectionType, { nullable: true })
  async connection(
    @Context() context: RequestContext,
    @Parent() syncJob: ConnectionSyncJobType,
  ): Promise<ConnectionType | null> {
    const serviceContext = toServiceContext(context);

    if (!syncJob.__source.connection?.id) {
      return null;
    }

    const connection = await this.connectionLoader.load(serviceContext, syncJob.__source.connection.id);

    return connection ? ConnectionType.toType(connection) : null;
  }
}

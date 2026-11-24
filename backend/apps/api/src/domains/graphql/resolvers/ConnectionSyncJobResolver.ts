import { ForbiddenException, NotFoundException, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ConnectionSyncJobService } from '@ci/domains/etl';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
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
  // Plain create: inserts one new sync-job row.
  @GraphqlPrivacy({ destructive: false })
  async createConnectionSyncJob(
    @Context() context: RequestContext,
    @Args('input') input: CreateConnectionSyncJobInput,
  ): Promise<CreateConnectionSyncJobPayload> {
    const serviceContext = toServiceContext(context);

    // A sync job is only ever the caller's own. The fetch runs on the
    // connection's credentials and the transform files what it fetched under the
    // job's `userId`: a job naming another user put the caller's provider data
    // in that user's memory, and a job on another user's connection pulled that
    // user's provider data into the caller's.
    if (input.userId && GlobalUID.parse('user', input.userId) !== serviceContext.userId) {
      throw new ForbiddenException('A sync job can only be created for the signed-in user');
    }

    const connectionId = GlobalUID.parse('connection', input.connectionId);

    // Scoped to the caller, so another user's connection reads as absent.
    if ((await this.connectionLoader.load(serviceContext, connectionId)) == null) {
      throw new NotFoundException(`Connection ${input.connectionId} not found`);
    }

    const entity = await this.connectionSyncJobService.create(serviceContext, {
      id: input.id,
      userId: serviceContext.userId,
      connectionId,
      jobId: input.jobId,
      endpointName: input.endpointName,
      type: input.type,
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
  // Patches only this job's own descriptive fields; status, data and cursors
  // are the sync executor's. The row stays intact throughout.
  @GraphqlPrivacy({ destructive: false })
  async updateConnectionSyncJob(
    @Context() context: RequestContext,
    @Args('input') input: UpdateConnectionSyncJobInput,
  ): Promise<UpdateConnectionSyncJobPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('connectionSyncJob', input.id);

    const entity = await this.connectionSyncJobService.update(serviceContext, id, {
      jobId: input.jobId,
      endpointName: input.endpointName,
      type: input.type,
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
  // ConnectionSyncJobService.delete does a HARD `repository.delete` — the row
  // is gone with no restore path in the schema.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
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

import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import type { RequestContext, ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  ClientFactory,
  ConnectionService,
  getProviderCatalogByProviderId,
  type Connection,
  type SyncResponse,
} from '@ci/domains/connections';
import { OnEvent, Events, EventPayloads } from '@ci/domains/events';

import { ApiLogEntity } from '../entities/ApiLogEntity';
import { createConnectionSyncResponseAdapter } from '../pipeline/adapters/ConnectionSyncResponseAdapters';
import { ConnectionPipelineOrchestrator } from '../pipeline/ConnectionPipelineOrchestrator';

@Injectable()
export class EtlService {
  constructor(
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
    private readonly clientFactory: ClientFactory,
    private readonly connectionService: ConnectionService,
    private readonly connectionPipelineOrchestrator: ConnectionPipelineOrchestrator,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EtlService.name);
  }

  /**
   * Main entry point for ETL sync - handles sync for any connection type
   */
  async handleConnectionSync(context: RequestContext, connectionId: string): Promise<void> {
    this.logger.log('Starting ETL sync for connection', {
      connectionId,
      userId: context.userId,
    });

    if (context.userId == null) {
      this.logger.log('Attempted to sync connection without user id');

      throw new UnauthorizedException();
    }

    const connection = await this.connectionService.findById({ userId: context.userId }, connectionId);

    if (!connection) {
      this.logger.error('Connection not found', { connectionId });

      return;
    }

    this.validateConnectionEndpointSelection(connection);

    // Validate connection
    if (!this.isConnectionValid(connection)) {
      this.logger.warn('Skipping sync for invalid connection', { connectionId });

      return;
    }

    // Perform sync
    const syncResponses = await this.syncConnection(context, connection.id);
    const updatedSyncState = await this.processSyncResponses(context, connection, syncResponses);

    // Update sync state if there are changes
    if (Object.keys(updatedSyncState).length > 0) {
      await this.updateSyncState({ userId: context.userId }, connection.id, updatedSyncState);
    }
  }

  private async syncConnection(context: RequestContext, connectionId: string) {
    this.logger.log('Starting manual sync for connection', {
      connectionId,
      userId: context.userId,
    });

    if (context.userId == null) {
      this.logger.log('Attempted to sync connection without user id');

      throw new UnauthorizedException();
    }

    let connection = await this.connectionService.findById({ userId: context.userId }, connectionId);

    if (connection == null) {
      this.logger.log('Attempted to sync a connection that could not be found');

      throw new NotFoundException();
    }

    const { refreshToken, tokenExpiry } = connection;
    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    if (refreshToken && tokenExpiry && new Date(tokenExpiry) < new Date()) {
      let newCredentials;
      const refreshCredentials = await client.refreshAccessToken(connection);

      //Some providers explicitly return null for refreshToken, which was overwriting the
      //existing refreshToken. Strip it out in those cases.
      if (refreshCredentials.refreshToken == null) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { refreshToken, ...stripped } = refreshCredentials;
        newCredentials = stripped;
      } else {
        newCredentials = { ...refreshCredentials };
      }

      connection = await this.connectionService.update({ userId: context.userId }, connectionId, {
        ...newCredentials,
      });
    }

    if (connection == null) {
      this.logger.log('Attempted to sync a connection that could not be found');

      throw new NotFoundException();
    }

    const syncResponses = await client.sync(connection);

    // Aggregate results from all endpoint syncs
    const allSuccessful = syncResponses.every((response) => response.success);
    const totalResults = syncResponses.reduce(
      (sum, response) => sum + (response.data?.results?.length || 0),
      0,
    );
    const totalErrors = syncResponses.reduce(
      (sum, response) => sum + (response.data?.errors?.length || 0),
      0,
    );

    this.logger.log('Sync completed', {
      connectionId,
      userId: context.userId,
      success: allSuccessful,
      totalEndpoints: syncResponses.length,
      totalResults,
      totalErrors,
    });

    // Return the array of responses as requested
    return syncResponses;
  }

  private isConnectionValid(connection: Connection): boolean {
    return (
      connection.active &&
      !!connection.accessToken &&
      !(connection.tokenExpiry && connection.tokenExpiry < new Date() && !connection.refreshToken) &&
      !!connection.provider?.id
    );
  }

  private validateConnectionEndpointSelection(connection: Connection): void {
    const providerCatalog = getProviderCatalogByProviderId(connection.providerId);
    if (!providerCatalog) {
      return;
    }

    const knownStreamKeys = new Set(providerCatalog.streams.map((stream) => stream.key));
    const unknownSelections = connection.activeEndpoints.filter((endpoint) => !knownStreamKeys.has(endpoint));

    if (unknownSelections.length > 0) {
      this.logger.warn('Connection has endpoint selections not present in provider catalog', {
        connectionId: connection.id,
        providerId: connection.providerId,
        unknownSelections,
      });
    }
  }

  private async updateSyncState(
    context: ServiceContext,
    connectionId: string,
    syncState: Record<string, unknown>,
  ): Promise<void> {
    const entity = await this.connectionService.findById(context, connectionId);

    if (entity == null) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    const existingSyncState = entity.syncState || {};
    const mergedSyncState = {
      ...existingSyncState,
      ...syncState,
      lastSyncedAt: new Date().toISOString(),
    };

    await this.connectionService.update(entity, connectionId, {
      syncState: mergedSyncState,
    });
  }

  private async processSyncResponses(
    context: RequestContext,
    connection: Connection,
    syncResponses: SyncResponse[],
  ): Promise<Record<string, unknown>> {
    const providerCatalog = getProviderCatalogByProviderId(connection.providerId);
    if (!providerCatalog) {
      return this.processSyncResponsesLegacy(context, connection, syncResponses);
    }

    const adapter = createConnectionSyncResponseAdapter(providerCatalog, syncResponses);
    const pipelineResult = await this.connectionPipelineOrchestrator.run(adapter, {
      request: context,
      connection: {
        id: connection.id,
        providerId: connection.providerId,
        userId: connection.userId,
        activeEndpoints: connection.activeEndpoints,
        syncState: connection.syncState,
      },
    });

    if (pipelineResult.transform.records.length > 0) {
      await this.saveApiLogs(
        context,
        connection,
        pipelineResult.transform.records.map((record) => ({
          api: record.scope,
          data: record.payload,
        })),
      );
    }

    return pipelineResult.extract.checkpoint;
  }

  private async processSyncResponsesLegacy(
    context: RequestContext,
    connection: Connection,
    syncResponses: SyncResponse[],
  ): Promise<Record<string, unknown>> {
    let updatedSyncState: Record<string, unknown> = {};

    for (const syncResponse of syncResponses) {
      if (syncResponse.success && syncResponse.data?.results) {
        await this.saveApiLogs(context, connection, syncResponse.data.results);
      }

      if (syncResponse.cursor) {
        updatedSyncState = { ...updatedSyncState, ...(syncResponse.cursor as Record<string, unknown>) };
      }
    }

    return updatedSyncState;
  }

  private async saveApiLogs(
    context: RequestContext,
    connection: Connection,
    results: Array<{ api: string; data: unknown; syncState?: Record<string, unknown> }>,
  ): Promise<void> {
    if (results.length === 0) {
      return;
    }

    const entities = results.map((result) =>
      this.apiLogRepository.create({
        id: uuid7(),
        user_id: context.userId || '',
        connection_id: connection.id,
        scope: result.api,
        content: result.data,
      }),
    );

    await this.apiLogRepository.save(entities);
  }

  @OnEvent(Events.SYNC_CONNECTION)
  async handleSyncEvent(payload: EventPayloads[Events.SYNC_CONNECTION]) {
    if (!payload.userId) {
      this.logger.warn('SYNC_CONNECTION payload missing userId', { payload });

      return;
    }

    await this.handleConnectionSync({ userId: payload.userId } as RequestContext, payload.connectionId);
  }
}

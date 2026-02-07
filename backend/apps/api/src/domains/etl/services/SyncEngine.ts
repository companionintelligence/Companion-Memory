import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import type { RequestContext } from '@ci/common/context';
import type { Connection } from '@ci/domains/connections';

import type { ProviderConfig, ProviderSource } from '../types/provider';
import type { ConnectionSyncResult, SourceSyncResult, SyncOptions } from '../types/sync';
import { ProviderRegistry } from './ProviderRegistry';
import { ApiClient } from './ApiClient';
import { TransformEngine } from './TransformEngine';
import { RateLimiter } from './RateLimiter';
import { ApiSpecEntity } from '../entities/ApiSpecEntity';
import { TransformMapEntity } from '../entities/TransformMapEntity';

/**
 * SyncEngine orchestrates the ETL sync workflow.
 * It coordinates fetching data from APIs and transforming it.
 */
@Injectable()
export class SyncEngine {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly apiClient: ApiClient,
    private readonly transformEngine: TransformEngine,
    private readonly rateLimiter: RateLimiter,
    @InjectRepository(ApiSpecEntity)
    private readonly apiSpecRepository: Repository<ApiSpecEntity>,
    @InjectRepository(TransformMapEntity)
    private readonly transformMapRepository: Repository<TransformMapEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SyncEngine.name);
  }

  /**
   * Sync a connection - fetch and transform data from all active sources
   */
  async syncConnection(
    context: RequestContext,
    connection: Connection,
    options?: SyncOptions,
  ): Promise<ConnectionSyncResult> {
    const startTime = new Date();
    this.logger.log('Starting connection sync', {
      connectionId: connection.id,
      userId: context.userId,
    });

    try {
      // Get provider configuration
      const provider = await this.providerRegistry.getProvider(context, connection.providerId);
      if (!provider) {
        throw new Error(`Provider not found: ${connection.providerId}`);
      }

      // Get active sources to sync
      const sources = this.getActiveSources(provider, connection.activeEndpoints);

      // Sync each source
      const sourceResults: SourceSyncResult[] = [];
      for (const source of sources) {
        try {
          const result = await this.syncSource(context, connection, source, provider);
          sourceResults.push(result);
        } catch (error) {
          this.logger.error(`Source sync failed: ${source.name}`, { error });
          sourceResults.push({
            source: source.name,
            records: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          // Continue on error if configured
          if (!options?.continueOnError) {
            break;
          }
        }
      }

      const endTime = new Date();
      const totalRecords = sourceResults.reduce((sum, r) => sum + r.records, 0);
      const allSuccess = sourceResults.every((r) => r.success);

      return {
        connectionId: connection.id,
        success: allSuccess,
        sources: sourceResults,
        totalRecords,
        startedAt: startTime,
        completedAt: endTime,
        duration: endTime.getTime() - startTime.getTime(),
      };
    } catch (error) {
      const endTime = new Date();
      this.logger.error('Connection sync failed', { error, connectionId: connection.id });

      return {
        connectionId: connection.id,
        success: false,
        sources: [],
        totalRecords: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
        startedAt: startTime,
        completedAt: endTime,
        duration: endTime.getTime() - startTime.getTime(),
      };
    }
  }

  /**
   * Sync a single source
   */
  private async syncSource(
    context: RequestContext,
    connection: Connection,
    source: ProviderSource,
    provider: ProviderConfig,
  ): Promise<SourceSyncResult> {
    this.logger.log(`Syncing source: ${source.name}`, { connectionId: connection.id });

    try {
      // 1. Get API spec for provider
      const apiSpecEntity = await this.apiSpecRepository.findOne({
        where: { id: provider.apiSpecId },
      });

      if (!apiSpecEntity) {
        throw new Error(`API spec not found: ${provider.apiSpecId}`);
      }

      const apiSpec = ApiSpecEntity.toEgressType(apiSpecEntity);
      let totalRecords = 0;

      // 2. For each endpoint in source.endpoints
      for (const endpointName of source.endpoints) {
        const endpoint = apiSpec.endpoints[endpointName];
        if (!endpoint) {
          this.logger.warn(`Endpoint not found: ${endpointName}`);
          continue;
        }

        // Apply rate limiting
        const rateLimitKey = `${provider.id}:${endpointName}`;
        await this.rateLimiter.wait(rateLimitKey, endpoint.rateLimit || apiSpec.globalRateLimit);

        // Fetch data using ApiClient
        const rawData = await this.apiClient.fetch(connection, endpoint, apiSpec.baseUrl);

        if (rawData.length === 0) {
          this.logger.debug(`No data from endpoint: ${endpointName}`);
          continue;
        }

        // Get transform map for this source
        const transformMapEntity = await this.transformMapRepository.findOne({
          where: { id: source.transformMap, enabled: true },
        });

        if (!transformMapEntity) {
          this.logger.warn(`Transform map not found: ${source.transformMap}`);
          continue;
        }

        const transformMap = TransformMapEntity.toEgressType(transformMapEntity);

        // Transform data using TransformEngine
        const transformResult = await this.transformEngine.transform(rawData, transformMap);

        if (!transformResult.success) {
          this.logger.error(`Transform errors for ${endpointName}`, {
            errors: transformResult.errors,
          });
        }

        // TODO: Save transformed data to database
        // This would depend on the target type (Communication, Event, Content, etc.)
        // For now, just count the records
        totalRecords += transformResult.data.length;

        this.logger.log(`Synced ${transformResult.data.length} records from ${endpointName}`);
      }

      // 3. Update sync state
      const newSyncState = {
        ...connection.syncState,
        [source.name]: {
          lastSyncedAt: new Date().toISOString(),
          recordCount: totalRecords,
        },
      };

      await this.updateSyncState(connection, newSyncState);

      // 4. Return result
      return {
        source: source.name,
        records: totalRecords,
        success: true,
        syncState: newSyncState[source.name],
      };
    } catch (error) {
      this.logger.error(`Source sync failed: ${source.name}`, { error });
      return {
        source: source.name,
        records: 0,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get active sources based on connection's active endpoints
   */
  private getActiveSources(provider: ProviderConfig, activeEndpoints: string[]): ProviderSource[] {
    return provider.sources.filter((source) => activeEndpoints.includes(source.name));
  }

  /**
   * Update sync state for a connection
   */
  private async updateSyncState(
    connection: Connection,
    syncState: Record<string, unknown>,
  ): Promise<void> {
    // Update connection's sync state
    // This would typically be done through ConnectionService
    // For now, just log it
    this.logger.debug('Sync state updated', {
      connectionId: connection.id,
      syncState,
    });

    // TODO: Persist sync state to database via ConnectionService
    // connection.syncState = syncState;
    // await connectionService.update(connection.id, { syncState });
  }
}

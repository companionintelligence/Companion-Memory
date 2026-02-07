import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import type { RequestContext } from '@ci/common/context';
import type { Connection } from '@ci/domains/connections';

import type { ProviderConfig, ProviderSource } from '../types/provider';
import type { ConnectionSyncResult, SourceSyncResult, SyncOptions } from '../types/sync';
import { ProviderRegistry } from './ProviderRegistry';
import { ApiClient } from './ApiClient';
import { TransformEngine } from './TransformEngine';

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

    // TODO: Implement source sync logic
    // 1. Get API spec for provider
    // 2. For each endpoint in source.endpoints
    //    - Fetch data using ApiClient
    //    - Transform data using TransformEngine
    //    - Save to database
    // 3. Update sync state
    // 4. Return result

    throw new Error('SyncEngine.syncSource not yet implemented');
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
    // TODO: Implement sync state update
    throw new Error('Not implemented');
  }
}

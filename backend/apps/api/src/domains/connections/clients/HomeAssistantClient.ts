import type { Connection } from '../types';

import { BaseApiClient } from './BaseApiClient';
import type { SyncResult, SyncResponse } from './types';

export class HomeAssistantClient extends BaseApiClient {
  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Home Assistant data', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];

    // Get system info
    try {
      const systemInfo = await this.request(connection, '/api/config');

      syncResults.push({
        api: 'Home Assistant - System Info',
        data: systemInfo,
      });
    } catch (error) {
      const errorMsg = `Home Assistant System Info API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Get states (all entities)
    try {
      const states = await this.request(connection, '/api/states');

      syncResults.push({
        api: 'Home Assistant - States',
        data: states,
      });
    } catch (error) {
      const errorMsg = `Home Assistant States API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Get services
    try {
      const services = await this.request(connection, '/api/services');

      syncResults.push({
        api: 'Home Assistant - Services',
        data: services,
      });
    } catch (error) {
      const errorMsg = `Home Assistant Services API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Get history for the last 24 hours
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const history = await this.request(connection, `/api/history/period/${yesterday}`);

      syncResults.push({
        api: 'Home Assistant - History',
        data: history,
      });
    } catch (error) {
      const errorMsg = `Home Assistant History API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    return {
      success: errors.length === 0,
      message: `Home Assistant sync completed. ${syncResults.length} APIs processed successfully. ${errors.length} errors occurred.`,
      data: {
        results: syncResults,
        errors,
      },
    };
  }
}
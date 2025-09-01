import type { Connection } from '../types';

import { BaseApiClient } from './BaseApiClient';
import type { SyncResult, SyncResponse } from './types';

export class SipeedClient extends BaseApiClient {
  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Sipeed camera data', { connectionId: connection.id });

    const syncResults: SyncResult[] = [];
    const errors: string[] = [];

    // Get camera status
    try {
      const status = await this.request(connection, '/api/status');

      syncResults.push({
        api: 'Sipeed Camera - Status',
        data: status,
      });
    } catch (error) {
      const errorMsg = `Sipeed Camera Status API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Get camera configuration
    try {
      const config = await this.request(connection, '/api/config');

      syncResults.push({
        api: 'Sipeed Camera - Configuration',
        data: config,
      });
    } catch (error) {
      const errorMsg = `Sipeed Camera Configuration API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Get recent recordings/snapshots metadata
    try {
      const recordings = await this.request(connection, '/api/recordings');

      syncResults.push({
        api: 'Sipeed Camera - Recordings',
        data: recordings,
      });
    } catch (error) {
      const errorMsg = `Sipeed Camera Recordings API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    // Get motion detection events
    try {
      const motionEvents = await this.request(connection, '/api/motion-events');

      syncResults.push({
        api: 'Sipeed Camera - Motion Events',
        data: motionEvents,
      });
    } catch (error) {
      const errorMsg = `Sipeed Camera Motion Events API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      errors.push(errorMsg);
    }

    return {
      success: errors.length === 0,
      message: `Sipeed Camera sync completed. ${syncResults.length} APIs processed successfully. ${errors.length} errors occurred.`,
      data: {
        results: syncResults,
        errors,
      },
    };
  }
}
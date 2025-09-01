import type { Connection } from '../types';

import { BasePlatformClient } from './BasePlatformClient';
import type { SyncResponse } from './types';

export class AndroidClient extends BasePlatformClient {
  getConnectionInstructions(): string {
    return 'To connect your Android device:\n1. Install the Companion Intelligence Android app from the Play Store\n2. Open the app and navigate to Settings > Connect to Server\n3. Enter your server details and authenticate\n4. Grant necessary permissions for data access';
  }

  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Android device data', { connectionId: connection.id });

    // For Android, we would typically use the Android SDK or receive data through push notifications
    // This is a framework stub - actual implementation would depend on Android app integration
    return {
      success: true,
      message: 'Android device connection established. Awaiting data from Android app.',
      data: {
        results: [
          {
            api: 'Android Device',
            data: { status: 'connected', platform: 'Android', message: 'Ready to receive data from Android app' },
          },
        ],
        errors: [],
      },
    };
  }
}
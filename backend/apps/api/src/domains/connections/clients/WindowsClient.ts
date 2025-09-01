import type { Connection } from '../types';

import { BasePlatformClient } from './BasePlatformClient';
import type { SyncResponse } from './types';

export class WindowsClient extends BasePlatformClient {
  getConnectionInstructions(): string {
    return 'To connect your Windows device:\n1. Download and install the Companion Intelligence Windows app\n2. Launch the app and navigate to Settings > Server Connection\n3. Enter your server details and authenticate\n4. Allow the app to access system information and data as needed';
  }

  async sync(connection: Connection): Promise<SyncResponse> {
    this.logger.log('Syncing Windows device data', { connectionId: connection.id });

    // For Windows, we would typically use a native Windows app or Windows API integration
    // This is a framework stub - actual implementation would depend on Windows app integration
    return {
      success: true,
      message: 'Windows device connection established. Awaiting data from Windows app.',
      data: {
        results: [
          {
            api: 'Windows Device',
            data: { status: 'connected', platform: 'Windows', message: 'Ready to receive data from Windows app' },
          },
        ],
        errors: [],
      },
    };
  }
}
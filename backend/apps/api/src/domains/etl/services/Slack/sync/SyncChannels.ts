import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncSlackChannels as syncChannelsPage } from './slackApi';

export async function syncChannels({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}) {
  try {
    return await syncChannelsPage({
      connection,
      client,
      nextCursor,
    });
  } catch (err) {
    client.logger.error('Failed to sync Slack channels', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

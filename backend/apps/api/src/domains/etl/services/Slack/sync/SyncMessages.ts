import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncSlackChannelMessages } from './slackApi';

export async function syncMessages({
  connection,
  client,
  nextCursor,
  historical = false,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}) {
  try {
    return await syncSlackChannelMessages({
      connection,
      client,
      nextCursor,
      historical,
    });
  } catch (err) {
    client.logger.error('Failed to sync Slack messages', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

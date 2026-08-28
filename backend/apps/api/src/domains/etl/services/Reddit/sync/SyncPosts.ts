import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncRedditUserListing } from './redditListing';

export async function syncPosts({
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
  return syncRedditUserListing({
    connection,
    client,
    nextCursor,
    historical,
    listingKind: 'submitted',
    dataKey: 'posts',
  });
}

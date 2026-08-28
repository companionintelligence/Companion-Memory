import type { BaseClient, Connection } from '@ci/domains/connections';

import { syncRedditUserListing } from './redditListing';

export async function syncComments({
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
    listingKind: 'comments',
    dataKey: 'comments',
  });
}

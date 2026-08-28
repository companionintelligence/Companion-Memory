import type { BaseClient, Connection } from '@ci/domains/connections';

const PAGE_LIMIT = 100;

export interface RedditListingChild<T> {
  kind: string;
  data: T;
}

export interface RedditListingResponse<T> {
  kind: 'Listing';
  data: {
    after: string | null;
    before: string | null;
    dist: number;
    children: RedditListingChild<T>[];
  };
}

export interface RedditPost {
  id: string;
  name: string;
  title: string;
  selftext?: string;
  url: string;
  permalink: string;
  subreddit: string;
  author: string;
  created_utc: number;
  score: number;
  num_comments: number;
  is_self: boolean;
}

export interface RedditComment {
  id: string;
  name: string;
  body: string;
  link_title: string;
  subreddit: string;
  author: string;
  created_utc: number;
  score: number;
  permalink: string;
}

export interface RedditSavedItem {
  id: string;
  name: string;
  title?: string;
  selftext?: string;
  body?: string;
  link_title?: string;
  url?: string;
  permalink: string;
  subreddit: string;
  author: string;
  created_utc: number;
  score: number;
}

export type RedditListingKind = 'submitted' | 'comments' | 'saved';

function extractListingItems<T>(response: RedditListingResponse<T>): T[] {
  return (response.data?.children || []).map((child) => child.data);
}

function buildListingEndpoint(username: string, listingKind: RedditListingKind, after?: string) {
  const params = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    sort: 'new',
  });

  if (after) {
    params.set('after', after);
  }

  return `/user/${username}/${listingKind}?${params.toString()}`;
}

export async function syncRedditUserListing<T extends { created_utc: number }>({
  connection,
  client,
  nextCursor,
  historical,
  listingKind,
  dataKey,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
  listingKind: RedditListingKind;
  dataKey: string;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  const username = connection.externalId;

  if (!username) {
    throw new Error('Reddit connection missing username');
  }

  try {
    if (historical) {
      client.logger.log(`Performing historical Reddit ${listingKind} sync`, {
        connectionId: connection.id,
        nextCursor,
      });

      const after = nextCursor.after ? String(nextCursor.after) : undefined;
      const endpoint = buildListingEndpoint(username, listingKind, after);
      const response = (await client.request(connection, endpoint)) as RedditListingResponse<T>;
      const items = extractListingItems(response);
      const nextAfter = response.data?.after;

      client.logger.log(`Reddit ${listingKind} historical sync call completed`, {
        connectionId: connection.id,
        itemCount: items.length,
        hasNextPage: !!nextAfter,
      });

      return {
        data: {
          [dataKey]: items,
        },
        nextCursor: nextAfter
          ? {
              after: nextAfter,
            }
          : {},
      };
    }

    client.logger.log(`Performing incremental Reddit ${listingKind} sync`, {
      connectionId: connection.id,
      nextCursor,
    });

    const sinceSeconds = nextCursor.since
      ? Math.floor(new Date(String(nextCursor.since)).getTime() / 1000)
      : Math.floor(connection.createdAt.getTime() / 1000);

    const items: T[] = [];
    let after = nextCursor.after ? String(nextCursor.after) : undefined;
    let hasMore = true;

    while (hasMore) {
      const endpoint = buildListingEndpoint(username, listingKind, after);
      const response = (await client.request(connection, endpoint)) as RedditListingResponse<T>;
      const pageItems = extractListingItems(response);

      if (pageItems.length === 0) {
        break;
      }

      for (const item of pageItems) {
        if (item.created_utc < sinceSeconds) {
          hasMore = false;
          break;
        }

        items.push(item);
      }

      after = response.data?.after || undefined;

      if (!after || !hasMore) {
        break;
      }
    }

    client.logger.log(`Reddit ${listingKind} incremental sync call completed`, {
      connectionId: connection.id,
      itemCount: items.length,
    });

    return {
      data: {
        [dataKey]: items,
      },
      nextCursor: {
        since: new Date().toISOString(),
      },
    };
  } catch (err) {
    client.logger.error(`Failed to sync Reddit ${listingKind}`, {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

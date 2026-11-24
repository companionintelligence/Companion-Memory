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

/**
 * How many of the newest saved fullnames the cursor remembers. More than one,
 * so unsaving the single newest item does not make the next run walk the whole
 * listing looking for a marker that is gone.
 */
const SAVED_SEEN_MARKERS = 25;

/**
 * Incremental pass over `/user/{name}/saved`.
 *
 * ⚠ NOT BY `created_utc`. The saved listing is ordered by when the user SAVED
 * each item, and `created_utc` is when it was WRITTEN. Saving a three-day-old
 * post puts it at the top of the listing with a `created_utc` older than any
 * recent cursor, so the date cutoff the other listings use stopped on that very
 * item, before keeping it — every incremental Saved run came back empty, and
 * saves reached the archive only through a historical pass.
 *
 * Instead the cursor remembers the fullnames at the top of the listing, and a
 * run collects items until it reaches one of them. With no markers yet (the
 * first run after the historical pass, or a cursor the date-based code wrote)
 * it takes one page: anything older was covered by the historical pass, and the
 * writer upserts by fullname, so re-reading items already stored is harmless.
 */
async function syncSavedIncremental<T extends { name: string }>({
  connection,
  client,
  username,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  username: string;
  nextCursor: Record<string, unknown>;
}): Promise<{ items: T[]; nextCursor: Record<string, unknown> }> {
  const seen = new Set(
    Array.isArray(nextCursor.seen) ? nextCursor.seen.filter((n): n is string => typeof n === 'string') : [],
  );
  const items: T[] = [];
  let after: string | undefined;

  for (;;) {
    const response = (await client.request(
      connection,
      buildListingEndpoint(username, 'saved', after),
    )) as RedditListingResponse<T>;
    const pageItems = extractListingItems(response);
    const markerIndex = pageItems.findIndex((item) => seen.has(item.name));

    if (markerIndex !== -1) {
      items.push(...pageItems.slice(0, markerIndex));
      break;
    }

    items.push(...pageItems);
    after = response.data?.after || undefined;

    if (seen.size === 0 || pageItems.length === 0 || !after) {
      break;
    }
  }

  // The newest items now at the top: this run's finds, then the markers that
  // stopped it, which are still below them.
  const newest = [...items.map((item) => item.name), ...seen].slice(0, SAVED_SEEN_MARKERS);

  return { items, nextCursor: { seen: newest } };
}

export async function syncRedditUserListing<T extends { created_utc: number; name: string }>({
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

    if (listingKind === 'saved') {
      const saved = await syncSavedIncremental<T>({ connection, client, username, nextCursor });

      client.logger.log(`Reddit ${listingKind} incremental sync call completed`, {
        connectionId: connection.id,
        itemCount: saved.items.length,
      });

      return { data: { [dataKey]: saved.items }, nextCursor: saved.nextCursor };
    }

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

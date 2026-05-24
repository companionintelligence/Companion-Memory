import type { BaseClient, Connection } from '@ci/domains/connections';

interface YouTubeResponse {
  items: YouTubeItem[];
  nextPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  [key: string]: unknown;
}
interface YouTubeItem {
  id: string;
  snippet?: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
  items: YouTubeItem[];
  [key: string]: unknown;
}

export async function syncYouTubePlaylists({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing historical YouTube sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      maxResults: '50',
      mine: 'true',
    });

    if (nextCursor.pageToken) {
      params.set('pageToken', nextCursor.pageToken as string);
    }

    const endpoint = `/youtube/v3/playlists?${params.toString()}`;
    const response = (await client.request(connection, endpoint)) as Record<string, unknown>;
    const playlists = (response.items as YouTubeItem[]) || [];
    const nextPageToken = response.nextPageToken as string | undefined;

    for (const playlist of playlists) {
      //We fully paginate each playlist, which does not run much risk of hitting rate limits.
      //But each syncJob only processes one page of playlists.
      const playlistItems = await fetchAllPlaylistItems({ connection, playlist, client });
      playlist.items = (playlistItems as YouTubeItem[]) || [];
    }

    client.logger.log('YouTube playlists sync completed', {
      connectionId: connection.id,
      playlistCount: playlists.length,
      hasNextPage: !!nextPageToken,
    });

    return {
      data: { items: playlists },
      nextCursor: nextPageToken ? { pageToken: nextPageToken } : {},
    };
  } catch (err) {
    client.logger.error('Error during YouTube Playlists sync', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    throw err;
  }
}

async function fetchAllPlaylistItems({
  connection,
  playlist,
  client,
  items = [],
  pageToken,
}: {
  connection: Connection;
  playlist: YouTubeItem;
  client: BaseClient;
  items?: YouTubeItem[];
  pageToken?: string;
}): Promise<YouTubeItem[]> {
  const itemsParams = new URLSearchParams({
    part: 'snippet,contentDetails',
    maxResults: '50',
    playlistId: playlist.id,
  });

  if (pageToken) {
    itemsParams.set('pageToken', pageToken);
  }

  const itemsEndpoint = `/youtube/v3/playlistItems?${itemsParams.toString()}`;

  const playlistItemsResponse = (await client.request(connection, itemsEndpoint)) as YouTubeResponse;

  items = items.concat(playlistItemsResponse.items);

  return playlistItemsResponse.nextPageToken
    ? await fetchAllPlaylistItems({
        connection,
        playlist,
        items,
        client,
        pageToken: playlistItemsResponse.nextPageToken,
      })
    : items;
}

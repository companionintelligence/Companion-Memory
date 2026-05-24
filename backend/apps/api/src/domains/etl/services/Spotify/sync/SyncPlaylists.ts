import type { BaseClient, Connection } from '@ci/domains/connections';

interface SpotifyPlaylistItem {
  tracks?: {
    href: string;
    total: number;
  };
  [key: string]: unknown;
}

interface SpotifyTracksResponse {
  items: unknown[];
  next?: string;
}

async function fetchAllTracks(
  client: BaseClient,
  connection: Connection,
  tracksHref: string,
): Promise<unknown[]> {
  const allTracks: unknown[] = [];
  let nextUrl: string | undefined = tracksHref;

  while (nextUrl) {
    try {
      // Extract the path from the full URL if needed
      const url = nextUrl.startsWith('http') ? new URL(nextUrl).pathname + new URL(nextUrl).search : nextUrl;

      const response = (await client.request(connection, url)) as SpotifyTracksResponse;

      if (response.items && response.items.length > 0) {
        allTracks.push(...response.items);
      }

      nextUrl = response.next;
    } catch (error) {
      client.logger.error('Failed to fetch playlist tracks', {
        tracksHref: nextUrl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Stop pagination on error but return what we have
      break;
    }
  }

  return allTracks;
}

export async function syncPlaylists({
  connection,
  client,
  nextCursor,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }> {
  try {
    client.logger.log('Performing Spotify Playlists sync', {
      connectionId: connection.id,
      nextCursor,
    });

    const endpoint = nextCursor.nextUrl ? String(nextCursor.nextUrl) : `/v1/me/playlists?limit=50`;

    const response = (await client.request(connection, endpoint)) as {
      items: SpotifyPlaylistItem[];
      next?: string;
    };

    const playlists = response.items || [];
    const nextUrl = response.next;

    // Fetch tracks for each playlist
    const playlistsWithTracks = await Promise.all(
      playlists.map(async (playlist) => {
        if (playlist.tracks?.href) {
          try {
            const tracks = await fetchAllTracks(client, connection, playlist.tracks.href);

            return {
              ...playlist,
              tracks: {
                ...playlist.tracks,
                items: tracks,
              },
            };
          } catch (error) {
            client.logger.error('Failed to fetch tracks for playlist', {
              playlistId: (playlist as { id?: string }).id,
              error: error instanceof Error ? error.message : 'Unknown error',
            });

            // Return playlist without tracks if fetching fails
            return playlist;
          }
        }

        return playlist;
      }),
    );

    client.logger.log('Spotify Playlists sync call completed', {
      connectionId: connection.id,
      playlistCount: playlistsWithTracks.length,
      hasNextPage: !!nextUrl,
    });

    return {
      data: {
        playlists: playlistsWithTracks,
      },
      nextCursor: nextUrl
        ? {
            nextUrl,
          }
        : {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Spotify Playlists', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

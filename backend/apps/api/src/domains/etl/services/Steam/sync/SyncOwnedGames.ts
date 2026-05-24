import type { BaseClient, Connection } from '@ci/domains/connections';

interface SteamOwnedGamesResponse {
  response: {
    game_count: number;
    games: Array<{
      appid: number;
      name: string;
      playtime_forever: number;
      img_icon_url?: string;
      has_community_visible_stats?: boolean;
      playtime_windows_forever?: number;
      playtime_mac_forever?: number;
      playtime_linux_forever?: number;
      playtime_deck_forever?: number;
      rtime_last_played?: number;
      playtime_disconnected?: number;
    }>;
  };
}

export async function syncOwnedGames({
  connection,
  client,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}) {
  try {
    client.logger.log('Performing Steam Owned Games sync', {
      connectionId: connection.id,
    });

    const steamId = connection.externalId;

    if (!steamId) {
      throw new Error('Steam ID not found on connection');
    }

    const endpoint = `/IPlayerService/GetOwnedGames/v0001/?steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;

    const response = await client.request<SteamOwnedGamesResponse>(connection, endpoint);

    const games = response.response?.games || [];

    client.logger.log('Steam Owned Games sync completed', {
      connectionId: connection.id,
      gameCount: games.length,
    });

    return {
      data: {
        games,
      },
      nextCursor: {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Steam Owned Games', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

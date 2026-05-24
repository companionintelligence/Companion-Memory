import type { BaseClient, Connection } from '@ci/domains/connections';

interface SteamOwnedGamesResponse {
  response: {
    game_count: number;
    games: Array<{
      appid: number;
      name: string;
      has_community_visible_stats?: boolean;
    }>;
  };
}

interface SteamAchievement {
  apiname: string;
  achieved: number;
  unlocktime: number;
  name?: string;
  description?: string;
}

interface SteamPlayerAchievementsResponse {
  playerstats: {
    steamID: string;
    gameName: string;
    achievements?: SteamAchievement[];
    success: boolean;
  };
}

export async function syncAchievements({
  connection,
  client,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}) {
  try {
    client.logger.log('Performing Steam Achievements sync', {
      connectionId: connection.id,
    });

    const steamId = connection.externalId;

    if (!steamId) {
      throw new Error('Steam ID not found on connection');
    }

    // First, get owned games
    const gamesEndpoint = `/IPlayerService/GetOwnedGames/v0001/?steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`;
    const gamesResponse = await client.request<SteamOwnedGamesResponse>(connection, gamesEndpoint);
    const games = gamesResponse.response?.games || [];

    const allAchievements: Array<{
      gameName: string;
      appid: number;
      achievement: SteamAchievement;
    }> = [];

    // For each game, get player achievements
    for (const game of games) {
      try {
        const achievementsEndpoint = `/ISteamUserStats/GetPlayerAchievements/v0001/?steamid=${steamId}&appid=${game.appid}&l=english&format=json`;
        const achievementsResponse = await client.request<SteamPlayerAchievementsResponse>(
          connection,
          achievementsEndpoint,
        );

        const achievements = achievementsResponse.playerstats?.achievements || [];
        const unlockedAchievements = achievements.filter((a) => a.achieved === 1);

        for (const achievement of unlockedAchievements) {
          allAchievements.push({
            gameName: achievementsResponse.playerstats.gameName || game.name,
            appid: game.appid,
            achievement,
          });
        }
      } catch (error) {
        // Many games don't have achievements or stats may be private — skip silently
        client.logger.debug('Could not fetch achievements for game', {
          appid: game.appid,
          gameName: game.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    client.logger.log('Steam Achievements sync completed', {
      connectionId: connection.id,
      totalGames: games.length,
      totalAchievements: allAchievements.length,
    });

    return {
      data: {
        achievements: allAchievements,
      },
      nextCursor: {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Steam Achievements', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

import type { BaseClient, Connection } from '@ci/domains/connections';

interface SteamFriend {
  steamid: string;
  relationship: string;
  friend_since: number;
}

interface SteamFriendListResponse {
  friendslist: {
    friends: SteamFriend[];
  };
}

interface SteamPlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  realname?: string;
}

interface SteamPlayerSummariesResponse {
  response: {
    players: SteamPlayerSummary[];
  };
}

export async function syncFriends({
  connection,
  client,
}: {
  connection: Connection;
  client: BaseClient;
  nextCursor: Record<string, unknown>;
  historical: boolean;
}) {
  try {
    client.logger.log('Performing Steam Friends sync', {
      connectionId: connection.id,
    });

    const steamId = connection.externalId;

    if (!steamId) {
      throw new Error('Steam ID not found on connection');
    }

    // Get friend list
    const friendsEndpoint = `/ISteamUser/GetFriendList/v0001/?steamid=${steamId}&relationship=friend&format=json`;
    const friendsResponse = await client.request<SteamFriendListResponse>(connection, friendsEndpoint);
    const friendsList = friendsResponse.friendslist?.friends || [];

    // Get player summaries for all friends (in batches of 100)
    const friendsWithDetails: Array<{
      steamid: string;
      personaname: string;
      profileurl: string;
      avatar: string;
      avatarfull: string;
      realname?: string;
      friend_since: number;
    }> = [];

    for (let i = 0; i < friendsList.length; i += 100) {
      const batch = friendsList.slice(i, i + 100);
      const steamIds = batch.map((f) => f.steamid).join(',');

      try {
        const summariesEndpoint = `/ISteamUser/GetPlayerSummaries/v0002/?steamids=${steamIds}&format=json`;
        const summariesResponse = await client.request<SteamPlayerSummariesResponse>(
          connection,
          summariesEndpoint,
        );

        const players = summariesResponse.response?.players || [];
        const playerMap = new Map(players.map((p) => [p.steamid, p]));

        for (const friend of batch) {
          const player = playerMap.get(friend.steamid);

          friendsWithDetails.push({
            steamid: friend.steamid,
            personaname: player?.personaname || 'Unknown',
            profileurl: player?.profileurl || `https://steamcommunity.com/profiles/${friend.steamid}`,
            avatar: player?.avatar || '',
            avatarfull: player?.avatarfull || '',
            realname: player?.realname,
            friend_since: friend.friend_since,
          });
        }
      } catch (error) {
        client.logger.error('Failed to fetch player summaries for batch', {
          batchStart: i,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        // Still add the friends without detailed info
        for (const friend of batch) {
          friendsWithDetails.push({
            steamid: friend.steamid,
            personaname: 'Unknown',
            profileurl: `https://steamcommunity.com/profiles/${friend.steamid}`,
            avatar: '',
            avatarfull: '',
            friend_since: friend.friend_since,
          });
        }
      }
    }

    client.logger.log('Steam Friends sync completed', {
      connectionId: connection.id,
      friendCount: friendsWithDetails.length,
    });

    return {
      data: {
        friends: friendsWithDetails,
      },
      nextCursor: {},
    };
  } catch (err) {
    client.logger.error('Failed to sync Steam Friends', {
      connectionId: connection.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });

    throw err;
  }
}

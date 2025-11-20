import type {
  DiscordGuildSyncState,
  DiscordDMSyncState,
  DiscordRelationshipsSyncState,
  DiscordConnectionsSyncState,
} from '@ci/domains/etl';

import type { Connection } from '../types';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { SyncResponse } from './types';

const MESSAGE_PAGE_SIZE = 100; // Discord API max limit
const MEMBER_PAGE_SIZE = 1000; // Discord API max limit for members

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  features: string[];
}

interface DiscordChannel {
  id: string;
  type: number; // 0 = text, 1 = DM, 2 = voice, etc.
  name: string | null;
  guild_id?: string;
  position?: number;
  topic?: string | null;
  nsfw?: boolean;
  last_message_id?: string | null;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mentions: unknown[];
  mention_roles: unknown[];
  attachments: unknown[];
  embeds: unknown[];
  reactions?: unknown[];
  pinned: boolean;
  type: number;
}

interface DiscordDMChannel {
  id: string;
  type: number;
  last_message_id: string | null;
  recipients: Array<{
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
  }>;
}

interface DiscordGuildMember {
  user?: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot?: boolean;
  };
  nick?: string | null;
  avatar?: string | null;
  roles: string[];
  joined_at: string;
  premium_since?: string | null;
  deaf: boolean;
  mute: boolean;
  flags: number;
  pending?: boolean;
  permissions?: string;
  communication_disabled_until?: string | null;
}

interface DiscordRelationship {
  id: string;
  type: number; // 1 = friend, 2 = blocked, 3 = incoming request, 4 = outgoing request
  user: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    public_flags?: number;
  };
}

interface DiscordConnection {
  id: string;
  name: string;
  type: string; // e.g., "twitch", "youtube", "steam", "spotify"
  revoked?: boolean;
  integrations?: unknown[];
  verified: boolean;
  friend_sync: boolean;
  show_activity: boolean;
  visibility: number;
}

export class DiscordClient extends BaseOAuth2Client {
  protected readonly baseUrl = 'https://discord.com/api/v10';

  protected readonly authorizationEndpoint = 'https://discord.com/oauth2/authorize';

  protected readonly tokenEndpoint = 'https://discord.com/api/v10/oauth2/token';

  // Valid Discord OAuth2 scopes
  // Note: Discord doesn't have granular "read" scopes like guilds.channels.read or dm_channels.read.
  // We use basic scopes to get an access token, then use that token to access REST API endpoints.
  // The REST API endpoints check the user's actual permissions in each guild/channel.
  protected readonly scopes = [
    'identify', // Basic user information
    'guilds', // List of guilds user is in
    'email', // User's email
    'connections', // Connected accounts (Spotify, Steam, etc.)
    'activities.read', // Read activities/games
    'applications.entitlements', // Read app entitlements
    'openid', // OpenID Connect
  ];

  protected get clientId() {
    const clientIdVariable = 'DISCORD_CLIENT_ID';
    const clientId = process.env[clientIdVariable];

    if (!clientId) {
      this.logger.error(`Expected environment variable ${clientIdVariable} not specified`);

      throw new Error('Client id not configured for provider');
    }

    return clientId;
  }

  protected get clientSecret() {
    const clientSecretVariable = 'DISCORD_CLIENT_SECRET';
    const clientSecret = process.env[clientSecretVariable];

    if (!clientSecret) {
      this.logger.error(`Expected environment variable ${clientSecretVariable} not specified`);

      throw new Error('Client secret not configured for provider');
    }

    return clientSecret;
  }

  async sync(connection: Connection): Promise<SyncResponse[]> {
    const responses: SyncResponse[] = [];

    // Sync user profile
    try {
      const profile = await this.fetchProfile(connection);
      responses.push({
        success: true,
        message: 'Discord profile sync completed successfully',
        data: {
          results: [{ api: 'discord profile', data: profile }],
          errors: [],
        },
      });
    } catch (error) {
      const errorMsg = `Discord profile API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error('Discord profile sync failed', {
        connectionId: connection.id,
        error: errorMsg,
      });
      responses.push({
        success: false,
        message: errorMsg,
        data: {
          results: [],
          errors: [errorMsg],
        },
      });
    }

    // Sync guilds (servers) and their messages
    try {
      const guildSyncState = connection.syncState?.guilds as DiscordGuildSyncState | null;
      const guildResults = await this.syncGuilds(connection, guildSyncState);

      responses.push({
        success: true,
        message: 'Discord guilds sync completed successfully',
        data: {
          results: [{ api: 'discord guilds', data: guildResults }],
          errors: [],
        },
        cursor: {
          guilds: guildResults[0]?.syncState || guildSyncState || {},
        },
      });
    } catch (error) {
      const errorMsg = `Discord guilds API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error('Discord guilds sync failed', {
        connectionId: connection.id,
        error: errorMsg,
      });
      responses.push({
        success: false,
        message: errorMsg,
        data: {
          results: [],
          errors: [errorMsg],
        },
      });
    }

    // Sync DMs
    try {
      const dmSyncState = connection.syncState?.dms as DiscordDMSyncState | null;
      const dmResults = await this.syncDMs(connection, dmSyncState);

      responses.push({
        success: true,
        message: 'Discord DMs sync completed successfully',
        data: {
          results: [{ api: 'discord dms', data: dmResults }],
          errors: [],
        },
        cursor: {
          dms: dmResults[0]?.syncState || dmSyncState || {},
        },
      });
    } catch (error) {
      const errorMsg = `Discord DMs API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error('Discord DMs sync failed', {
        connectionId: connection.id,
        error: errorMsg,
      });
      responses.push({
        success: false,
        message: errorMsg,
        data: {
          results: [],
          errors: [errorMsg],
        },
      });
    }

    // Note: Guild members sync removed - requires 'guilds.members.read' scope which needs
    // privileged permissions and server management access. Regular members cannot use this scope.

    // Sync Relationships (friends)
    try {
      const relationshipsSyncState = connection.syncState
        ?.relationships as DiscordRelationshipsSyncState | null;
      const relationshipResults = await this.syncRelationships(connection, relationshipsSyncState);

      responses.push({
        success: true,
        message: 'Discord relationships sync completed successfully',
        data: {
          results: [{ api: 'discord relationships', data: relationshipResults }],
          errors: [],
        },
        cursor: {
          relationships: relationshipResults[0]?.syncState || relationshipsSyncState || {},
        },
      });
    } catch (error) {
      const errorMsg = `Discord relationships API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error('Discord relationships sync failed', {
        connectionId: connection.id,
        error: errorMsg,
      });
      responses.push({
        success: false,
        message: errorMsg,
        data: {
          results: [],
          errors: [errorMsg],
        },
      });
    }

    // Sync Connections (connected accounts like Spotify, Steam, etc.)
    try {
      const connectionsSyncState = connection.syncState?.connections as DiscordConnectionsSyncState | null;
      const connectionResults = await this.syncConnections(connection, connectionsSyncState);

      responses.push({
        success: true,
        message: 'Discord connections sync completed successfully',
        data: {
          results: [{ api: 'discord connections', data: connectionResults }],
          errors: [],
        },
        cursor: {
          connections: connectionResults[0]?.syncState || connectionsSyncState || {},
        },
      });
    } catch (error) {
      const errorMsg = `Discord connections API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.error('Discord connections sync failed', {
        connectionId: connection.id,
        error: errorMsg,
      });
      responses.push({
        success: false,
        message: errorMsg,
        data: {
          results: [],
          errors: [errorMsg],
        },
      });
    }

    // Sync Presences (user presence/status)
    try {
      const presences = await this.syncPresences(connection);

      responses.push({
        success: true,
        message: 'Discord presences sync completed successfully',
        data: {
          results: [{ api: 'discord presences', data: presences }],
          errors: [],
        },
      });
    } catch (error) {
      const errorMsg = `Discord presences API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.warn('Discord presences sync failed (may not be available via REST API)', {
        connectionId: connection.id,
        error: errorMsg,
      });
      // Don't add error response - presences might not be available via REST API
    }

    // Sync Activities (games/activities users are playing)
    try {
      const activities = await this.syncActivities(connection);

      responses.push({
        success: true,
        message: 'Discord activities sync completed successfully',
        data: {
          results: [{ api: 'discord activities', data: activities }],
          errors: [],
        },
      });
    } catch (error) {
      const errorMsg = `Discord activities API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.warn('Discord activities sync failed (may not be available via REST API)', {
        connectionId: connection.id,
        error: errorMsg,
      });
      // Don't add error response - activities might not be available via REST API
    }

    // Sync Application Entitlements (what apps user has access to)
    try {
      const entitlements = await this.syncEntitlements(connection);

      responses.push({
        success: true,
        message: 'Discord entitlements sync completed successfully',
        data: {
          results: [{ api: 'discord entitlements', data: entitlements }],
          errors: [],
        },
      });
    } catch (error) {
      const errorMsg = `Discord entitlements API failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      this.logger.warn('Discord entitlements sync failed', {
        connectionId: connection.id,
        error: errorMsg,
      });
      // Don't add error response - entitlements might fail if not available
    }

    // Note: RPC notifications (rpc.notifications.read scope) require WebSocket connection
    // to Discord's RPC server. This is complex and typically requires:
    // 1. Discord approval for RPC access
    // 2. WebSocket connection to Discord RPC server
    // 3. Real-time event handling
    // As such, RPC notifications are not implemented via REST API.
    // The scope is included in the OAuth request for future implementation if needed.

    return responses;
  }

  private async fetchProfile(connection: Connection): Promise<unknown> {
    const profile = await this.request<unknown>(connection, '/users/@me');

    return profile;
  }

  private async syncGuilds(
    connection: Connection,
    syncState: DiscordGuildSyncState | null,
  ): Promise<Array<{ data: unknown; syncState: DiscordGuildSyncState }>> {
    const results: Array<{ data: unknown; syncState: DiscordGuildSyncState }> = [];
    const newSyncState: DiscordGuildSyncState = {
      channels: syncState?.channels || ({} as Record<string, { lastMessageId?: string }>),
    };

    // Fetch all guilds
    this.logger.log('Fetching Discord guilds', { connectionId: connection.id });
    const guilds = (await this.request<DiscordGuild[]>(connection, '/users/@me/guilds')) || [];

    this.logger.log('Discord guilds fetched', {
      connectionId: connection.id,
      guildCount: guilds.length,
    });

    // For each guild, fetch channels and messages
    for (const guild of guilds) {
      try {
        // Fetch channels for this guild
        const channels =
          (await this.request<DiscordChannel[]>(connection, `/guilds/${guild.id}/channels`)) || [];

        // Filter for text channels (type 0) and forum channels (type 15)
        const textChannels = channels.filter((ch) => ch.type === 0 || ch.type === 15);

        this.logger.log('Discord guild channels fetched', {
          connectionId: connection.id,
          guildId: guild.id,
          guildName: guild.name,
          channelCount: textChannels.length,
        });

        // Sync messages for each channel
        for (const channel of textChannels) {
          try {
            const channelSyncState = syncState?.channels?.[channel.id];
            const messages = await this.fetchChannelMessages(
              connection,
              channel.id,
              channelSyncState?.lastMessageId,
            );

            if (messages.length > 0) {
              // Store the newest message ID (first in array, as Discord returns newest first)
              const newestMessageId = messages[0]?.id;
              if (newestMessageId && newSyncState.channels) {
                newSyncState.channels[channel.id] = {
                  lastMessageId: newestMessageId,
                };
              }

              results.push({
                data: {
                  guild,
                  channel,
                  messages,
                },
                syncState: newSyncState,
              });

              this.logger.log('Discord channel messages fetched', {
                connectionId: connection.id,
                guildId: guild.id,
                channelId: channel.id,
                channelName: channel.name,
                messageCount: messages.length,
              });
            }
          } catch (error) {
            this.logger.warn('Failed to fetch messages for channel', {
              connectionId: connection.id,
              guildId: guild.id,
              channelId: channel.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
      } catch (error) {
        this.logger.warn('Failed to fetch channels for guild', {
          connectionId: connection.id,
          guildId: guild.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // If no results, return at least the guilds list
    if (results.length === 0) {
      results.push({
        data: { guilds },
        syncState: newSyncState,
      });
    }

    return results;
  }

  private async syncDMs(
    connection: Connection,
    syncState: DiscordDMSyncState | null,
  ): Promise<Array<{ data: unknown; syncState: DiscordDMSyncState }>> {
    const results: Array<{ data: unknown; syncState: DiscordDMSyncState }> = [];
    const newSyncState: DiscordDMSyncState = {
      channels: syncState?.channels || ({} as Record<string, { lastMessageId?: string }>),
    };

    // Fetch all DM channels
    this.logger.log('Fetching Discord DM channels', { connectionId: connection.id });
    const dmChannels = (await this.request<DiscordDMChannel[]>(connection, '/users/@me/channels')) || [];

    // Filter for DM channels (type 1) and group DMs (type 3)
    const filteredDMs = dmChannels.filter((ch) => ch.type === 1 || ch.type === 3);

    this.logger.log('Discord DM channels fetched', {
      connectionId: connection.id,
      dmChannelCount: filteredDMs.length,
    });

    // Sync messages for each DM channel
    for (const dmChannel of filteredDMs) {
      try {
        const channelSyncState = syncState?.channels?.[dmChannel.id];
        const messages = await this.fetchChannelMessages(
          connection,
          dmChannel.id,
          channelSyncState?.lastMessageId,
        );

        if (messages.length > 0) {
          // Store the newest message ID (first in array, as Discord returns newest first)
          const newestMessageId = messages[0]?.id;
          if (newestMessageId && newSyncState.channels) {
            newSyncState.channels[dmChannel.id] = {
              lastMessageId: newestMessageId,
            };
          }

          results.push({
            data: {
              channel: dmChannel,
              messages,
            },
            syncState: newSyncState,
          });

          this.logger.log('Discord DM messages fetched', {
            connectionId: connection.id,
            channelId: dmChannel.id,
            messageCount: messages.length,
          });
        }
      } catch (error) {
        this.logger.warn('Failed to fetch messages for DM channel', {
          connectionId: connection.id,
          channelId: dmChannel.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // If no results, return at least the DM channels list
    if (results.length === 0) {
      results.push({
        data: { dmChannels: filteredDMs },
        syncState: newSyncState,
      });
    }

    return results;
  }

  private async fetchChannelMessages(
    connection: Connection,
    channelId: string,
    lastMessageId?: string,
  ): Promise<DiscordMessage[]> {
    const allMessages: DiscordMessage[] = [];

    // If we have a lastMessageId, do incremental sync (get messages after it)
    if (lastMessageId) {
      let after: string | undefined = lastMessageId;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          limit: MESSAGE_PAGE_SIZE.toString(),
        });

        if (after) {
          params.append('after', after);
        }

        const messages =
          (await this.request<DiscordMessage[]>(
            connection,
            `/channels/${channelId}/messages?${params.toString()}`,
          )) || [];

        if (messages.length === 0) {
          hasMore = false;
        } else {
          allMessages.push(...messages);
          // Update after to the newest message ID for next page
          // Messages are returned newest first, so the first message is the newest
          after = messages[0]?.id;
          // If we got fewer than the page size, we've reached the end
          hasMore = messages.length === MESSAGE_PAGE_SIZE;
        }
      }
    } else {
      // Full sync - get all messages (paginate backwards from newest)
      let before: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          limit: MESSAGE_PAGE_SIZE.toString(),
        });

        if (before) {
          params.append('before', before);
        }

        const messages =
          (await this.request<DiscordMessage[]>(
            connection,
            `/channels/${channelId}/messages?${params.toString()}`,
          )) || [];

        if (messages.length === 0) {
          hasMore = false;
        } else {
          allMessages.push(...messages);
          // Update before to the oldest message ID for next page
          // Messages are returned newest first, so the last message is the oldest
          before = messages[messages.length - 1]?.id;
          // If we got fewer than the page size, we've reached the end
          hasMore = messages.length === MESSAGE_PAGE_SIZE;
        }
      }
    }

    return allMessages;
  }

  private async syncGuildMembers(
    connection: Connection,
    guildSyncState: DiscordGuildSyncState | null,
  ): Promise<Array<{ data: unknown; syncState: DiscordGuildSyncState }>> {
    const results: Array<{ data: unknown; syncState: DiscordGuildSyncState }> = [];
    const newSyncState: DiscordGuildSyncState = {
      channels: guildSyncState?.channels || ({} as Record<string, { lastMessageId?: string }>),
      members: guildSyncState?.members || ({} as Record<string, { lastMemberId?: string }>),
    };

    // First, fetch all guilds to know which guilds to fetch members for
    this.logger.log('Fetching Discord guilds for member sync', { connectionId: connection.id });
    const guilds = (await this.request<DiscordGuild[]>(connection, '/users/@me/guilds')) || [];

    this.logger.log('Discord guilds fetched for member sync', {
      connectionId: connection.id,
      guildCount: guilds.length,
    });

    // For each guild, fetch members
    for (const guild of guilds) {
      try {
        const guildMemberSyncState = guildSyncState?.members?.[guild.id];
        const members = await this.fetchGuildMembers(
          connection,
          guild.id,
          guildMemberSyncState?.lastMemberId,
        );

        if (members.length > 0) {
          // Store the last member ID for pagination (members are returned in order)
          const lastMemberId = members[members.length - 1]?.user?.id;
          if (lastMemberId && newSyncState.members) {
            newSyncState.members[guild.id] = {
              lastMemberId,
            };
          }

          results.push({
            data: {
              guild,
              members,
            },
            syncState: newSyncState,
          });

          this.logger.log('Discord guild members fetched', {
            connectionId: connection.id,
            guildId: guild.id,
            guildName: guild.name,
            memberCount: members.length,
          });
        }
      } catch (error) {
        this.logger.warn('Failed to fetch members for guild', {
          connectionId: connection.id,
          guildId: guild.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // If no results, return at least the guilds list
    if (results.length === 0) {
      results.push({
        data: { guilds },
        syncState: newSyncState,
      });
    }

    return results;
  }

  private async fetchGuildMembers(
    connection: Connection,
    guildId: string,
    afterMemberId?: string,
  ): Promise<DiscordGuildMember[]> {
    const allMembers: DiscordGuildMember[] = [];
    let after: string | undefined = afterMemberId;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: MEMBER_PAGE_SIZE.toString(),
      });

      if (after) {
        params.append('after', after);
      }

      const members =
        (await this.request<DiscordGuildMember[]>(
          connection,
          `/guilds/${guildId}/members?${params.toString()}`,
        )) || [];

      if (members.length === 0) {
        hasMore = false;
      } else {
        allMembers.push(...members);
        // Update after to the last member's user ID for next page
        const lastMember = members[members.length - 1];
        after = lastMember?.user?.id;
        // If we got fewer than the page size, we've reached the end
        hasMore = members.length === MEMBER_PAGE_SIZE;
      }
    }

    return allMembers;
  }

  private async syncRelationships(
    connection: Connection,
    syncState: DiscordRelationshipsSyncState | null,
  ): Promise<Array<{ data: unknown; syncState: DiscordRelationshipsSyncState }>> {
    const results: Array<{ data: unknown; syncState: DiscordRelationshipsSyncState }> = [];
    const newSyncState: DiscordRelationshipsSyncState = {
      lastRelationshipId: syncState?.lastRelationshipId,
    };

    // Fetch all relationships (friends, blocked users, etc.)
    this.logger.log('Fetching Discord relationships', { connectionId: connection.id });
    const relationships = await this.fetchRelationships(connection, syncState?.lastRelationshipId);

    if (relationships.length > 0) {
      // Store the last relationship ID for pagination
      const lastRelationshipId = relationships[relationships.length - 1]?.id;
      if (lastRelationshipId) {
        newSyncState.lastRelationshipId = lastRelationshipId;
      }

      results.push({
        data: { relationships },
        syncState: newSyncState,
      });

      this.logger.log('Discord relationships fetched', {
        connectionId: connection.id,
        relationshipCount: relationships.length,
      });
    } else {
      // Return empty result with sync state
      results.push({
        data: { relationships: [] },
        syncState: newSyncState,
      });
    }

    return results;
  }

  private async fetchRelationships(
    connection: Connection,
    afterRelationshipId?: string,
  ): Promise<DiscordRelationship[]> {
    // Discord relationships endpoint may not support pagination via REST API
    // Try to fetch all relationships at once first
    try {
      const relationships =
        (await this.request<DiscordRelationship[]>(connection, '/users/@me/relationships')) || [];

      // If we have a lastRelationshipId and the API supports pagination, filter results
      // Otherwise, return all relationships
      if (afterRelationshipId) {
        // Find the index of the last relationship we've seen
        const lastIndex = relationships.findIndex((r) => r.id === afterRelationshipId);
        if (lastIndex >= 0) {
          // Return only new relationships after the last one we've seen
          return relationships.slice(lastIndex + 1);
        }
      }

      return relationships;
    } catch (error) {
      // If the endpoint doesn't exist or fails, return empty array
      this.logger.warn('Failed to fetch relationships, endpoint may not be available', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return [];
    }
  }

  private async syncConnections(
    connection: Connection,
    syncState: DiscordConnectionsSyncState | null,
  ): Promise<Array<{ data: unknown; syncState: DiscordConnectionsSyncState }>> {
    const results: Array<{ data: unknown; syncState: DiscordConnectionsSyncState }> = [];
    const newSyncState: DiscordConnectionsSyncState = {
      lastSyncAt: syncState?.lastSyncAt || new Date().toISOString(),
    };

    // Fetch all connected accounts (Spotify, Steam, etc.)
    this.logger.log('Fetching Discord connections', { connectionId: connection.id });
    const connections = (await this.request<DiscordConnection[]>(connection, '/users/@me/connections')) || [];

    results.push({
      data: { connections },
      syncState: newSyncState,
    });

    this.logger.log('Discord connections fetched', {
      connectionId: connection.id,
      connectionCount: connections.length,
    });

    return results;
  }

  private async syncPresences(connection: Connection): Promise<unknown> {
    // Note: Presences are typically accessed via Gateway WebSocket API
    // This endpoint may not be available via REST API, but we'll try
    // If it fails, it will be logged as a warning and not block other syncs
    try {
      // Try to get user's own presence
      const presence = await this.request<unknown>(connection, '/users/@me/presence');

      return { presence };
    } catch (error) {
      // If /users/@me/presence doesn't work, presences might only be available via Gateway
      // Return empty result
      this.logger.warn('Presences endpoint not available via REST API', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return { presence: null, note: 'Presences may only be available via Gateway WebSocket API' };
    }
  }

  private async syncActivities(connection: Connection): Promise<unknown> {
    // Note: Activities are typically accessed via Gateway WebSocket API or RPC
    // This endpoint may not be available via REST API, but we'll try
    try {
      // Try to get user's activities
      const activities = await this.request<unknown>(connection, '/users/@me/activities');

      return { activities };
    } catch (error) {
      // If activities endpoint doesn't work, activities might only be available via Gateway/RPC
      this.logger.warn('Activities endpoint not available via REST API', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return { activities: [], note: 'Activities may only be available via Gateway WebSocket or RPC API' };
    }
  }

  private async syncEntitlements(connection: Connection): Promise<unknown> {
    // Fetch application entitlements (what apps user has access to)
    // Try multiple possible endpoints as Discord API structure may vary
    try {
      // Try with application ID (client ID)
      const entitlements = await this.request<unknown>(
        connection,
        `/applications/${this.clientId}/entitlements`,
      );

      return { entitlements };
    } catch {
      // Try alternative endpoint with user context
      try {
        const entitlements = await this.request<unknown>(connection, '/users/@me/entitlements');

        return { entitlements };
      } catch {
        // Try one more alternative
        try {
          const entitlements = await this.request<unknown>(
            connection,
            `/applications/@me/entitlements?user_id=@me`,
          );

          return { entitlements };
        } catch (thirdError) {
          this.logger.warn('Entitlements endpoint not available', {
            connectionId: connection.id,
            error: thirdError instanceof Error ? thirdError.message : 'Unknown error',
          });

          return { entitlements: [], note: 'Entitlements endpoint may not be available via REST API' };
        }
      }
    }
  }
}

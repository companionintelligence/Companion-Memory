import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { EventService } from '@ci/domains/memory';
import { PeoplePromotionService } from '@ci/domains/people';

import { ConnectionSyncJob } from '../../../types';

interface SteamFriendData {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarfull: string;
  realname?: string;
  friend_since: number;
}

@Injectable()
export class SteamFriendsTransformService {
  constructor(
    private readonly peoplePromotionService: PeoplePromotionService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SteamFriendsTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;

    this.logger.log('Starting Steam Friends transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const friends = (data?.friends as SteamFriendData[]) || [];

      if (friends.length === 0) {
        this.logger.log('No Steam friends found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      let personsCreatedCount = 0;
      let eventsCreatedCount = 0;
      let skippedCount = 0;

      for (const friend of friends) {
        try {
          // Promotion replaces the steam_id property-scan find-or-create:
          // the profile upserts on (steam, steamid); the realname (when Steam
          // exposes one) rides as a weak name identifier so the friend can be
          // suggested against a contact with the same real name.
          const observed = await this.peoplePromotionService.observeProfile(
            { userId },
            {
              sourceSystem: 'steam',
              remoteKey: friend.steamid,
              displayName: friend.realname ?? friend.personaname,
              handle: friend.personaname,
              avatarUrl: friend.avatarfull || friend.avatar || null,
              names: friend.realname ? [friend.realname] : [],
              properties: {
                type: 'person',
                steam_id: friend.steamid,
                external_id: friend.steamid,
                source_url: `https://steamcommunity.com/profiles/${friend.steamid}`,
                avatar_url: friend.avatarfull || friend.avatar,
                connection_id: connection.id,
                sources: ['steam'],
                steam_data: {
                  personaname: friend.personaname,
                  profileurl: friend.profileurl,
                  realname: friend.realname,
                  friend_since: friend.friend_since,
                  last_synced: new Date().toISOString(),
                },
              },
            },
          );

          if (!observed.created) {
            // Already known (prior sync or another source) — mirror the old
            // skip path: no duplicate friendship event on re-sync.
            skippedCount++;
            continue;
          }

          personsCreatedCount++;

          // Create Event for when the friendship was established
          if (friend.friend_since > 0) {
            await this.eventService.create(context, {
              title: `Became friends with ${friend.personaname}`,
              description: `Became friends with ${friend.personaname} on Steam`,
              event_type: 'friend_added',
              category: 'social',
              source_type: 'ETL',
              start_time: new Date(friend.friend_since * 1000),
              metadata: {
                steamid: friend.steamid,
                personaname: friend.personaname,
                profileurl: friend.profileurl,
              },
            });

            eventsCreatedCount++;
          }

          this.logger.debug('Steam friend transformed and stored', {
            steamid: friend.steamid,
            personaname: friend.personaname,
          });
        } catch (error) {
          this.logger.error('Failed to transform individual Steam friend', {
            steamid: friend.steamid,
            personaname: friend.personaname,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Steam Friends transformation completed', {
        userId,
        connectionId: connection.id,
        totalFriends: friends.length,
        personsCreated: personsCreatedCount,
        eventsCreated: eventsCreatedCount,
        skipped: skippedCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Steam Friends', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

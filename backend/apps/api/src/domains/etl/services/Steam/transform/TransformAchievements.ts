import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

interface SteamAchievementData {
  gameName: string;
  appid: number;
  achievement: {
    apiname: string;
    achieved: number;
    unlocktime: number;
    name?: string;
    description?: string;
  };
}

@Injectable()
export class SteamAchievementsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SteamAchievementsTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;

    this.logger.log('Starting Steam Achievements transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const achievements = (data?.achievements as SteamAchievementData[]) || [];

      if (achievements.length === 0) {
        this.logger.log('No Steam achievements found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      let contentCreatedCount = 0;
      let eventCreatedCount = 0;
      let skippedCount = 0;
      let skippedEventCount = 0;

      for (const item of achievements) {
        const achievementName = item.achievement.name || item.achievement.apiname;
        const achievementDescription = item.achievement.description || '';
        const gameName = item.gameName;
        const externalId = `${item.appid}_${item.achievement.apiname}`;

        try {
          // Check for existing achievement content
          const existingContent = await this.contentService.search(context, {
            type: 'achievement',
            external_id: externalId,
          });

          if (existingContent.length > 0) {
            this.logger.debug('Achievement already exists, skipping', {
              achievementName,
              gameName,
            });
            skippedCount++;
          } else {
            // Create Content entity for the achievement
            await this.contentService.create(context, {
              type: 'achievement',
              title: achievementName,
              text: achievementDescription,
              external_id: externalId,
              source_data: {
                appid: item.appid,
                gameName,
                apiname: item.achievement.apiname,
                unlocktime: item.achievement.unlocktime,
              },
            });

            contentCreatedCount++;
          }

          // Create Event entity for the achievement unlock
          if (item.achievement.unlocktime > 0) {
            const existingEvents = await this.eventService.search(context, {
              eventType: 'achievement_unlocked',
              title: `Earned achievement: ${achievementName}`,
              startTime: new Date(item.achievement.unlocktime * 1000),
            });

            if (existingEvents.length === 0) {
              await this.eventService.create(context, {
                title: `Earned achievement: ${achievementName}`,
                description: `Earned achievement: ${achievementName} in ${gameName}`,
                event_type: 'achievement_unlocked',
                category: 'games',
                source_type: 'ETL',
                start_time: new Date(item.achievement.unlocktime * 1000),
                metadata: {
                  appid: item.appid,
                  gameName,
                  achievementApiName: item.achievement.apiname,
                  achievementName,
                },
              });

              eventCreatedCount++;
            } else {
              this.logger.debug('Game played event already exists, skipping', {
                appid: item.appid,
                name: item.achievement.name,
                rtime_last_played: item.achievement.unlocktime,
              });

              skippedEventCount++;
            }
          }

          this.logger.debug('Achievement transformed and stored', {
            achievementName,
            gameName,
          });
        } catch (error) {
          this.logger.error('Failed to transform individual achievement', {
            achievementName,
            gameName,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Steam Achievements transformation completed', {
        userId,
        connectionId: connection.id,
        totalAchievements: achievements.length,
        contentCreated: contentCreatedCount,
        eventsCreated: eventCreatedCount,
        skipped: skippedCount,
        skippedEvents: skippedEventCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Steam Achievements', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

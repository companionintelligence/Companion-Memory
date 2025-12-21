import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { EventService, Events } from '@ci/domains/events';
import { PersonService } from '@ci/domains/memory';

import { PromoteService } from '../PromoteService';

interface FacebookFriend {
  id: string;
  name: string;
  picture?: {
    data: {
      url: string;
    };
  };
}

@Injectable()
export class FacebookFriendsPromotionService {
  constructor(
    private readonly personService: PersonService,
    private readonly eventService: EventService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookFriendsPromotionService.name);
  }

  async promoteFriends(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Promoting Facebook friends', { userId, connectionId });

    const friends = this.extractFriends(apiLogContent);
    if (friends.length === 0) {
      this.logger.log('No Facebook friends found to promote', { userId, connectionId });

      return;
    }

    const { userNode } = await this.promoteService.getUserAndEntity({ userId }, userId);

    const userEntityId = userNode.entityId;

    for (const friend of friends) {
      try {
        const searchProperties: Record<string, unknown> = {
          owner_user_id: userId,
          facebook_id: friend.id,
        };

        const existingEntities = await this.personService.search(
          { userId },
          { properties: searchProperties },
        );

        const properties: Record<string, unknown> = {
          facebook_id: friend.id,
          owner_user_id: userId,
          connection_id: connectionId,
          sources: ['facebook'],
          facebook_data: {
            name: friend.name,
            picture_url: friend.picture?.data?.url,
            last_synced: new Date().toISOString(),
          },
        };

        const nameParts = friend.name.trim().split(/\s+/).filter(Boolean);
        if (nameParts.length > 0) {
          properties.first_name = nameParts[0];
          if (nameParts.length > 1) {
            properties.last_name = nameParts.slice(1).join(' ');
          }
        }

        if (existingEntities.length > 0) {
          // Update existing person
          const existingEntity = existingEntities[0];
          const currentProperties = (existingEntity.properties as Record<string, unknown>) ?? {};
          const mergedProperties = { ...currentProperties, ...properties };

          await this.personService.update({ userId }, existingEntity.id, {
            properties: mergedProperties,
            lastAccessed: new Date(),
          });
        } else {
          // Create new person
          const entityId = uuidv7();
          await this.personService.create(
            { userId },
            {
              id: entityId,
              name: friend.name,
              description: `Facebook friend: ${friend.name}`,
              properties,
            },
          );

          // Create relationship to user
          await this.eventService.send(Events.GRAPH_PERSON_CREATED, {
            ownerId: userId,
            person: {
              entityId,
              entityType: 'Person',
              name: friend.name,
            },
            relationships: [
              {
                fromEntityId: userEntityId,
                toEntityId: entityId,
                relationshipType: 'FRIEND',
                properties: {
                  source: 'facebook',
                  connection_id: connectionId,
                  last_interaction: new Date().toISOString(),
                },
              },
            ],
          });
        }
      } catch (error) {
        this.logger.error('Error processing Facebook friend', {
          friendId: friend.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Facebook friends promotion completed', {
      userId,
      connectionId,
      processedCount: friends.length,
    });
  }

  private extractFriends(content: unknown): FacebookFriend[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookFriend[];
    }

    if ('data' in contentObj && Array.isArray(contentObj.data)) {
      return contentObj.data as FacebookFriend[];
    }

    return [];
  }
}

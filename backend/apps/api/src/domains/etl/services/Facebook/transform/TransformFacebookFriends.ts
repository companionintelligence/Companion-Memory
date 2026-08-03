import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { RelationshipService } from '@ci/domains/graph';
import { PeoplePromotionService } from '@ci/domains/people';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

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
export class FacebookFriendsTransformService {
  constructor(
    private readonly peoplePromotionService: PeoplePromotionService,
    private readonly promoteService: PromoteService,
    private readonly relationshipService: RelationshipService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookFriendsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    this.logger.log('Starting Facebook friends transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const { userNode } = await this.promoteService.getUserAndEntity(context, userId);

      const friends = this.extractFriends(data);
      if (friends.length === 0) {
        this.logger.log('No Facebook friends found to transform', { userId, connectionId: connection.id });

        return;
      }

      for (const friend of friends) {
        try {
          const properties: Record<string, unknown> = {
            facebook_id: friend.id,
            connection_id: connection.id,
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

          // Promotion replaces the facebook_id property-scan find-or-create.
          // Facebook exports no email/phone, so the friend's name rides as a
          // weak identifier (lookup only) and near-misses surface as duplicate
          // suggestions rather than auto-merges.
          const observed = await this.peoplePromotionService.observeProfile(
            { userId },
            {
              sourceSystem: 'facebook',
              remoteKey: friend.id,
              displayName: friend.name,
              avatarUrl: friend.picture?.data?.url ?? null,
              names: [friend.name],
              properties,
            },
          );

          await this.relationshipService.upsert(context, {
            fromNodeId: userNode.entityId,
            fromNodeType: 'person',
            toNodeId: observed.personEntityId,
            toNodeType: 'person',
            type: 'FRIENDS_WITH',
            properties: {
              source: 'facebook',
              connection_id: connection.id,
            },
          });
        } catch (error) {
          this.logger.error('Error processing Facebook friend', {
            friendId: friend.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Facebook friends transformation completed', {
        userId,
        connectionId: connection.id,
        processedCount: friends.length,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook friends', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractFriends(content: unknown): FacebookFriend[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookFriend[];
    }

    if ('friends' in contentObj && Array.isArray(contentObj.friends)) {
      return contentObj.friends as FacebookFriend[];
    }

    return [];
  }
}

import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { RelationshipService } from '@ci/domains/graph';
import { PeoplePromotionService } from '@ci/domains/people';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';
interface FacebookProfile {
  id: string;
  name: string;
  email?: string;
  age_range?: { min: number; max?: number };
  birthday?: string;
  gender?: string;
  hometown?: { id: string; name: string };
  link?: string;
  location?: { id: string; name: string };
}
@Injectable()
export class FacebookProfileTransformService {
  constructor(
    private readonly peoplePromotionService: PeoplePromotionService,
    private readonly promoteService: PromoteService,
    private readonly relationshipService: RelationshipService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookProfileTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    this.logger.log('Starting Facebook profile transformation', {
      userId,
      connectionId: connection.id,
    });
    try {
      const profile = this.extractProfile(data);
      if (!profile) {
        this.logger.log('No Facebook profile found to transform', { userId, connectionId: connection.id });

        return;
      }

      const properties: Record<string, unknown> = {
        facebook_id: profile.id,
        connection_id: connection.id,
        sources: ['facebook'],
        facebook_data: {
          name: profile.name,
          email: profile.email,
          age_range: profile.age_range,
          birthday: profile.birthday,
          gender: profile.gender,
          hometown: profile.hometown,
          link: profile.link,
          location: profile.location,
          last_synced: new Date().toISOString(),
        },
      };
      // Store birthday directly in properties for easy access
      if (profile.birthday) {
        properties.birthday = profile.birthday;
      }

      if (profile.email) {
        properties.email = profile.email;
      }

      const nameParts = profile.name.trim().split(/\s+/).filter(Boolean);
      if (nameParts.length > 0) {
        properties.first_name = nameParts[0];
        if (nameParts.length > 1) {
          properties.last_name = nameParts.slice(1).join(' ');
        }
      }

      if (profile.gender) {
        properties.gender = profile.gender;
      }

      if (profile.hometown) {
        properties.hometown = profile.hometown.name;
      }

      if (profile.location) {
        properties.location = profile.location.name;
      }

      const context = toServiceContext({ userId });

      // Promotion replaces the three-tier facebook_id/email/name scan: the
      // profile upserts on (facebook, profile:<id>); the account email is a
      // strong identifier, so this chains into an existing Person carrying it
      // (the old email search, but via the index) instead of duplicating.
      const observed = await this.peoplePromotionService.observeProfile(context, {
        sourceSystem: 'facebook',
        remoteKey: `profile:${profile.id}`,
        displayName: profile.name,
        emails: profile.email ? [profile.email] : [],
        names: [profile.name],
        properties,
      });

      if (observed.created) {
        const { userNode } = await this.promoteService.getUserAndEntity(context, userId);
        // Create relationship to user
        await this.relationshipService.upsert(context, {
          fromNodeId: userNode.entityId,
          fromNodeType: 'person',
          toNodeId: observed.personEntityId,
          toNodeType: 'person',
          type: 'IS',
          properties: {
            source: 'facebook',
            connection_id: connection.id,
          },
        });
      }

      this.logger.log(
        observed.created
          ? 'Created new person from Facebook profile'
          : 'Resolved Facebook profile to existing person',
        {
          userId,
          entityId: observed.personEntityId,
          name: profile.name,
          hasBirthday: !!profile.birthday,
        },
      );

      this.logger.log('Facebook profile transformation completed', {
        userId,
        connectionId: connection.id,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook profile', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractProfile(content: unknown): FacebookProfile | null {
    if (!content || typeof content !== 'object') {
      return null;
    }

    const contentObj = content as Record<string, unknown>;
    if ('id' in contentObj && 'name' in contentObj) {
      return contentObj as unknown as FacebookProfile;
    }

    return null;
  }
}

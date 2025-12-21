import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { EventService, Events } from '@ci/domains/events';
import { PersonService } from '@ci/domains/memory';

import { PromoteService } from '../PromoteService';

import { FacebookPromotionUtils } from './FacebookPromotionUtils';

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
export class FacebookProfilePromotionService {
  constructor(
    private readonly personService: PersonService,
    private readonly eventService: EventService,
    private readonly promoteService: PromoteService,
    private readonly utils: FacebookPromotionUtils,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookProfilePromotionService.name);
  }

  async promoteProfile(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Promoting Facebook profile', { userId, connectionId });

    const profile = this.extractProfile(apiLogContent);
    if (!profile) {
      this.logger.log('No Facebook profile found to promote', { userId, connectionId });

      return;
    }

    // Get user entity ID
    const { userNode } = await this.promoteService.getUserAndEntity({ userId }, userId);

    const userEntityId = userNode.entityId;

    // Search for existing person by facebook_id first (most reliable)
    let existingEntities = await this.personService.search(
      { userId },
      { properties: { facebook_id: profile.id, owner_user_id: userId } },
    );

    // If not found by facebook_id, try searching by email
    if (existingEntities.length === 0 && profile.email) {
      existingEntities = await this.personService.search(
        { userId },
        { properties: { email: profile.email, owner_user_id: userId } },
      );
    }

    // If still not found, try searching by name (case-insensitive)
    if (existingEntities.length === 0) {
      const nameParts = profile.name.trim().split(/\s+/).filter(Boolean);
      if (nameParts.length > 0) {
        // Search for persons with matching name (case-insensitive)
        const allPersons = await this.personService.search(
          { userId },
          { properties: { owner_user_id: userId } },
        );

        // Filter by case-insensitive name match
        existingEntities = allPersons.filter((person) => {
          const personName = person.name?.toLowerCase().trim();
          const profileName = profile.name.toLowerCase().trim();

          return personName === profileName;
        });
      }
    }

    const properties: Record<string, unknown> = {
      facebook_id: profile.id,
      owner_user_id: userId,
      connection_id: connectionId,
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

    if (existingEntities.length > 0) {
      // Update existing person
      const existingEntity = existingEntities[0];
      const currentProperties = (existingEntity.properties as Record<string, unknown>) ?? {};

      // Merge properties, ensuring Facebook data and birthday are updated
      const currentFacebookData = (currentProperties.facebook_data as Record<string, unknown>) || {};
      const newFacebookData = (properties.facebook_data as Record<string, unknown>) || {};

      const mergedProperties = {
        ...currentProperties,
        ...properties,
        // Ensure sources array includes 'facebook' if not already present
        sources: Array.isArray(currentProperties.sources)
          ? [...new Set([...currentProperties.sources, 'facebook'])]
          : ['facebook'],
        // Update facebook_data with latest info
        facebook_data: {
          ...currentFacebookData,
          ...newFacebookData,
        },
        // Ensure birthday is set if provided
        ...(profile.birthday ? { birthday: profile.birthday } : {}),
        // Ensure facebook_id is set
        ...(profile.id ? { facebook_id: profile.id } : {}),
      };

      // Update name if it's more complete
      const updatedName =
        existingEntity.name && existingEntity.name.length > profile.name.length
          ? existingEntity.name
          : profile.name;

      await this.personService.update({ userId }, existingEntity.id, {
        name: updatedName,
        properties: mergedProperties,
        lastAccessed: new Date(),
      });

      this.logger.log('Updated existing person with Facebook profile', {
        userId,
        entityId: existingEntity.id,
        name: updatedName,
        hasBirthday: !!profile.birthday,
      });
    } else {
      // Create new person
      const entityId = uuidv7();
      await this.personService.create(
        { userId },
        {
          id: entityId,
          name: profile.name,
          description: `Facebook profile: ${profile.name}`,
          properties,
        },
      );

      // Create relationship to user
      // TODO: Use RelationshipService
      // await this.eventService.send(Events.GRAPH_PERSON_CREATED, {
      //   ownerId: userId,
      //   person: {
      //     entityId,
      //     entityType: 'Person',
      //     name: profile.name,
      //   },
      //   relationships: [
      //     {
      //       fromEntityId: userEntityId,
      //       toEntityId: entityId,
      //       relationshipType: 'IS',
      //       properties: {
      //         source: 'facebook',
      //         connection_id: connectionId,
      //         last_interaction: new Date().toISOString(),
      //       },
      //     },
      //   ],
      // });

      this.logger.log('Created new person from Facebook profile', {
        userId,
        entityId,
        name: profile.name,
        hasBirthday: !!profile.birthday,
      });
    }

    this.logger.log('Facebook profile promotion completed', { userId, connectionId });
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

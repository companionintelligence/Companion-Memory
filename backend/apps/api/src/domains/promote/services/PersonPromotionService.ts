import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { GraphUtilityService, GraphNodeEntity } from '@ci/domains/graph';
import { UserEntity } from '@ci/domains/user';

interface ParticipantInfo {
  email: string;
  name: string;
  type?: string; // 'organizer', 'attendee', 'from', 'to', 'cc', 'bcc'
  responseStatus?: string;
}

@Injectable()
export class PersonPromotionService {
  private logger = new LoggerService(PersonPromotionService.name);

  constructor(
    @InjectRepository(GraphNodeEntity)
    private readonly entityRepository: Repository<GraphNodeEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly graphUtilityService: GraphUtilityService,
  ) {}

  /**
   * Create or update a person entity from a participant
   * Every entity created will have at least one relationship to the user
   */
  async createOrUpdatePersonFromParticipant(
    participant: ParticipantInfo,
    userId: string,
    connectionId: string,
    source: 'calendar' | 'email',
    relationshipType: 'MET_WITH' | 'EMAILED' | 'RECEIVED_EMAIL_FROM' | 'ORGANIZED_EVENT_WITH',
    interactionTimestamp?: Date,
  ): Promise<string> {
    try {
      // Get user entity and user entity ID
      const user = await this.userRepository.findOne({ where: { id: userId } });
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }

      // Skip if participant is the user themselves (avoid self-references)
      if (participant.email.toLowerCase() === user.email.toLowerCase()) {
        const userEntityId = await this.getUserEntityId(userId);
        this.logger.log('Skipping self-reference participant', {
          email: participant.email,
          userId,
        });

        return userEntityId;
      }

      const userEntityId = await this.getUserEntityId(userId);

      // Check if person entity already exists by email in properties
      const existingEntity = await this.entityRepository
        .createQueryBuilder('entity')
        .where("entity.entity_type = 'Person'")
        .andWhere("entity.properties->>'email' = :email", { email: participant.email })
        .andWhere("entity.properties->>'owner_user_id' = :userId", { userId })
        .getOne();

      let entityId: string;

      if (!existingEntity) {
        // Create new person entity
        entityId = uuid7();
        const nameParts = participant.name.trim().split(/\s+/).filter(Boolean);
        const [firstName, ...restName] = nameParts;
        const lastName = restName.length > 0 ? restName.join(' ') : null;

        const lastSeenDate = interactionTimestamp || new Date();

        const properties = {
          email: participant.email,
          first_name: firstName || participant.name,
          last_name: lastName,
          contact_type: source,
          owner_user_id: userId,
          connection_id: connectionId,
          sources: [source],
          [`${source}_data`]: {
            participant_type: participant.type,
            response_status: participant.responseStatus,
            last_seen: lastSeenDate.toISOString(),
          },
        };

        await this.graphUtilityService.createGraphNode({
          entityId,
          entityType: 'Person',
          name: participant.name,
          description: `Contact from ${source}`,
          properties,
          searchContent: `${participant.name} ${participant.email}`,
          ownerUserId: userId,
        });

        this.logger.log('Created new person entity', {
          entityId,
          name: participant.name,
          email: participant.email,
          source,
        });
      } else {
        // Update existing entity with new source data
        entityId = existingEntity.entity_id;
        const currentProperties = existingEntity.properties as Record<string, unknown>;
        const sources = (currentProperties.sources || []) as string[];
        const lastSeenDate = interactionTimestamp || new Date();

        // Check if we need to update - either new source or more recent interaction
        const existingSourceData = currentProperties[`${source}_data`] as { last_seen?: string } | undefined;
        const existingLastSeen = existingSourceData?.last_seen
          ? new Date(existingSourceData.last_seen)
          : null;
        const shouldUpdate =
          !sources.includes(source) || !existingLastSeen || lastSeenDate > existingLastSeen;

        if (shouldUpdate) {
          if (!sources.includes(source)) {
            sources.push(source);
          }

          const updatedProperties = {
            ...currentProperties,
            sources,
            [`${source}_data`]: {
              participant_type: participant.type,
              response_status: participant.responseStatus,
              last_seen: lastSeenDate.toISOString(),
            },
          };

          existingEntity.properties = updatedProperties;
          await this.entityRepository.save(existingEntity);

          this.logger.log('Updated existing person entity', {
            entityId,
            sources,
            lastSeen: lastSeenDate.toISOString(),
          });
        }
      }

      // Create or update relationship between user and this person
      // This ensures every entity has at least one relationship
      const relationshipTimestamp = interactionTimestamp || new Date();
      await this.createOrUpdateRelationship(
        userEntityId,
        entityId,
        relationshipType,
        {
          source,
          connection_id: connectionId,
          participant_type: participant.type,
          last_interaction: relationshipTimestamp.toISOString(),
        },
        userId,
      );

      return entityId;
    } catch (error) {
      this.logger.error('Failed to create/update person entity', {
        participant,
        source,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Create or update a relationship between two entities
   */
  private async createOrUpdateRelationship(
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
    properties: Record<string, unknown>,
    ownerUserId: string,
  ): Promise<void> {
    // Check if relationship already exists
    const existingEntities = await this.graphUtilityService.findConnectedEntities(
      fromEntityId,
      [relationshipType],
      'outbound',
    );

    const relationshipExists = existingEntities.some((entity) => entity.entity_id === toEntityId);

    if (!relationshipExists) {
      await this.graphUtilityService.createRelationship(
        fromEntityId,
        toEntityId,
        relationshipType,
        properties,
        1.0,
        ownerUserId,
      );

      this.logger.log('Created new relationship', {
        fromEntityId,
        toEntityId,
        relationshipType,
      });
    } else {
      // Relationship exists, could update properties here if needed
      this.logger.log('Relationship already exists', {
        fromEntityId,
        toEntityId,
        relationshipType,
      });
    }
  }

  /**
   * Process multiple participants and create entities with relationships
   */
  async processParticipants(
    participants: ParticipantInfo[],
    userId: string,
    connectionId: string,
    source: 'calendar' | 'email',
    relationshipType: 'MET_WITH' | 'EMAILED' | 'RECEIVED_EMAIL_FROM' | 'ORGANIZED_EVENT_WITH',
    interactionTimestamp?: Date,
  ): Promise<string[]> {
    this.logger.log(`Processing ${participants.length} participants from ${source}`, {
      userId,
      connectionId,
      source,
      interactionTimestamp: interactionTimestamp?.toISOString(),
    });

    const entityIds: string[] = [];

    for (const participant of participants) {
      try {
        const entityId = await this.createOrUpdatePersonFromParticipant(
          participant,
          userId,
          connectionId,
          source,
          relationshipType,
          interactionTimestamp,
        );
        entityIds.push(entityId);
      } catch (error) {
        // Log error but continue processing other participants
        this.logger.error('Failed to process participant', {
          participant,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log(`Completed processing participants from ${source}`, {
      userId,
      connectionId,
      processedCount: entityIds.length,
    });

    return entityIds;
  }

  /**
   * Get or create a user's entity ID
   * Handles user lookup and entity creation in one call
   */
  async getUserEntityId(userId: string): Promise<string> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    if (user.entityId) {
      return user.entityId;
    }

    return this.ensureUserHasEntity(user);
  }

  /**
   * Ensure a user has an entity in the graph
   * Creates one if it doesn't exist (for legacy users)
   */
  async ensureUserHasEntity(user: UserEntity): Promise<string> {
    const entityId = uuid7();
    const nameParts = (user.name ?? '').trim().split(/\s+/).filter(Boolean);
    const [firstName, ...restName] = nameParts;

    const properties: Record<string, unknown> = {
      email: user.email,
      owner_user_id: user.id,
    };

    if (firstName) {
      properties.first_name = firstName;
    }

    if (restName.length > 0) {
      properties.last_name = restName.join(' ');
    }

    await this.graphUtilityService.createGraphNode({
      entityId,
      entityType: 'Person',
      name: user.name || user.email,
      description: `User: ${user.name || user.email}`,
      properties,
      searchContent: `${user.name || ''} ${user.email}`,
      linkedTable: 'users',
      linkedId: user.id,
      ownerUserId: user.id,
    });

    // Update the user record with the new entity ID
    await this.userRepository.update(user.id, { entityId });

    this.logger.log('Created entity for legacy user', {
      userId: user.id,
      entityId,
    });

    return entityId;
  }
}

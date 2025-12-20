import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type RequestContext, toServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ConnectionEntity } from '@ci/domains/connections';
import { ApiLogEntity } from '@ci/domains/etl';
import { Events, EventService } from '@ci/domains/events';
import { NodeService } from '@ci/domains/graph';
import { Person, PersonService } from '@ci/domains/memory';
import { UserService, User } from '@ci/domains/user';
import {} from '@ci/common/context';

import { ApiLogScopes } from '../constants';

interface ParticipantInfo {
  email: string;
  name: string;
  type?: string; // 'organizer', 'attendee', 'from', 'to', 'cc', 'bcc'
  responseStatus?: string;
}

@Injectable()
export class PromoteService {
  constructor(
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
    private readonly eventService: EventService,
    private readonly personService: PersonService,
    private readonly userService: UserService,
    private readonly nodeService: NodeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PromoteService.name);
  }

  /**
   * Promote API logs for a specific user
   */
  async promoteApiLogs(userId: string): Promise<void> {
    this.logger.log('Starting promote api logs for user', userId);

    try {
      const unprocessedApiLogs = await this.apiLogRepository
        .createQueryBuilder('apiLog')
        .innerJoin('apiLog.connection', 'connection')
        .where('apiLog.user_id = :userId', { userId })
        .andWhere('apiLog.last_processed IS NULL')
        .andWhere('apiLog.connection_id IS NOT NULL')
        .andWhere('connection.active = true')
        .andWhere('connection.access_token IS NOT NULL')
        .andWhere(
          new Brackets((qb) => {
            qb.where('connection.token_expiry > :currentDate', { currentDate: new Date() }).orWhere(
              'connection.refresh_token IS NOT NULL',
              { currentDate: new Date() },
            );
          }),
        )
        .orderBy('apiLog.created_at', 'ASC')
        .getMany();

      this.logger.log('Found unprocessed API logs', {
        userId,
        count: unprocessedApiLogs.length,
      });

      if (unprocessedApiLogs.length === 0) {
        this.logger.log('No unprocessed API logs found', {
          userId,
        });

        return;
      }

      // Process each API log
      for (const apiLog of unprocessedApiLogs) {
        await this.processApiLog(apiLog, { userId } as RequestContext);
      }

      this.logger.log('Completed processing API logs', {
        userId,
        processedCount: unprocessedApiLogs.length,
      });
    } catch (error) {
      this.logger.error('Error in promoteApiLogsForUser', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Process a single API log entry
   */
  private async processApiLog(apiLog: ApiLogEntity, context: RequestContext): Promise<void> {
    this.logger.log('Processing API log', {
      apiLogId: apiLog.id,
      scope: apiLog.scope,
      userId: context.userId,
    });

    try {
      if (!context.userId) {
        this.logger.error('User ID is required', {
          apiLogId: apiLog.id,
        });

        return;
      }

      if (!apiLog.connection_id) {
        this.logger.error('Connection ID is required', {
          apiLogId: apiLog.id,
        });

        return;
      }

      const connection = await this.connectionRepository.findOne({
        where: [
          {
            id: apiLog.connection_id,
            active: true,
            accessToken: Not(IsNull()),
            refreshToken: IsNull(), // No refresh token
            tokenExpiry: MoreThan(new Date()),
          },
          {
            id: apiLog.connection_id,
            active: true,
            accessToken: Not(IsNull()),
            refreshToken: Not(IsNull()), // Has refresh token
          },
        ],
      });

      if (!connection) {
        this.logger.warn('Connection is not active or has invalid tokens, skipping API log processing', {
          apiLogId: apiLog.id,
          connectionId: apiLog.connection_id,
        });

        // TODO: Should we mark as processed to avoid reprocessing or handle refreshing the connection?
        // Currently marking as processed to avoid reprocessing connections with invalid tokens
        await this.markApiLogAsProcessed(apiLog.id);

        return;
      }

      // Queue the promotion job based on scope
      switch (apiLog.scope) {
        case ApiLogScopes.GMAIL:
          await this.eventService.send(Events.PROMOTE_GMAIL_MESSAGES, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.GOOGLE_CALENDAR:
          await this.eventService.send(Events.PROMOTE_CALENDAR_EVENTS, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.YOUTUBE:
          await this.eventService.send(Events.PROMOTE_YOUTUBE_DATA, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.GOOGLE_DRIVE:
          await this.eventService.send(Events.PROMOTE_DRIVE_DATA, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.GOOGLE_CONTACTS:
          await this.eventService.send(Events.PROMOTE_CONTACTS, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.OUTLOOK_MAIL:
          await this.eventService.send(Events.PROMOTE_OUTLOOK_MAIL_MESSAGES, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.OUTLOOK_CALENDAR:
          await this.eventService.send(Events.PROMOTE_OUTLOOK_CALENDAR_EVENTS, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.ONEDRIVE_FILES:
          await this.eventService.send(Events.PROMOTE_ONEDRIVE_FILES, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.FACEBOOK_PROFILE:
          await this.eventService.send(Events.PROMOTE_FACEBOOK_PROFILE, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.FACEBOOK_POSTS:
          await this.eventService.send(Events.PROMOTE_FACEBOOK_POSTS, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.FACEBOOK_PHOTOS:
          await this.eventService.send(Events.PROMOTE_FACEBOOK_PHOTOS, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.FACEBOOK_VIDEOS:
          await this.eventService.send(Events.PROMOTE_FACEBOOK_VIDEOS, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.FACEBOOK_FRIENDS:
          await this.eventService.send(Events.PROMOTE_FACEBOOK_FRIENDS, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
        case ApiLogScopes.FACEBOOK_LIKES:
          await this.eventService.send(Events.PROMOTE_FACEBOOK_LIKES, {
            apiLogId: apiLog.id,
            userId: context.userId,
            connectionId: apiLog.connection_id,
            content: apiLog.content,
          });
          break;
      }

      // Mark the API log as processed after queuing
      await this.markApiLogAsProcessed(apiLog.id);

      this.logger.log('Successfully processed API log', {
        apiLogId: apiLog.id,
        scope: apiLog.scope,
      });
    } catch (error) {
      this.logger.error('Error processing API log', {
        apiLogId: apiLog.id,
        scope: apiLog.scope,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Transforms a list of participant data into a list of Person entity ids. The
   * entity ids will correspond either to previously created Person entities
   * retrieved by email address or new Person entities created from the provided
   * participant data.
   *
   * Note that the returned list of entities can contain the user's
   * corresponding Person entity. For the purposes of building relationships
   * this method will return the list of entity ids and a filtered list
   * excluding the user's Person entity.
   *
   * @param context
   * @param participants
   */
  async upsertPeopleFromParticipants(
    context: UserServiceContext,
    {
      connectionId,
      source,
      participants,
    }: {
      connectionId: string;
      source: string;
      participants: ParticipantInfo[];
    },
  ) {
    const user = await this.userService.findById(context, context.userId);

    if (user == null) {
      throw new Error('User could not be obtained');
    }

    const userNode = await this.nodeService.findNodeByUserId(context, context.userId);

    // This is a degenerate case resulting from an unlikely race condition. When
    // a user signs up we will asynchronously create a graph node for them. If
    // this work hasn't processed we cannot build relationships to the current
    // user so we should fail the job and retry.
    if (userNode == null) {
      throw new Error('User graph node could not be obtained');
    }

    const taskMap = new Map<string, Promise<Person>>();

    const tasks = participants.map(async (participant) => {
      const email = participant.email.toLowerCase();

      if (taskMap.has(email)) {
        return taskMap.get(email) as Promise<Person>;
      }

      if (email === user.email.toLowerCase()) {
        const person = await this.personService.findById(context, userNode.entityId);

        if (person == null) {
          throw new Error('User graph node could not be obtained');
        }

        const task = Promise.resolve(person);

        taskMap.set(email, task);

        return task;
      }

      const existingPeople = await this.personService.search(context, {
        properties: {
          email,
          owner_user_id: context.userId,
        },
      });

      if (existingPeople.length > 0) {
        const task = Promise.resolve(existingPeople[0]);

        taskMap.set(email, task);

        return task;
      }

      const id = uuid7();
      const [firstName, ...restName] = participant.name.trim().split(/\s+/).filter(Boolean);
      const lastName = restName.length > 0 ? restName.join(' ') : null;

      const properties: Record<string, unknown> = {
        email,
        first_name: firstName || participant.name,
        last_name: lastName,
        contact_type: source,
        owner_user_id: context.userId,
        connection_id: connectionId,
      };

      const task = this.personService.create(context, {
        id,
        name: participant.name,
        description: `Contact from ${source}`,
        properties,
      });

      taskMap.set(participant.email, task);

      return task;
    });

    const entities = await Promise.all(tasks);
    const relationships = entities.map((entity) => (entity.id === userNode.entityId ? null : entity));

    return {
      entities,
      relationships,
    };
  }

  /**
   * Process multiple participants and create entities with relationships
   */
  async processParticipants(
    participants: ParticipantInfo[],
    userId: string,
    connectionId: string,
    source: 'calendar' | 'email' | 'drive',
    relationshipType: 'MET_WITH' | 'EMAILED' | 'RECEIVED_EMAIL_FROM' | 'ORGANIZED_EVENT_WITH' | 'EDITED_WITH',
  ): Promise<string[]> {
    const context = toServiceContext({ userId });

    const { entities } = await this.upsertPeopleFromParticipants(context, {
      source,
      connectionId,
      participants,
    });

    // TODO: We still need to reimplement relationship creation.
    this.logger.warn('Skipping relationship creation', { relationshipType });

    return entities.map((entity) => entity.id);
  }

  /**
   * Mark an API log as processed
   */
  private async markApiLogAsProcessed(apiLogId: string): Promise<void> {
    await this.apiLogRepository.update(apiLogId, {
      last_processed: new Date(),
    });
  }

  /**
   * Get or create a user's entity ID
   * Handles user lookup and entity creation in one call
   */
  async getUserEntityId(userId: string): Promise<string> {
    const user = await this.userService.findById({ userId }, userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // Check if user already has an entity ID
    if (user.entityId) {
      // Verify the entity exists in the entities table
      const existingEntity = await this.personService.findById({ userId }, user.entityId);

      if (existingEntity) {
        return user.entityId;
      }

      // Entity doesn't exist, need to create a new one
      this.logger.warn('User has entityId but entity does not exist, creating new entity', {
        userId,
        entityId: user.entityId,
      });
    }

    return this.ensureUserHasEntity(user);
  }

  /**
   * Ensure a user has an entity in the graph
   * Creates one if it doesn't exist (for legacy users)
   */
  private async ensureUserHasEntity(user: User): Promise<string> {
    let entityId: string;
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

    const searchContent = this.buildPersonSearchContent(user.name ?? user.email ?? null, properties);

    const existingEntities = await this.personService.search(
      { userId: user.id },
      {
        properties: {
          email: properties.email as string,
          owner_user_id: user.id,
        },
      },
    );

    if (existingEntities.length === 0) {
      entityId = uuid7();
      await this.personService.create(
        { userId: user.id },
        {
          id: entityId,
          name: user.name || user.email,
          description: `User: ${user.name || user.email}`,
          properties,
          searchContent: searchContent || undefined,
          linkedTable: 'users',
          linkedId: user.id,
        },
      );

      await this.enqueuePersonEmbedding(user.id, entityId, searchContent);

      // Update the user record with the new entity ID
      await this.userService.update({ userId: user.id }, user.id, { entityId });

      this.logger.log('Created entity for user', {
        userId: user.id,
        entityId,
      });
    } else {
      // Entity already exists, use it and update user record if needed
      const existingEntity = existingEntities[0];
      entityId = existingEntity.id;

      if (!user.entityId || user.entityId !== entityId) {
        await this.userService.update({ userId: user.id }, user.id, { entityId });
        this.logger.log('Updated user with existing entity ID', {
          userId: user.id,
          entityId,
        });
      }
    }

    this.logger.log('Created entity for legacy user', {
      userId: user.id,
      entityId,
    });

    return entityId;
  }

  private async enqueuePersonEmbedding(ownerId: string, entityId: string, searchContent: string | null) {
    if (!searchContent || searchContent.trim().length === 0) {
      return;
    }

    try {
      await this.eventService.send(Events.SEARCH_EMBED_ENTITY, {
        ownerId,
        entityId,
        entityType: 'Person',
        searchContent,
      });
    } catch (error) {
      this.logger.error('Failed to enqueue person embedding', {
        ownerId,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildPersonSearchContent(
    name: string | null | undefined,
    properties?: Record<string, unknown>,
  ): string | null {
    const parts = new Set<string>();
    const push = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }

      const normalized = value.trim();
      if (normalized.length === 0) {
        return;
      }

      parts.add(normalized);
    };

    push(name ?? null);

    const props: Record<string, unknown> = properties ?? {};
    const candidateKeys = ['first_name', 'last_name', 'email', 'occupation', 'bio', 'phone'];
    for (const key of candidateKeys) {
      push(props[key]);
    }

    const aliases = props['aliases'];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        push(alias);
      }
    }

    if (parts.size === 0) {
      return null;
    }

    return Array.from(parts).join(' ');
  }
}

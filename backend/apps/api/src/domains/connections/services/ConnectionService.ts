import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services/LoggerService';
import type { RequestContext } from '@ci/common/types';
import type { CreateEventDto } from '@ci/domains/memory/types';

import { ClientFactory } from '../clients';
import { ApiLogEntity } from '../entities/ApiLogEntity';
import { ConnectionEntity } from '../entities/ConnectionEntity';
import type {
  CreateConnectionDto,
  Connection,
  UpdateConnectionDto,
  UpdateConnectionCredentialsDto,
} from '../types';
import { parseCalendarDataToEvents } from '../utils/calendarParser';

@Injectable()
export class ConnectionService {
  private logger = new LoggerService(ConnectionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
    private readonly clientFactory: ClientFactory,
  ) {}

  async create(context: RequestContext, data: CreateConnectionDto): Promise<Connection> {
    const { providerId, ...rest } = data;

    const sanitizedData = {
      ...rest,
      clientid: rest.clientid?.trim(),
      clientsecret: rest.clientsecret?.trim(),
    };

    const instance = this.connectionRepository.create({
      ...sanitizedData,
      id: uuid7(),
      active: true,
      user: {
        id: context.userId,
      },
      provider: {
        id: providerId,
      },
    });

    const entity = await this.connectionRepository.save(instance);

    return this.findOne(context, entity.id);
  }

  async findAll(context: RequestContext): Promise<Connection[]> {
    const entities = await this.connectionRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['provider'],
    });

    return entities.map((entity) => entity.toConnection());
  }

  async findOne(context: RequestContext, id: string): Promise<Connection> {
    const entity = await this.connectionRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
      relations: ['provider'],
    });

    if (entity == null) {
      throw new NotFoundException();
    }

    return entity.toConnection();
  }

  async update(
    context: RequestContext,
    id: string,
    data: UpdateConnectionDto & UpdateConnectionCredentialsDto,
  ): Promise<Connection> {
    const updatePayload: UpdateConnectionDto = {
      ...data,
      clientid: data.clientid?.trim(),
      clientsecret: data.clientsecret?.trim(),
    };

    const result = await this.connectionRepository.update(
      {
        id,
        user: {
          id: context.userId,
        },
      },
      updatePayload,
    );

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    const updated = await this.findOne(context, id);

    return updated;
  }

  async delete(context: RequestContext, id: string): Promise<boolean> {
    // First, verify the connection exists and belongs to the user
    const connection = await this.findOne(context, id);
    if (!connection) {
      throw new NotFoundException();
    }

    // Delete the connection - the database constraints will automatically set
    // connection_id to NULL in all related tables, preserving the data
    const result = await this.connectionRepository
      .createQueryBuilder()
      .delete()
      .where('id = :id AND user_id = :userId', { id, userId: context.userId })
      .execute();

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }

  async findSyncTargetsByUserId(): Promise<Map<string, string[]>> {
    type Row = {
      id: string;
      user_id: string;
    };

    const rows = (await this.dataSource.query(`
      SELECT
        connections.id as id,
        connections.user_id as user_id
      FROM
        connections
      WHERE active = true;
    `)) satisfies Array<Row>;

    const groupedByUserId = new Map<string, string[]>();

    for (const row of rows) {
      const userId = row.user_id;

      if (!groupedByUserId.has(userId)) {
        groupedByUserId.set(userId, []);
      }

      groupedByUserId.get(userId)!.push(row.id);
    }

    return groupedByUserId;
  }

  async connect(context: RequestContext, connectionId: string): Promise<{ url: string }> {
    const connection = await this.findOne(context, connectionId);
    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    return {
      url: await client.getAuthorizationUrl(connection),
    };
  }

  async callback(context: RequestContext, connectionId: string, code: string): Promise<Connection> {
    const connection = await this.findOne(context, connectionId);
    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);
    const tokenExchange = await client.exchangeAuthorizationCode(connection, code);

    return this.update(context, connectionId, {
      ...tokenExchange,
    });
  }

  async sync(context: RequestContext, connectionId: string, persistData = true) {
    this.logger.log('Starting manual sync for connection', {
      connectionId,
      userId: context.userId,
    });

    try {
      const connection = await this.findOne(context, connectionId);
      const client = this.clientFactory.getClientByProviderId(connection.provider?.id);
      const syncResponse = await client.sync(connection);

      // Process calendar data and save to events table
      if (syncResponse.data?.results) {
        console.log('🔄 Processing sync results:', {
          resultCount: syncResponse.data.results.length,
          connectionId,
          results: syncResponse.data.results.map((r) => ({ api: r.api, hasData: !!r.data })),
        });

        for (const result of syncResponse.data.results) {
          // Check if this is calendar data
          if (this.isCalendarApi(result.api)) {
            console.log('📅 Processing calendar data for events table:', {
              api: result.api,
              connectionId,
              hasData: !!result.data,
            });

            this.logger.log('Processing calendar data for events table', {
              api: result.api,
              connectionId,
            });

            try {
              // Parse calendar data to events
              this.logger.log('Parsing calendar data', {
                connectionId,
                userId: context.userId,
                hasData: !!result.data,
              });

              const events = parseCalendarDataToEvents(result.data, connectionId!, context.userId!);

              this.logger.log('Parsed events', {
                eventCount: events.length,
                connectionId,
                sampleEvent: events[0]
                  ? {
                      id: events[0].id,
                      name: events[0].name,
                      connection_id: events[0].connection_id,
                      user_id: events[0].user_id,
                    }
                  : null,
              });

              if (events.length > 0) {
                // Save events to database using direct repository access
                console.log('💾 Saving events to database:', {
                  eventCount: events.length,
                  connectionId,
                });
                await this.saveEventsToDatabase(events);
                console.log('✅ SUCCESS: All calendar events saved to database:', {
                  eventCount: events.length,
                  connectionId,
                });
                this.logger.log('Successfully saved calendar events to database', {
                  eventCount: events.length,
                  connectionId,
                });
              } else {
                console.log('⚠️ No events to save:', {
                  connectionId,
                  reason: 'No events parsed from calendar data',
                });
              }
            } catch (eventError) {
              this.logger.error('Failed to process calendar events', {
                connectionId,
                error: eventError instanceof Error ? eventError.message : 'Unknown error',
              });
            }
          } else if (this.isGmailApi(result.api)) {
            // Keep Gmail data console logging as requested
            this.logger.log('Gmail data (console only)', {
              api: result.api,
              connectionId,
              data: result.data,
            });
            console.log('Gmail data:', result.data);
          }
        }
      }

      if (persistData) {
        await this.apiLogRepository.save({
          id: uuid7(),
          content: JSON.stringify(syncResponse),
          connection: {
            id: connectionId,
          },
          user: {
            id: context.userId,
          },
        });
      }

      this.logger.log('Sync completed', {
        connectionId,
        userId: context.userId,
        success: syncResponse.success,
        message: syncResponse.message,
      });

      return syncResponse;
    } catch (error) {
      this.logger.error('Sync failed', {
        connectionId,
        userId: context.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  private isCalendarApi(apiName: string): boolean {
    return apiName.toLowerCase().includes('calendar');
  }

  private isGmailApi(apiName: string): boolean {
    return apiName.toLowerCase().includes('gmail') || apiName.toLowerCase().includes('mail');
  }

  private async saveEventsToDatabase(events: CreateEventDto[]): Promise<void> {
    // Use raw SQL to insert events directly to avoid circular dependency
    for (const event of events) {
      this.logger.log('Saving event to database', {
        eventId: event.id,
        eventName: event.name,
        connectionId: event.connection_id,
        userId: event.user_id,
        externalId: event.external_id,
      });

      try {
        console.log('Attempting to insert event into database:', {
          eventId: event.id,
          eventName: event.name,
          connectionId: event.connection_id,
          externalId: event.external_id,
          userId: event.user_id,
        });

        const result = await this.dataSource.query(
          `INSERT INTO events (
            id, name, type, description, start_time, end_time, 
            external_id, source_url, source_data, user_id, connection_id, 
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
          [
            event.id,
            event.name,
            event.type,
            event.description,
            event.start_time,
            event.end_time,
            event.external_id,
            event.source_url,
            JSON.stringify(event.source_data),
            event.user_id,
            event.connection_id,
          ],
        );

        console.log('✅ SUCCESS: Event inserted/updated in database:', {
          eventId: event.id,
          eventName: event.name,
          connectionId: event.connection_id,
          externalId: event.external_id,
          result: result,
        });

        this.logger.log('Successfully saved event to database', {
          eventId: event.id,
          connectionId: event.connection_id,
        });
      } catch (error) {
        console.error('❌ ERROR: Failed to save event to database:', {
          eventId: event.id,
          connectionId: event.connection_id,
          error: error instanceof Error ? error.message : 'Unknown error',
          fullError: error,
        });

        this.logger.error('Failed to save event to database', {
          eventId: event.id,
          connectionId: event.connection_id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }
  }
}

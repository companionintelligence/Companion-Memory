import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { DataIngestionService } from '@ci/common/services/DataIngestionService';
import { LoggerService } from '@ci/common/services/LoggerService';
import type { RequestContext } from '@ci/common/types';

import { ClientFactory } from '../clients';
import { ApiLogEntity } from '../entities/ApiLogEntity';
import { ConnectionEntity } from '../entities/ConnectionEntity';
import type {
  CreateConnectionDto,
  Connection,
  UpdateConnectionDto,
  UpdateConnectionCredentialsDto,
} from '../types';

@Injectable()
export class ConnectionService implements OnModuleInit {
  private logger = new LoggerService(ConnectionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
    @InjectRepository(ApiLogEntity)
    private readonly apiLogRepository: Repository<ApiLogEntity>,
    private readonly clientFactory: ClientFactory,
    private readonly dataIngestionService: DataIngestionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing ConnectionService event listeners');

    // Listen for next page sync events
    this.eventEmitter.on('connection.sync-with-token', this.handleNextPageSyncWithToken.bind(this));

    this.logger.log('ConnectionService event listeners initialized');
  }

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

      // Use the new data ingestion service for processing sync data
      if (persistData) {
        this.logger.log('Calling data ingestion service', {
          connectionId,
          userId: context.userId,
          requestId: context.requestId,
          syncSuccess: syncResponse.success,
        });
        await this.processSyncDataWithIngestionService(context, connectionId, syncResponse);
      } else {
        this.logger.log('Skipping data ingestion (persistData=false)', {
          connectionId,
          userId: context.userId,
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

  /**
   * Processes sync data using the new DataIngestionService abstraction
   * This provides maximum visibility and error handling
   */
  private async processSyncDataWithIngestionService(
    context: RequestContext,
    connectionId: string,
    syncResponse: {
      success: boolean;
      message: string;
      data?: {
        results: Array<{
          api: string;
          data: unknown;
          error?: string;
        }>;
        errors: string[];
      };
    },
  ): Promise<void> {
    try {
      this.logger.log('Processing sync data with ingestion service', {
        connectionId,
        userId: context.userId,
        requestId: context.requestId,
        syncSuccess: syncResponse.success,
        resultCount: syncResponse.data?.results?.length || 0,
      });

      const ingestionResult = await this.dataIngestionService.ingestSyncData({
        connectionId,
        userId: context.userId!,
        syncResponse,
        requestContext: context,
      });

      this.logger.log('Data ingestion service completed', {
        connectionId,
        userId: context.userId,
        requestId: context.requestId,
        success: ingestionResult.success,
        apiLogsCreated: ingestionResult.details.apiLogsCreated,
        errorCount: ingestionResult.details.errors.length,
      });

      // Log any errors for visibility
      if (ingestionResult.details.errors.length > 0) {
        this.logger.warn('Data ingestion completed with errors', {
          connectionId,
          userId: context.userId,
          requestId: context.requestId,
          errors: ingestionResult.details.errors,
        });
      }
    } catch (error) {
      this.logger.error('Failed to process sync data with ingestion service', {
        connectionId,
        userId: context.userId,
        requestId: context.requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Don't throw here - we want the sync to continue even if ingestion fails
      // The error is logged for visibility
    }
  }

  /**
   * Public method to sync with a pagination token
   * Used by CalendarPaginationService for next page syncs
   */
  async syncWithToken(
    context: RequestContext,
    connectionId: string,
    nextPageToken: string,
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      results: Array<{
        api: string;
        data: unknown;
        error?: string;
      }>;
      errors: string[];
    };
  }> {
    this.logger.log('Syncing with pagination token', {
      connectionId,
      userId: context.userId,
      nextPageToken,
      requestId: context.requestId,
    });

    try {
      // Get the connection
      const connection = await this.findOne(context, connectionId);
      const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

      // Call the client's sync method with the pagination token
      const syncResponse = await client.sync(connection, nextPageToken);

      this.logger.log('Pagination sync completed', {
        connectionId,
        userId: context.userId,
        nextPageToken,
        requestId: context.requestId,
        syncSuccess: syncResponse.success,
        resultCount: syncResponse.data?.results?.length || 0,
      });

      // Process the sync response with the data ingestion service
      await this.processSyncDataWithIngestionService(context, connectionId, syncResponse);

      return syncResponse;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during pagination sync';

      this.logger.error('Failed to sync with pagination token', {
        connectionId,
        userId: context.userId,
        nextPageToken,
        requestId: context.requestId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      throw error;
    }
  }

  /**
   * Handles next page sync with pagination token
   */
  private async handleNextPageSyncWithToken(event: {
    connectionId: string;
    userId: string;
    nextPageToken: string;
    requestId: string;
    timestamp: Date;
  }): Promise<void> {
    this.logger.log('Handling next page sync with token', {
      connectionId: event.connectionId,
      userId: event.userId,
      nextPageToken: event.nextPageToken,
      requestId: event.requestId,
    });

    try {
      const context: RequestContext = {
        userId: event.userId,
        requestId: event.requestId,
      };

      // Use the public syncWithToken method
      await this.syncWithToken(context, event.connectionId, event.nextPageToken);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during next page sync';

      this.logger.error('Failed to handle next page sync with token', {
        connectionId: event.connectionId,
        userId: event.userId,
        nextPageToken: event.nextPageToken,
        requestId: event.requestId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}

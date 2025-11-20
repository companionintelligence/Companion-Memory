import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services/LoggerService';
import type { RequestContext } from '@ci/common/types';

import { ClientFactory } from '../clients';
import { ConnectionEntity } from '../entities/ConnectionEntity';
import type {
  CreateConnectionDto,
  Connection,
  UpdateConnectionDto,
  UpdateConnectionCredentialsDto,
} from '../types';

import { ProviderService } from './ProviderService';

@Injectable()
export class ConnectionService {
  private logger = new LoggerService(ConnectionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
    private readonly clientFactory: ClientFactory,
    private readonly providerService: ProviderService,
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
        active: true,
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
    const result = await this.connectionRepository.update(
      {
        id,
        user: {
          id: context.userId,
        },
      },
      {
        active: false,
      },
    );

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
        ci_core.connections.id as id,
        ci_core.connections.user_id as user_id
      FROM
        ci_core.connections
      WHERE active = true
        AND access_token IS NOT NULL
        AND token_expiry > NOW();
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

  async getAuthorizationUrl(connection: Connection, providerId?: string) {
    const resolvedProviderId = providerId ?? connection.provider?.id;
    const client = this.clientFactory.getClientByProviderId(resolvedProviderId);

    return client.getAuthorizationUrl(connection);
  }

  async connect(context: RequestContext, connectionId: string): Promise<{ url: string }> {
    const connection = await this.findOne(context, connectionId);
    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    return {
      url: await client.getAuthorizationUrl(connection),
    };
  }

  async callback(context: RequestContext, connectionId: string, code: string): Promise<Connection> {
    // Check if connectionId is actually a provider ID (for Discord direct OAuth flow)
    let connection: Connection | null = null;

    try {
      connection = await this.findOne(context, connectionId);
    } catch {
      // Connection doesn't exist, check if it's a provider ID
      try {
        const provider = await this.providerService.findOne(connectionId);

        if (provider) {
          // Create connection for this provider
          const clientIdVariable = `${provider.name?.toUpperCase()}_CLIENT_ID`;
          const clientSecretVariable = `${provider.name?.toUpperCase()}_CLIENT_SECRET`;
          const clientId = process.env[clientIdVariable];
          const clientSecret = process.env[clientSecretVariable];

          if (!clientId || !clientSecret) {
            throw new Error(`Client credentials not configured for provider ${provider.name}`);
          }

          connection = await this.create(context, {
            providerId: provider.id,
            name: provider.name ?? 'My Connection',
            clientid: clientId,
            clientsecret: clientSecret,
            schedule: '1 hour',
          });
        } else {
          throw new Error(`Connection or provider not found: ${connectionId}`);
        }
      } catch {
        throw new Error(`Connection or provider not found: ${connectionId}`);
      }
    }

    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);
    const tokenExchange = await client.exchangeAuthorizationCode(code);

    return this.update(context, connection.id, {
      ...tokenExchange,
    });
  }

  async sync(context: RequestContext, connectionId: string) {
    this.logger.log('Starting manual sync for connection', {
      connectionId,
      userId: context.userId,
    });

    try {
      let connection = await this.findOne(context, connectionId);
      const { refreshToken, tokenExpiry } = connection;
      const client = this.clientFactory.getClientByProviderId(connection.provider?.id);
      if (refreshToken && tokenExpiry && new Date(tokenExpiry) < new Date()) {
        const newCredentials = await client.refreshAccessToken(connection);
        connection = await this.update(context, connectionId, {
          ...newCredentials,
        });
      }

      const syncResponses = await client.sync(connection);

      // Aggregate results from all endpoint syncs
      const allSuccessful = syncResponses.every((response) => response.success);
      const totalResults = syncResponses.reduce(
        (sum, response) => sum + (response.data?.results?.length || 0),
        0,
      );
      const totalErrors = syncResponses.reduce(
        (sum, response) => sum + (response.data?.errors?.length || 0),
        0,
      );

      this.logger.log('Sync completed', {
        connectionId,
        userId: context.userId,
        success: allSuccessful,
        totalEndpoints: syncResponses.length,
        totalResults,
        totalErrors,
      });

      // Return the array of responses as requested
      return syncResponses;
    } catch (error) {
      this.logger.error('Sync failed', {
        connectionId,
        userId: context.userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  async findById(connectionId: string): Promise<Connection | null> {
    const entity = await this.connectionRepository.findOne({
      where: { id: connectionId },
      relations: ['user', 'provider'],
    });

    return entity?.toConnection() ?? null;
  }
}

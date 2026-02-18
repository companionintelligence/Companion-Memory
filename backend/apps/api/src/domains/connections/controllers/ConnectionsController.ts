import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { EventService, Events } from '@ci/domains/events';

import { ClientFactory } from '../clients';
import { ConnectionService } from '../services/ConnectionService';
import { CloudOAuthProxyService } from '../services/CloudOAuthProxyService';
import type { CompleteConnectionDto, CreateConnectionDto, UpdateConnectionDto } from '../types';

import config from '@ci/configuration';

const createConnectionSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  providerId: z.string().uuid('Invalid provider ID'),
  clientid: z.string().optional(),
  clientkey: z.string().optional(),
  clientsecret: z.string().optional(),
  schedule: z.string().optional(),
  endpoints: z.array(z.string()).default([]),
});

const updateConnectionSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  active: z.boolean().optional(),
  clientid: z.string().optional(),
  clientkey: z.string().optional(),
  clientsecret: z.string().optional(),
  schedule: z
    .enum(
      ['1 min', '5 min', '10 min', '30 min', '1 hour', '2 hours', '6 hours', '12 hours', 'daily', 'weekly'],
      {
        errorMap: () => ({
          message:
            'Schedule must be one of: 1 min, 5 min, 10 min, 30 min, 1 hour, 2 hours, 6 hours, 12 hours, daily, weekly',
        }),
      },
    )
    .optional(),
  endpoints: z.array(z.string()).optional(),
});

const completeConnectionSchema = z.object({
  state: z.string(),
  code: z.string(),
});

const completeProxyConnectionSchema = z.object({
  connectionId: z.string().uuid('Invalid connection ID'),
  accessToken: z.string().min(1, 'Access token is required'),
  proxyRefreshToken: z.string().min(1, 'Proxy refresh token is required'),
  expiresIn: z.number().int().positive().optional(),
  provider: z.string().min(1, 'Provider is required'),
  userProviderId: z.string().min(1, 'User provider ID is required'),
  email: z.string().email().optional(),
});

@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly clientFactory: ClientFactory,
    private readonly connectionService: ConnectionService,
    private readonly cloudOAuthProxyService: CloudOAuthProxyService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConnectionsController.name);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createConnectionSchema)) input: CreateConnectionDto,
  ) {
    const serviceContext = toServiceContext(context);

    const connection = await this.connectionService.create(serviceContext, input);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { accessToken, refreshToken, ...returnedConnection } = connection;

    return returnedConnection;
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    const connections = await this.connectionService.findAll(serviceContext);

    return connections.map((connection) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { accessToken, refreshToken, ...returnedConnection } = connection;

      return returnedConnection;
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    const connection = await this.connectionService.findById(serviceContext, id);

    if (connection == null) {
      throw new NotFoundException();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { accessToken, refreshToken, ...returnedConnection } = connection;

    return returnedConnection;
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(updateConnectionSchema)) input: UpdateConnectionDto,
  ) {
    const serviceContext = toServiceContext(context);

    const connection = await this.connectionService.update(serviceContext, id, input);

    if (connection == null) {
      throw new NotFoundException();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { accessToken, refreshToken, ...returnedConnection } = connection;

    return returnedConnection;
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async delete(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    await this.connectionService.remove(serviceContext, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/connect')
  async connect(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    const connection = await this.connectionService.findById(serviceContext, id);

    if (connection == null) {
      this.logger.log('Attempted to connect a `null` connection');

      throw new NotFoundException();
    }

    // When CI Cloud proxy is enabled, get the authorization URL from CI Cloud.
    // CI Cloud holds all OAuth secrets so they never need to live on this box.
    if (this.cloudOAuthProxyService.isEnabled) {
      const provider = this.cloudOAuthProxyService.getProviderNameForId(connection.providerId);

      if (!provider) {
        this.logger.log('Attempted cloud proxy connect with unknown provider', {
          providerId: connection.providerId,
        });
        throw new InternalServerErrorException();
      }

      // Build the callback URL from the configured OAUTH_CALLBACK_URL, embedding
      // the connectionId so we know which connection to update on return.
      const baseCallbackUrl = config.auth.oauth.callbackUrl;
      const callbackUrl = `${baseCallbackUrl}?connectionId=${connection.id}`;

      const { authorization_url } = await this.cloudOAuthProxyService.getAuthorizationUrl(
        provider,
        callbackUrl,
        connection.activeEndpoints.length > 0 ? connection.activeEndpoints : undefined,
      );

      return { url: authorization_url };
    }

    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    if (client == null) {
      this.logger.log('Attmpted to connect without an associated client');

      throw new InternalServerErrorException();
    }

    return {
      url: await client.getAuthorizationUrl(connection),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('complete')
  @HttpCode(204)
  async completeCallback(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(completeConnectionSchema)) body: CompleteConnectionDto,
  ) {
    const serviceContext = toServiceContext(context);

    const { state: connectionId, code } = body;

    const connection = await this.connectionService.findById(serviceContext, connectionId);

    if (connection == null) {
      this.logger.log('Performed a callback on `null` connection');

      throw new NotFoundException();
    }

    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    if (client == null) {
      this.logger.log('Performed a callback without an associated client');

      throw new InternalServerErrorException();
    }

    const tokenExchange = await client.exchangeAuthorizationCode(code);

    await this.update(context, connectionId, {
      ...tokenExchange,
      active: true,
      needsReauth: false,
    });

    const conn = await this.connectionService.findById(serviceContext, connectionId);

    const externalId = await client.getAccountIdentifier(conn!);

    const existingConnection = await this.connectionService.search(serviceContext, {
      providerId: conn!.providerId,
      active: true,
      externalId: externalId,
    });

    if (existingConnection.length > 0 && existingConnection.find((c) => c.id !== connectionId)) {
      await this.connectionService.remove(serviceContext, connectionId);
      throw new ConflictException('A connection to that account already exists');
    }

    await this.update(context, connectionId, {
      externalId,
    });
  }

  /**
   * POST /connections/complete-proxy
   *
   * Called by the frontend after CI Cloud redirects back with OAuth tokens.
   * CI Cloud has already exchanged the authorization code and stored the
   * encrypted refresh token — we receive an access token and an opaque
   * proxy_refresh_token to use for future refreshes.
   */
  @UseGuards(JwtAuthGuard)
  @Post('complete-proxy')
  @HttpCode(204)
  async completeProxyCallback(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(completeProxyConnectionSchema))
    body: {
      connectionId: string;
      accessToken: string;
      proxyRefreshToken: string;
      expiresIn?: number;
      provider: string;
      userProviderId: string;
      email?: string;
    },
  ) {
    const serviceContext = toServiceContext(context);

    const { connectionId, accessToken, proxyRefreshToken, expiresIn, userProviderId } = body;

    const connection = await this.connectionService.findById(serviceContext, connectionId);

    if (connection == null) {
      this.logger.log('Performed a proxy callback on `null` connection');
      throw new NotFoundException();
    }

    const tokenExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    // Save tokens — proxyRefreshToken is stored in the refreshToken column so
    // token-refresh logic can treat it as an opaque refresh credential.
    await this.update(context, connectionId, {
      accessToken,
      refreshToken: proxyRefreshToken,
      tokenExpiry,
      active: true,
      needsReauth: false,
      externalId: userProviderId,
    });

    // Check for duplicate connections on the same provider account.
    const existingConnections = await this.connectionService.search(serviceContext, {
      providerId: connection.providerId,
      active: true,
      externalId: userProviderId,
    });

    if (existingConnections.length > 0 && existingConnections.find((c) => c.id !== connectionId)) {
      await this.connectionService.remove(serviceContext, connectionId);
      throw new ConflictException('A connection to that account already exists');
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/sync')
  @HttpCode(204)
  async sync(@Context() context: RequestContext, @Param('id') id: string) {
    this.logger.log('Manual sync requested', {
      userId: context.userId,
      connectionId: id,
    });

    const jobIds = await this.eventService.send(Events.SYNC_CONNECTION, {
      connectionId: id,
      userId: context.userId!,
    });

    this.logger.log('Manual sync enqueued', {
      jobIds,
    });
  }
}

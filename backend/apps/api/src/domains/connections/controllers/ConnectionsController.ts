import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { BaseOAuth2Client } from '@ci/domains/connections/clients/BaseOAuth2Client';
import { EventService } from '@ci/domains/events';

import { ClientFactory } from '../clients';
import { CloudOAuthProxyService } from '../services/CloudOAuthProxyService';
import { ConnectionService } from '../services/ConnectionService';
import type { CompleteConnectionDto, CreateConnectionDto, UpdateConnectionDto } from '../types';

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

const completeConnectionSchema = z.discriminatedUnion('flow', [
  z.object({
    flow: z.literal('proxy'),
    state: z.string(),
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresIn: z.number().int().positive().optional(),
    userProviderId: z.string(),
  }),
  z.object({
    flow: z.literal('direct'),
    state: z.string(),
    code: z.string(),
  }),
]);

const completeOpenIDSchema = z.object({
  params: z.record(z.string()),
});

interface CompleteOpenIDDto {
  params: Record<string, string>;
}

// Steam's fixed OpenID 2.0 OP endpoint. The value in the callback body is
// attacker-controlled and must never be used as the verification target; we
// always verify against this constant (mirrors SteamClient.authorizationEndpoint).
const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly clientFactory: ClientFactory,
    private readonly cloudOAuthProxyService: CloudOAuthProxyService,
    private readonly connectionService: ConnectionService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConnectionsController.name);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
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

  @UseGuards(JwtOrApiKeyAuthGuard)
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

  @UseGuards(JwtOrApiKeyAuthGuard)
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

  @UseGuards(JwtOrApiKeyAuthGuard)
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

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async delete(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    await this.connectionService.remove(serviceContext, id);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id/connect')
  async connect(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    const connection = await this.connectionService.findById(serviceContext, id);

    if (connection == null) {
      this.logger.log('Attempted to connect a `null` connection');

      throw new NotFoundException();
    }

    const client = this.clientFactory.getClientByProviderId(
      connection.provider?.id,
    ) as BaseOAuth2Client | null;

    if (client == null) {
      this.logger.log('Attempted to connect without an associated client');

      throw new InternalServerErrorException();
    }

    const clientCredentials = await client.getClientCredentials(connection);

    //If the user has saved OAuth credentials for this provider, then just return the auth url generated for their OAuth app.
    //Otherwise refresh through the proxy service on CI Portal
    if (clientCredentials) {
      return {
        url: await client.getAuthorizationUrl(connection),
      };
    } else {
      const provider = this.cloudOAuthProxyService.getProviderNameForId(connection.providerId);

      if (!provider) {
        this.logger.log('Attempted cloud proxy connect with unknown provider', {
          providerId: connection.providerId,
        });
        throw new InternalServerErrorException();
      }

      // Build the callback URL from the configured OAUTH_CALLBACK_URL, embedding
      // the connectionId so we know which connection to update on return.
      const baseCallbackUrl = config.auth.oauth.callbackUrl || `${process.env.APP_PUBLIC_URL}/oauth/callback`;
      const callbackUrl = `${baseCallbackUrl}?connectionId=${connection.id}`;

      const scopes = client.getScopesFromActiveEndpoints(connection.activeEndpoints);

      const { authorization_url } = await this.cloudOAuthProxyService.getAuthorizationUrl(
        provider,
        callbackUrl,
        scopes.length > 0 ? scopes.split(' ') : undefined,
      );

      return { url: authorization_url };
    }
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('complete')
  @HttpCode(204)
  async completeCallback(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(completeConnectionSchema)) body: CompleteConnectionDto,
  ) {
    const serviceContext = toServiceContext(context);

    const { state: connectionId } = body;

    const connection = await this.connectionService.findById(serviceContext, connectionId);

    if (connection == null) {
      this.logger.log('Performed a callback on `null` connection');

      throw new NotFoundException();
    }

    if (body.flow === 'proxy') {
      // CI Cloud proxy flow: tokens already exchanged by CI Cloud.
      // Check for duplicate connection before storing tokens.
      const existingConnections = await this.connectionService.search(serviceContext, {
        providerId: connection.providerId,
        active: true,
        externalId: body.userProviderId,
      });

      if (existingConnections.length > 0 && existingConnections.find((c) => c.id !== connectionId)) {
        await this.connectionService.remove(serviceContext, connectionId);
        throw new ConflictException('A connection to that account already exists');
      }

      const tokenExpiry = body.expiresIn ? new Date(Date.now() + body.expiresIn * 1000) : null;

      await this.update(context, connectionId, {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken ?? null,
        tokenExpiry,
        active: true,
        needsReauth: false,
        externalId: body.userProviderId,
      });

      return;
    }

    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    if (client == null) {
      this.logger.log('Performed a callback without an associated client');

      throw new InternalServerErrorException();
    }

    const tokenExchange = await client.exchangeAuthorizationCode(connection, body.code);

    await this.update(context, connectionId, {
      ...tokenExchange,
      active: true,
      needsReauth: false,
    });

    const conn = await this.connectionService.findById(serviceContext, connectionId);

    let externalId: string;
    try {
      externalId = await client.getAccountIdentifier(conn!);
    } catch (error) {
      this.logger.error('Failed to retrieve account identifier after token exchange', {
        connectionId,
        error: (error as Error).message,
      });
      await this.connectionService.update(serviceContext, connectionId, {
        needsReauth: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((error as any).details?.code === 403) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        throw new ForbiddenException((error as any).details.message);
      } else {
        throw error;
      }
    }

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

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('openid/complete')
  @HttpCode(204)
  async completeOpenIDCallback(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(completeOpenIDSchema)) body: CompleteOpenIDDto,
  ) {
    const serviceContext = toServiceContext(context);
    const { params } = body;

    const claimedId = params['openid.claimed_id'];
    const identity = params['openid.identity'];
    const opEndpoint = params['openid.op_endpoint'];
    const connectionId = params['connection_id'];

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

    if (!claimedId || !identity || !opEndpoint) {
      this.logger.log('Missing required OpenID parameters');
      throw new InternalServerErrorException('Missing required OpenID parameters');
    }

    // Validate that the claimed_id is from a trusted Steam OpenID endpoint
    if (!claimedId.startsWith('https://steamcommunity.com/openid/id/')) {
      this.logger.log('Invalid OpenID claimed_id', { claimedId });
      throw new UnauthorizedException('Invalid OpenID claimed_id');
    }

    // The op_endpoint arrives in the callback body and is fully attacker-
    // controlled. Verifying against it is a blind SSRF (fetch any URL) AND an
    // identity bypass (attacker's server answers "is_valid:true"). Steam's OP
    // endpoint is a fixed, well-known constant — always verify against that and
    // reject any callback that claims a different one.
    if (opEndpoint !== STEAM_OPENID_ENDPOINT) {
      this.logger.log('Untrusted OpenID op_endpoint', { opEndpoint });
      throw new UnauthorizedException('Untrusted OpenID op_endpoint');
    }

    // --- Direct Verification (Section 11.4.2) ---
    // Send all params back to the OP with openid.mode changed to check_authentication
    const verifyParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (key === 'openid.mode') {
        verifyParams.set(key, 'check_authentication');
      } else {
        verifyParams.set(key, value);
      }
    }

    const verifyResponse = await fetch(STEAM_OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyParams.toString(),
    });

    const verifyBody = await verifyResponse.text();
    const isValid = verifyBody.includes('is_valid:true');

    if (!isValid) {
      this.logger.log('OpenID signature verification failed', { verifyBody });
      throw new UnauthorizedException('OpenID signature verification failed');
    }

    // Extract the Steam ID from the claimed_id URL
    const steamId = claimedId.split('/').pop();

    if (!steamId) {
      throw new InternalServerErrorException('Could not extract Steam ID from claimed_id');
    }

    // Find the pending connection for this user.
    // The connection was already created by ProvidersController.connect() when the user
    // initiated the OpenID flow — find it by looking for an inactive connection with
    // the Steam provider for this user.
    const existingConnection = await this.connectionService.search(serviceContext, {
      providerId: connection!.providerId,
      active: true,
      externalId: steamId,
    });

    if (existingConnection.length > 0 && existingConnection.find((c) => c.id !== connectionId)) {
      await this.connectionService.remove(serviceContext, connectionId);
      throw new ConflictException('A connection to that account already exists');
    }

    // Activate the connection and set the external ID to the Steam ID
    await this.connectionService.update(serviceContext, connectionId, {
      active: true,
      needsReauth: false,
      externalId: steamId,
    });
  }
}

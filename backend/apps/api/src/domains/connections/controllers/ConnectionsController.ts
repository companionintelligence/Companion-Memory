import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  ForbiddenException,
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

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { BaseOAuth2Client } from '@ci/domains/connections/clients/BaseOAuth2Client';
import { EventService } from '@ci/domains/events';

import { ClientFactory } from '../clients';
import type { TokenExchange } from '../clients/types';
import type { Connection } from '../entities/ConnectionEntity';
import { CloudOAuthProxyService } from '../services/CloudOAuthProxyService';
import { ConnectionService } from '../services/ConnectionService';
import {
  type CompleteConnectionDto,
  completeConnectionSchema,
  type CreateConnectionDto,
  type UpdateConnectionDto,
} from '../types';

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

type ProxyCompletion = Extract<CompleteConnectionDto, { flow: 'proxy' }>;

/**
 * How long completing a proxied connection waits on CI Portal's token refresh. CI Portal
 * waits on the provider's token endpoint in turn and neither request times out on its
 * own, so without a bound a stalled one holds the callback page's spinner for minutes.
 */
const PORTAL_REFRESH_TIMEOUT_MS = 30_000;

/**
 * When a token that lives `seconds` from now expires; null when that is not a positive
 * number of seconds a date can hold. A numeric string counts, as it already does on the
 * refresh path in `BaseOAuth2Client`: CI Portal passes the provider's `expires_in` on as
 * it came.
 */
function expiryAfter(seconds: unknown): Date | null {
  const n = typeof seconds === 'string' ? Number(seconds) : seconds;

  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    return null;
  }

  const expiry = new Date(Date.now() + n * 1000);

  return Number.isNaN(expiry.getTime()) ? null : expiry;
}

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

    const { accessToken, refreshToken, ...returnedConnection } = connection;

    return returnedConnection;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    const connections = await this.connectionService.findAll(serviceContext);

    return connections.map((connection) => {
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

    const { accessToken, refreshToken, ...returnedConnection } = connection;

    return returnedConnection;
  }

  // NOTE: DELETE /connections/:id is intentionally NOT defined here. Disconnect
  // is a destructive, CASA/ASVS-V8 operation (revoke the OAuth grant + purge the
  // connection's derived data), so it lives in the privacy domain's
  // ConnectionPrivacyController (which owns the DataDeletionService) to keep the
  // connections domain free of a dependency cycle on privacy.

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

    // Refused before anything is looked up, removed or spent: a proxied completion
    // with neither token has nothing to store.
    if (body.flow === 'proxy' && !body.refreshToken && !body.accessToken) {
      throw new BadRequestException('Missing proxy credentials');
    }

    const connection = await this.connectionService.findById(serviceContext, connectionId);

    if (connection == null) {
      this.logger.log('Performed a callback on `null` connection');

      throw new NotFoundException();
    }

    if (body.flow === 'proxy') {
      // CI Cloud proxy flow: CI Cloud already exchanged the code.
      // Check for duplicate connection before storing tokens.
      const existingConnections = await this.connectionService.search(serviceContext, {
        providerId: connection.providerId,
        active: true,
        externalId: body.userProviderId,
      });

      const duplicate = existingConnections.find((c) => c.id !== connectionId);

      if (duplicate) {
        await this.adoptProxyGrant(serviceContext, connection, duplicate, body);
        await this.connectionService.remove(serviceContext, connectionId);
        throw new ConflictException('A connection to that account already exists');
      }

      const tokens = await this.proxyTokens(body);

      await this.update(context, connectionId, {
        ...tokens,
        active: true,
        needsReauth: false,
        externalId: body.userProviderId,
      });

      const stored = await this.connectionService.findById(serviceContext, connectionId);
      if (stored) {
        await this.persistAccountLabel(serviceContext, stored);
      }

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

    const labeled = await this.connectionService.findById(serviceContext, connectionId);
    if (labeled) {
      await this.persistAccountLabel(serviceContext, labeled);
    }
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

  /**
   * The tokens a proxied connection is stored with.
   *
   * ⚠ NOT THE ACCESS TOKEN THE BROWSER CARRIED, whenever there is a better one
   * (CI-Server#2676). CI Portal returns the provider's access token through the
   * browser's URL fragment, so what reaches this handler is whatever the page
   * was given and cannot be checked. With a proxy refresh token, the access
   * token is fetched from CI Portal over the device-authenticated channel
   * instead — which is also what lets CI Portal stop sending it to the browser.
   *
   * A grant CI Portal holds no refresh token for — one whose token response
   * carries none, Facebook's for instance — arrives with only the access token,
   * and that remains the only token there is.
   */
  private async proxyTokens(body: ProxyCompletion): Promise<TokenExchange> {
    if (body.refreshToken) {
      return this.refreshThroughPortal(body.state, body.refreshToken);
    }

    if (body.accessToken) {
      return { accessToken: body.accessToken, refreshToken: null, tokenExpiry: expiryAfter(body.expiresIn) };
    }

    // `completeCallback` refuses this before anything is looked up; kept so a
    // connection is never stored with no token at all.
    throw new BadRequestException('Missing proxy credentials');
  }

  /**
   * The tokens CI Portal returns for a proxy refresh token.
   *
   * ⚠ CI PORTAL ROTATES THE PROXY REFRESH TOKEN ON EVERY USE. The one passed in
   * is spent by this call, so the rotated one CI Portal returns is what must be
   * stored; keeping the spent one would leave a connection that can never
   * refresh. If CI Portal returns none, none is stored.
   */
  private async refreshThroughPortal(
    connectionId: string,
    proxyRefreshToken: string,
  ): Promise<TokenExchange> {
    const refreshed = await this.cloudOAuthProxyService
      .refreshAccessToken(proxyRefreshToken, { signal: AbortSignal.timeout(PORTAL_REFRESH_TIMEOUT_MS) })
      .catch((error: unknown) => {
        // `err`, not `error.message`: a network failure's message is only
        // "fetch failed", with the reason in its `cause`.
        this.logger.error('Could not fetch the access token for a proxied connection from CI Portal', {
          connectionId,
          err: error,
        });

        throw new BadGatewayException('Could not complete the connection through CI Portal', {
          cause: error,
          description: 'Bad Gateway',
        });
      });

    if (typeof refreshed?.access_token !== 'string' || refreshed.access_token === '') {
      this.logger.error('CI Portal returned no access token for a proxied connection', { connectionId });
      throw new BadGatewayException('Could not complete the connection through CI Portal');
    }

    return {
      accessToken: refreshed.access_token,
      refreshToken:
        typeof refreshed.refresh_token === 'string' && refreshed.refresh_token !== ''
          ? refreshed.refresh_token
          : null,
      tokenExpiry: expiryAfter(refreshed.expires_in),
    };
  }

  /**
   * Hand the proxy grant a refused duplicate carried to the connection that
   * already holds that account.
   *
   * ⚠ BY NOW THAT CONNECTION'S OWN PROXY REFRESH TOKEN IS DEAD. CI Portal keeps
   * one credential per (device, provider, account), and its callback replaced
   * that credential's proxy refresh token with the one in this request before
   * redirecting here. Refusing the duplicate without keeping it would leave the
   * existing connection unable to ever refresh again.
   *
   * ⚠ ONLY AFTER THE PROVIDER CONFIRMS THE ACCOUNT. `existing` was found by the
   * browser-supplied `userProviderId`, which nothing ties to the proxy refresh
   * token, so without this check a body pairing one account's grant with another
   * account's id would overwrite that other connection's tokens.
   *
   * Best-effort: the duplicate is refused either way, and a failure or a mismatch
   * leaves the existing connection as it was.
   */
  private async adoptProxyGrant(
    context: UserServiceContext,
    pending: Connection,
    existing: Connection,
    body: ProxyCompletion,
  ): Promise<void> {
    // Without a proxy refresh token CI Portal stored nothing, so nothing was replaced.
    if (!body.refreshToken) {
      return;
    }

    try {
      const tokens = await this.refreshThroughPortal(existing.id, body.refreshToken);
      const client = this.clientFactory.getClientByProviderId(pending.provider?.id);
      const accountId = await client?.getAccountIdentifier({ ...existing, accessToken: tokens.accessToken });

      if (!accountId || accountId !== existing.externalId) {
        this.logger.warn('Not handing a CI Portal grant to a connection for a different account', {
          connectionId: existing.id,
        });

        return;
      }

      await this.connectionService.update(context, existing.id, tokens);
    } catch (error) {
      this.logger.warn(
        'Could not hand the CI Portal grant of a reconnected account to its existing connection',
        {
          connectionId: existing.id,
          err: error,
        },
      );
    }
  }

  private async persistAccountLabel(context: UserServiceContext, connection: Connection): Promise<void> {
    if (connection.accountLabel) {
      return;
    }

    try {
      const label = await this.clientFactory
        .getClientByProviderId(connection.providerId)
        .getAccountLabel(connection);
      if (!label) {
        return;
      }

      await this.connectionService.update(context, connection.id, { accountLabel: label });
    } catch (error) {
      this.logger.warn('Could not record account label for connection', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

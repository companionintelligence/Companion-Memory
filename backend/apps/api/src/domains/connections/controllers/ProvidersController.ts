import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { BaseOAuth2Client } from '@ci/domains/connections/clients/BaseOAuth2Client';

import { ClientFactory } from '../clients';
import { CloudOAuthProxyService } from '../services/CloudOAuthProxyService';
import { ConnectionService } from '../services/ConnectionService';
import { ProviderKeyService } from '../services/ProviderKeyService';
import { ProviderService } from '../services/ProviderService';
import { connectProviderDto, connectProviderSchema } from '../types';

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly clientFactory: ClientFactory,
    private readonly cloudOAuthProxyService: CloudOAuthProxyService,
    private readonly connectionService: ConnectionService,
    private readonly providerService: ProviderService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ProvidersController.name);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.providerService.findAll(serviceContext);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    return this.providerService.findById(serviceContext, id);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post(':id')
  async connect(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(connectProviderSchema)) input: connectProviderDto,
  ) {
    const serviceContext = toServiceContext(context);

    const provider = await this.providerService.findById(serviceContext, id);

    if (provider == null) {
      this.logger.log('Attempted to connect to a provider that does not exist');

      throw new NotFoundException();
    }

    const client = this.clientFactory.getClientByProviderId(id) as BaseOAuth2Client | null;

    if (client == null) {
      this.logger.log('Attempted to create a connection without an associated client');

      throw new InternalServerErrorException();
    }

    if (provider.authType === 'openid') {
      const apiKey = input.apiKey;

      if (!apiKey) {
        this.logger.log('Missing API key for OpenID connection');

        throw new BadRequestException('API key is required for OpenID provider');
      }

      const connection = await this.connectionService.create(serviceContext, {
        providerId: provider.id,
        name: provider.name ?? 'My Connection', // TODO: We shouldn't require a name here.
        accessToken: apiKey,
        schedule: '1 hour',
        endpoints: input.endpoints,
      });

      const authorizationUrl = await client.getAuthorizationUrl(connection);

      return {
        authorizationUrl,
      };
    }

    if (provider.localOnly) {
      const providerKeys = await this.providerKeyService.findByProviderId(serviceContext, provider.id);

      if (!providerKeys) {
        this.logger.error('Missing provider keys for local-only provider', { providerId: id });
        throw new InternalServerErrorException('Provider keys not configured for local-only provider');
      }
    }

    const oauthClient = client as BaseOAuth2Client;
    const connection = await this.connectionService.create(serviceContext, {
      providerId: provider.id,
      name: provider.name ?? 'My Connection', // TODO: We shouldn't require a name here.
      schedule: '1 hour',
      endpoints: input.endpoints,
    });

    const credentials = await oauthClient.getClientCredentials(connection);

    if (credentials) {
      const authorizationUrl = await oauthClient.getAuthorizationUrl(connection);

      return {
        authorizationUrl,
      };
    }

    const providerName = this.cloudOAuthProxyService.getProviderNameForId(id);

    if (!providerName) {
      this.logger.error('CI Cloud proxy enabled but provider is not mapped', { providerId: id });
      throw new InternalServerErrorException('Provider not configured for CI Cloud proxy');
    }

    const baseCallbackUrl = config.auth.oauth.callbackUrl || `${process.env.APP_PUBLIC_URL}/oauth/callback`;
    const callbackUrl = `${baseCallbackUrl}?connectionId=${connection.id}`;

    const scopes = client.getScopesFromActiveEndpoints(input.endpoints);
    const { authorization_url } = await this.cloudOAuthProxyService.getAuthorizationUrl(
      providerName,
      callbackUrl,
      scopes.length > 0 ? scopes.split(' ') : undefined,
    );

    return { authorizationUrl: authorization_url };
  }
}

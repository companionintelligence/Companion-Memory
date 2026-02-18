import {
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
import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';

import { ClientFactory } from '../clients';
import { ConnectionService } from '../services/ConnectionService';
import { CloudOAuthProxyService } from '../services/CloudOAuthProxyService';
import { ProviderService } from '../services/ProviderService';
import { connectProviderDto, connectProviderSchema } from '../types';

import config from '@ci/configuration';

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly clientFactory: ClientFactory,
    private readonly connectionService: ConnectionService,
    private readonly providerService: ProviderService,
    private readonly cloudOAuthProxyService: CloudOAuthProxyService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ProvidersController.name);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.providerService.findAll(serviceContext);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    return this.providerService.findById(serviceContext, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id')
  async connect(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(connectProviderSchema)) input: connectProviderDto,
  ) {
    const serviceContext = toServiceContext(context);

    const provider = await this.providerService.findById(serviceContext, id);

    if (provider == null) {
      this.logger.log('Attmpted to connect to a provider that does not exist');

      throw new NotFoundException();
    }

    // When CI Cloud proxy is enabled, secrets live in CI Cloud — skip env var checks
    // and get the authorization URL directly from CI Cloud.
    if (this.cloudOAuthProxyService.isEnabled) {
      const providerName = this.cloudOAuthProxyService.getProviderNameForId(id);

      if (!providerName) {
        this.logger.error('CI Cloud proxy enabled but provider is not mapped', { providerId: id });
        throw new InternalServerErrorException('Provider not configured for CI Cloud proxy');
      }

      const connection = await this.connectionService.create(serviceContext, {
        providerId: provider.id,
        name: provider.name ?? 'My Connection',
        schedule: '1 hour',
        endpoints: input.endpoints,
      });

      const callbackUrl = `${config.auth.oauth.callbackUrl}?connectionId=${connection.id}`;

      const { authorization_url } = await this.cloudOAuthProxyService.getAuthorizationUrl(
        providerName,
        callbackUrl,
        input.endpoints.length > 0 ? input.endpoints : undefined,
      );

      return { authorizationUrl: authorization_url };
    }

    const client = this.clientFactory.getClientByProviderId(id);

    if (client == null) {
      this.logger.log('Attmpted to create a connection without an associated client');

      throw new InternalServerErrorException();
    }

    const clientIdVariable = `${provider.name?.toUpperCase()}_CLIENT_ID`;
    const clientSecretVariable = `${provider.name?.toUpperCase()}_CLIENT_SECRET`;

    // TODO:
    //   These are stand-in variables for user settings with fallback defaults.
    //   We need to eventually replace this with a more robust system where we're
    //   POST-ing to a gateway with protected keys, or a local API endpoint with
    //   user-specified key overrides.
    const clientId = process.env[clientIdVariable];
    const clientSecret = process.env[clientSecretVariable];

    if (!clientId) {
      this.logger.error(`Expected environment variable ${clientIdVariable} not specified`);

      throw new InternalServerErrorException('Client id not configured for provider');
    }

    if (!clientSecret) {
      this.logger.error(`Expected environment variable ${clientSecretVariable} not specified`);

      throw new InternalServerErrorException('Client secret not configured for provider');
    }

    const connection = await this.connectionService.create(serviceContext, {
      providerId: provider.id,
      name: provider.name ?? 'My Connection', // TODO: We shouldn't require a name here.
      clientid: clientId,
      clientsecret: clientSecret,
      schedule: '1 hour',
      endpoints: input.endpoints,
    });

    const authorizationUrl = await client.getAuthorizationUrl(connection);

    return {
      authorizationUrl,
    };
  }
}

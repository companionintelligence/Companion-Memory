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
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { BaseOAuth2Client } from '@ci/domains/connections/clients/BaseOAuth2Client';

import { ClientFactory } from '../clients';
import { ConnectionService } from '../services/ConnectionService';
import { ProviderService } from '../services/ProviderService';
import { connectProviderDto, connectProviderSchema } from '../types';

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly clientFactory: ClientFactory,
    private readonly connectionService: ConnectionService,
    private readonly providerService: ProviderService,
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
      this.logger.log('Attmpted to connect to a provider that does not exist');

      throw new NotFoundException();
    }

    const client = this.clientFactory.getClientByProviderId(id);

    if (client == null) {
      this.logger.log('Attmpted to create a connection without an associated client');

      throw new InternalServerErrorException();
    }

    if (provider.authType === 'openid') {
      const apiKey = input.apiKey;

      if (!apiKey) {
        this.logger.log('Missing API key for OpenID connection');

        throw new InternalServerErrorException('API key is required for OpenID provider');
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
    } else if (provider.authType === 'oauth2') {
      const connection = await this.connectionService.create(serviceContext, {
        providerId: provider.id,
        name: provider.name ?? 'My Connection', // TODO: We shouldn't require a name here.
        schedule: '1 hour',
        endpoints: input.endpoints,
      });

      try {
        await (client as BaseOAuth2Client).getClientCredentials(connection);
      } catch (err) {
        this.logger.error('Failed to resolve client credentials', {
          error: err instanceof Error ? err.message : 'Unknown error',
        });

        throw new InternalServerErrorException(
          err instanceof Error ? err.message : 'Client credentials not configured for provider',
        );
      }

      const authorizationUrl = await client.getAuthorizationUrl(connection);

      return {
        authorizationUrl,
      };
    }
  }
}

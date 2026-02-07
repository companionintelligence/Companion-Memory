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

import { resolveOAuthCredentials } from '../catalog';
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

    const client = this.clientFactory.getClientByProviderId(id);

    if (client == null) {
      this.logger.log('Attmpted to create a connection without an associated client');

      throw new InternalServerErrorException();
    }

    // TODO:
    //   These are stand-in variables for user settings with fallback defaults.
    //   We need to eventually replace this with a more robust system where we're
    //   POST-ing to a gateway with protected keys, or a local API endpoint with
    //   user-specified key overrides.
    const { clientId, clientSecret, clientIdVars, clientSecretVars } = resolveOAuthCredentials(
      provider.id,
      provider.name,
    );

    if (!clientId) {
      this.logger.error(`Expected one of environment variables ${clientIdVars.join(', ')} to be specified`);

      throw new InternalServerErrorException('Client id not configured for provider');
    }

    if (!clientSecret) {
      this.logger.error(
        `Expected one of environment variables ${clientSecretVars.join(', ')} to be specified`,
      );

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

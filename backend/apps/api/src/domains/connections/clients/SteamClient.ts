import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import { BaseOpenIDClient } from './BaseOpenIDClient';

@Injectable()
export class SteamClient extends BaseOpenIDClient {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(SteamClient.name);
  }

  protected readonly authorizationEndpoint = 'https://steamcommunity.com/openid/login';

  protected readonly baseUrl = 'https://api.steampowered.com';
}

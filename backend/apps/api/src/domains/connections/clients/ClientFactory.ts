import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

import { BaseClient as Client } from './BaseClient';
import { GoogleClient } from './GoogleClient';
import { MicrosoftClient } from './MicrosoftClient';

@Injectable()
export class ClientFactory {
  private readonly providers = new Map<string, Client>();

  constructor() {
    this.providers.set(config.auth.providers.google.id, new GoogleClient());
    this.providers.set(config.auth.providers.microsoft.id, new MicrosoftClient());
  }

  getClientByProviderId(providerId: string | null | undefined): Client {
    if (providerId == null) {
      throw new Error('API client requested for a null Provider');
    }

    const provider = this.providers.get(providerId);

    if (provider == null) {
      throw new Error(`Unsupported Provider id: ${providerId}`);
    }

    return provider;
  }
}

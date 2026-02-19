import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

import { BaseClient as Client } from './BaseClient';
import { BlueBubblesClient } from './BlueBubblesClient';
import { FacebookClient } from './FacebookClient';
import { GoogleClient } from './GoogleClient';
import { MicrosoftClient } from './MicrosoftClient';

@Injectable()
export class ClientFactory {
  private readonly providers = new Map<string, Client>();

  constructor(
    private readonly googleClient: GoogleClient,
    private readonly microsoftClient: MicrosoftClient,
    private readonly facebookClient: FacebookClient,
    private readonly blueBubblesClient: BlueBubblesClient,
  ) {
    this.providers.set(config.auth.providers.google.id, this.googleClient);
    this.providers.set(config.auth.providers.microsoft.id, this.microsoftClient);
    this.providers.set(config.auth.providers.facebook.id, this.facebookClient);
    this.providers.set(config.auth.providers.bluebubbles.id, this.blueBubblesClient);
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

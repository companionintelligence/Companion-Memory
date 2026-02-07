import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';
import { getProviderCatalogByProviderId } from '@ci/domains/connections/catalog';

import { BaseClient as Client } from './BaseClient';
import { CatalogMockClient } from './CatalogMockClient';
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
    private readonly catalogMockClient?: CatalogMockClient,
  ) {
    this.providers.set(config.auth.providers.google.id, this.googleClient);
    this.providers.set(config.auth.providers.microsoft.id, this.microsoftClient);
    this.providers.set(config.auth.providers.facebook.id, this.facebookClient);
  }

  hasClientForProviderId(providerId: string | null | undefined): boolean {
    return this.getClientByProviderIdOrNull(providerId) != null;
  }

  getClientByProviderIdOrNull(providerId: string | null | undefined): Client | null {
    if (providerId == null) {
      return null;
    }

    const managedClient = this.providers.get(providerId);
    if (managedClient) {
      return managedClient;
    }

    const providerCatalog = getProviderCatalogByProviderId(providerId);
    if (!providerCatalog) {
      return null;
    }

    const mode = process.env[providerCatalog.auth.env.modeVar]?.trim().toLowerCase();
    if (mode === 'mock' && this.catalogMockClient) {
      return this.catalogMockClient;
    }

    return null;
  }

  getClientByProviderId(providerId: string | null | undefined): Client {
    if (providerId == null) {
      throw new Error('API client requested for a null Provider');
    }

    const provider = this.getClientByProviderIdOrNull(providerId);

    if (provider == null) {
      throw new Error(`Unsupported Provider id: ${providerId}`);
    }

    return provider;
  }
}

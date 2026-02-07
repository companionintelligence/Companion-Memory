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

  private resolveProviderId(key: 'google' | 'microsoft' | 'facebook'): string {
    const configuredId = config.auth?.providers?.[key]?.id;

    if (configuredId?.trim()) {
      return configuredId;
    }

    return key;
  }

  constructor(
    private readonly googleClient: GoogleClient,
    private readonly microsoftClient: MicrosoftClient,
    private readonly facebookClient: FacebookClient,
    private readonly catalogMockClient?: CatalogMockClient,
  ) {
    this.providers.set(this.resolveProviderId('google'), this.googleClient);
    this.providers.set(this.resolveProviderId('microsoft'), this.microsoftClient);
    this.providers.set(this.resolveProviderId('facebook'), this.facebookClient);
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

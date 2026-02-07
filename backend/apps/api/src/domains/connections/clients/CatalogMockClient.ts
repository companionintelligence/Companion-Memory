import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { getProviderCatalogByProviderId } from '@ci/domains/connections/catalog';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseClient } from './BaseClient';
import type { SyncResponse, TokenExchange } from './types';

@Injectable()
export class CatalogMockClient extends BaseClient {
  constructor(protected readonly logger: LoggerService) {
    super();
    this.logger.setContext(CatalogMockClient.name);
  }

  async getAuthorizationUrl(connection: Connection): Promise<string> {
    const params = new URLSearchParams({
      state: connection.id,
      code: `mock-${connection.providerId}`,
    });

    return `${config.auth.oauth.callbackUrl}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(code: string): Promise<TokenExchange> {
    void code;

    return {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  async refreshAccessToken(connection: Connection): Promise<TokenExchange> {
    void connection;

    return {
      accessToken: 'mock-access-token-refreshed',
      refreshToken: 'mock-refresh-token',
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    void connection;
    void endpoint;
    void options;

    throw new Error('CatalogMockClient does not proxy arbitrary API requests');
  }

  async sync(connection: Connection): Promise<SyncResponse[]> {
    const provider = getProviderCatalogByProviderId(connection.providerId);

    if (!provider) {
      return [
        {
          success: false,
          message: `No provider catalog entry found for ${connection.providerId}`,
          data: {
            results: [],
            errors: [`No provider catalog entry found for ${connection.providerId}`],
          },
        },
      ];
    }

    const streamMap = new Map(provider.streams.map((stream) => [stream.key, stream]));
    const selectedStreams =
      connection.activeEndpoints.length > 0
        ? connection.activeEndpoints
            .map((endpoint) => streamMap.get(endpoint))
            .filter((stream): stream is NonNullable<typeof stream> => stream != null)
        : provider.streams.filter((stream) => stream.defaultEnabled);

    const syncedAt = new Date().toISOString();
    const results = selectedStreams.map((stream, index) => ({
      api: stream.key,
      data: {
        providerKey: provider.key,
        streamKey: stream.key,
        generatedAt: syncedAt,
        mode: 'mock',
        items: [
          {
            id: `${provider.key}-${stream.key.replace(/\\s+/g, '-').toLowerCase()}-${index + 1}`,
            capturedAt: syncedAt,
          },
        ],
      },
      syncState: {
        cursor: syncedAt,
        strategy: stream.cursorStrategy,
      },
    }));

    const cursor = Object.fromEntries(
      selectedStreams.map((stream) => [
        stream.key,
        {
          cursor: syncedAt,
        },
      ]),
    );

    return [
      {
        success: true,
        message: `${provider.displayName} mock sync completed`,
        data: {
          results,
          errors: [],
        },
        cursor,
      },
    ];
  }

  async getAccountIdentifier(connection: Connection): Promise<string> {
    return `mock:${connection.providerId}:${connection.userId}`;
  }
}

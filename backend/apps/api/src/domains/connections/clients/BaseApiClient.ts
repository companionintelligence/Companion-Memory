import type { Connection } from '../types';

import { BaseClient } from './BaseClient';
import type { SyncResponse, TokenExchange } from './types';

export abstract class BaseApiClient extends BaseClient {
  async getAuthorizationUrl(_connection: Connection): Promise<string> {
    throw new Error('API-based connections do not support OAuth authorization');
  }

  async exchangeAuthorizationCode(_connection: Connection, _code: string): Promise<TokenExchange> {
    throw new Error('API-based connections do not support OAuth token exchange');
  }

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    if (connection.clientkey == null) {
      throw new Error('API key not configured for connection');
    }

    const provider = connection.provider;

    if (provider == null) {
      throw new Error('Connection not associated with a provider');
    }

    if (provider.apiBaseUrl == null) {
      throw new Error('Provider missing base URL configuration');
    }

    const response = await fetch(`${provider.apiBaseUrl}${endpoint}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${connection.clientkey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data: T = await response.json();

    return data;
  }
}
import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseClient } from './BaseClient';
import type { TokenExchange } from './types';

/**
 * Base client for OpenID 2.0 authentication providers.
 * The API key is stored as the accessToken on the connection,
 * and the provider-specific user ID is stored as the externalId.
 */
export abstract class BaseOpenIDClient extends BaseClient {
  protected abstract authorizationEndpoint: string;

  protected abstract baseUrl: string;

  async getAuthorizationUrl(connection: Connection): Promise<string> {
    const params = new URLSearchParams({
      'openid.return_to': `${config.auth.openid.callbackUrl}?connection_id=${connection.id}`,
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.assoc_type': 'HMAC-SHA1',
      'openid.realm': `https://${config.hostname}`,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });

    return `${this.authorizationEndpoint}?${params.toString()}`;
  }

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit) {
    const apiKey = connection.accessToken;

    if (!apiKey) {
      throw new Error('API key not configured on connection');
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${separator}key=${apiKey}`;

    const response = await fetch(fullUrl, {
      ...options,
      headers: {
        ...options?.headers,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return (await response.json()) as T;
  }

  async exchangeAuthorizationCode(): Promise<TokenExchange> {
    throw new Error('OpenID does not use OAuth2 token exchange');
  }

  async refreshAccessToken(): Promise<TokenExchange> {
    throw new Error('OpenID API keys do not require refresh');
  }

  async getAccountIdentifier(connection: Connection) {
    return connection.externalId || '';
  }
}

import config from '@ci/configuration';

import type { Connection } from '../types';

import { BaseClient } from './BaseClient';
import type { TokenExchange, TokenResponse } from './types';

export abstract class BaseOAuth2Client extends BaseClient {
  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    if (connection.accessToken == null) {
      throw new Error('Connection not authenticated');
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
        Authorization: `Bearer ${connection.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data: T = await response.json();

    return data;
  }

  async getAuthorizationUrl(connection: Connection): Promise<string> {
    if (connection.clientid == null) {
      throw new Error('OAuth credentials not configured');
    }

    const provider = connection.provider;

    if (provider == null) {
      throw new Error('Connection not associated with a provider');
    }

    if (provider.tokenHost == null) {
      throw new Error('Provider has no tokenHost specified');
    }

    const authEndpoint = this.mergeUrls([provider.tokenHost, provider.authorizePath]);

    const providerScope = provider.scopes ?? [];
    const resolvedScope = Array.isArray(providerScope) ? providerScope.join(' ') : providerScope;

    const params = new URLSearchParams({
      client_id: connection.clientid,
      redirect_uri: config.auth.oauth.callbackUrl,
      response_type: 'code',
      scope: resolvedScope,
      state: connection.id,
    });

    return `${authEndpoint}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(connection: Connection, code: string): Promise<TokenExchange> {
    if (connection.clientid == null || connection.clientsecret == null) {
      throw new Error('OAuth credentials not configured');
    }

    const provider = connection.provider;

    if (provider == null) {
      throw new Error('Connection not associated with a provider');
    }

    const tokenEndpoint = this.mergeUrls([provider.tokenHost, provider.tokenPath]);

    const tokenParams = new URLSearchParams({
      code,
      client_id: connection.clientid,
      client_secret: connection.clientsecret,
      redirect_uri: config.auth.oauth.callbackUrl,
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      let errorDetails;

      try {
        errorDetails = tokenResponse.json();
      } catch {
        errorDetails = tokenResponse.text();
      }

      this.logger.error('Token exchange failed', {
        status: tokenResponse.status,
        error: errorDetails,
        endpoint: tokenEndpoint,
      });

      throw new Error('Token exchange failed');
    }

    let tokenData: TokenResponse;

    try {
      tokenData = (await tokenResponse.json()) as TokenResponse;
    } catch {
      throw new Error('Invalid token response format');
    }

    const tokenExpiry = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

    return {
      accessToken: tokenData.access_token || null,
      refreshToken: tokenData.refresh_token || null,
      tokenExpiry,
    } satisfies TokenExchange;
  }

  private mergeUrls(urls: (string | null)[]) {
    const result = new URL('http://placeholder');
    let validResult = false;

    result.hostname = '';

    for (const url of urls) {
      if (url == null) {
        continue;
      }

      let parsedUrl;
      let overrideHost = false;

      try {
        parsedUrl = new URL(url);
        overrideHost = true;
      } catch {
        parsedUrl = new URL(url, 'http://placeholder.com');
      }

      if (overrideHost) {
        result.protocol = parsedUrl.protocol;
        result.hostname = parsedUrl.hostname;
        result.username = parsedUrl.username;
        result.port = parsedUrl.port;

        validResult = true;
      }

      result.pathname = parsedUrl.pathname;
    }

    if (!validResult) {
      throw new Error('No URL contains a valid hostname');
    }

    return result.toString();
  }
}

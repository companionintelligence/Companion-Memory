import { BadRequestException, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';

import { firstAccountLabel } from './accountLabel';
import { BaseOAuth2Client, formatTokenExchangeError } from './BaseOAuth2Client';
import type { TokenExchange, TokenResponse } from './types';

export const REDDIT_USER_AGENT = 'web:ci-server:1.0 (by /u/cicompanionintelligence)';

export function getRedditScopesFromActiveEndpoints(
  activeEndpoints: string[],
  endpointScopeMap: Record<string, string[]>,
): string {
  const scopesSet = new Set<string>(endpointScopeMap['default']);

  activeEndpoints.forEach((endpoint) => {
    const scopes = endpointScopeMap[endpoint];
    if (scopes) {
      scopes.forEach((scope) => scopesSet.add(scope));
    }
  });

  return scopesSet.size > 0 ? Array.from(scopesSet).join(' ') : '';
}

@Injectable()
export class RedditClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(RedditClient.name);
  }

  protected readonly baseUrl = 'https://oauth.reddit.com';

  protected readonly authorizationEndpoint = 'https://www.reddit.com/api/v1/authorize';

  protected readonly tokenEndpoint = 'https://www.reddit.com/api/v1/access_token';

  protected readonly endpointScopeMap = {
    Posts: ['history', 'read', 'identity'],
    Comments: ['history', 'read', 'identity'],
    Saved: ['history', 'read', 'save', 'identity'],
    default: ['identity', 'read'],
  };

  protected readonly scopes = ['identity', 'read', 'history', 'save'];

  protected readonly extraAuthParams = {
    duration: 'permanent',
  };

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    return getRedditScopesFromActiveEndpoints(activeEndpoints, this.endpointScopeMap);
  }

  getAccountIdentifier(connection: Connection): Promise<string> {
    return this.fetchUser(connection).then((result) => result.name);
  }

  async getAccountLabel(connection: Connection): Promise<string | null> {
    const user = await this.fetchUser(connection);

    // Reddit's /api/v1/me exposes no email on the `identity` scope, so the
    // username is the only human-readable label available.
    return firstAccountLabel(user.name);
  }

  async requestRaw(connection: Connection, endpoint: string, options?: RequestInit): Promise<Response> {
    if (connection.accessToken == null) {
      throw new Error('Connection not authenticated');
    }

    const endpointSplitOnProtocol = /^(https:\/\/[^/]+)(\/.*)?$/.exec(endpoint);
    const baseUrl = endpointSplitOnProtocol ? endpointSplitOnProtocol[1] : this.baseUrl;
    const path = endpointSplitOnProtocol ? endpointSplitOnProtocol[2] || '' : endpoint;

    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${connection.accessToken}`,
        'User-Agent': REDDIT_USER_AGENT,
      },
    });
  }

  async exchangeAuthorizationCode(connection: Connection, code: string): Promise<TokenExchange> {
    const clientCredentials = await this.getClientCredentials(connection);
    if (!clientCredentials) {
      this.logger.error(
        'Cannot exchangeAuthorizationCode because client credentials not found for connection',
        {
          connectionId: connection.id,
        },
      );

      throw new Error('Cannot exchangeAuthorizationCode because client credentials not found');
    }

    const tokenParams = new URLSearchParams({
      code,
      redirect_uri: config.auth.oauth.callbackUrl || `${process.env.APP_PUBLIC_URL}/oauth/callback`,
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`).toString('base64')}`,
        'User-Agent': REDDIT_USER_AGENT,
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      let errorDetails;

      try {
        const rawErrorDetails = await tokenResponse.text();
        try {
          errorDetails = JSON.parse(rawErrorDetails);
        } catch {
          errorDetails = rawErrorDetails;
        }
      } catch {
        errorDetails = 'Unable to read error response body';
      }

      this.logger.error('Reddit token exchange failed', {
        status: tokenResponse.status,
        error: errorDetails,
        endpoint: this.tokenEndpoint,
      });

      throw new Error(`Token exchange failed: ${formatTokenExchangeError(errorDetails)}`);
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

  async refreshAccessToken(connection: Connection): Promise<TokenExchange> {
    if (!connection.refreshToken) {
      throw new BadRequestException('No refresh token available');
    }

    const clientCredentials = await this.getClientCredentials(connection);

    if (clientCredentials) {
      const tokenParams = new URLSearchParams({
        refresh_token: connection.refreshToken,
        grant_type: 'refresh_token',
      });

      const tokenResponse = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`).toString('base64')}`,
          'User-Agent': REDDIT_USER_AGENT,
        },
        body: tokenParams.toString(),
      });

      if (!tokenResponse.ok) {
        let errorDetails;

        try {
          errorDetails = await tokenResponse.json();
        } catch {
          errorDetails = await tokenResponse.text();
        }

        this.logger.error('Reddit token refresh failed', {
          status: tokenResponse.status,
          error: errorDetails,
          endpoint: this.tokenEndpoint,
        });

        throw new Error(`Token refresh failed: ${formatTokenExchangeError(errorDetails)}`);
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
        refreshToken: tokenData.refresh_token || connection.refreshToken,
        tokenExpiry,
      } satisfies TokenExchange;
    }

    const proxyData = await this.cloudOAuthProxyService.refreshAccessToken(connection.refreshToken);

    const tokenExpiry = proxyData.expires_in ? new Date(Date.now() + proxyData.expires_in * 1000) : null;

    return {
      accessToken: proxyData.access_token,
      refreshToken: proxyData.refresh_token,
      tokenExpiry,
    } satisfies TokenExchange;
  }

  private async fetchUser(connection: Connection) {
    try {
      return await this.request<{
        id: string;
        name: string;
      }>(connection, `/api/v1/me`);
    } catch (error) {
      this.logger.error('Failed to fetch Reddit user profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseOAuth2Client } from './BaseOAuth2Client';
import type { TokenExchange } from './types';

export function getSlackScopesFromActiveEndpoints(
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

  return scopesSet.size > 0 ? Array.from(scopesSet).join(',') : '';
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

interface SlackOAuthAccessResponse extends SlackApiResponse {
  authed_user?: {
    id: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

@Injectable()
export class SlackClient extends BaseOAuth2Client {
  constructor(readonly logger: LoggerService) {
    super();
    this.logger.setContext(SlackClient.name);
  }

  protected readonly baseUrl = 'https://slack.com/api';

  protected readonly authorizationEndpoint = 'https://slack.com/oauth/v2/authorize';

  protected readonly tokenEndpoint = 'https://slack.com/api/oauth.v2.access';

  protected readonly endpointScopeMap = {
    Messages: [
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
      'channels:read',
      'groups:read',
      'im:read',
      'mpim:read',
      'users:read',
    ],
    Channels: ['channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'],
    default: ['users:read'],
  };

  protected readonly scopes: string[] = [];

  protected readonly extraAuthParams = {};

  getScopesFromActiveEndpoints(activeEndpoints: string[]): string {
    return getSlackScopesFromActiveEndpoints(activeEndpoints, this.endpointScopeMap);
  }

  getAccountIdentifier(connection: Connection): Promise<string> {
    return this.fetchAuthedUser(connection).then((result) => result.id);
  }

  async getAuthorizationUrl(connection: Connection): Promise<string> {
    const clientCredentials = await this.getClientCredentials(connection);
    if (!clientCredentials) {
      this.logger.error('Cannot getAuthorizationUrl because client credentials not found for connection', {
        connectionId: connection.id,
      });

      throw new Error('Cannot getAuthorizationUrl because client credentials not found');
    }

    const params = new URLSearchParams({
      client_id: clientCredentials.clientId,
      redirect_uri: config.auth.oauth.callbackUrl || `${process.env.APP_PUBLIC_URL}/oauth/callback`,
      user_scope: this.getScopesFromActiveEndpoints(connection.activeEndpoints),
      state: connection.id,
    });

    return `${this.authorizationEndpoint}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(connection: Connection, code: string): Promise<TokenExchange> {
    const clientCredentials = await this.getClientCredentials(connection);
    if (!clientCredentials) {
      throw new Error('Cannot exchangeAuthorizationCode because client credentials not found');
    }

    const tokenParams = new URLSearchParams({
      code,
      client_id: clientCredentials.clientId,
      client_secret: clientCredentials.clientSecret,
      redirect_uri: config.auth.oauth.callbackUrl || `${process.env.APP_PUBLIC_URL}/oauth/callback`,
      grant_type: 'authorization_code',
    });

    const tokenResponse = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      throw new Error('Token exchange failed');
    }

    const tokenData = (await tokenResponse.json()) as SlackOAuthAccessResponse;

    if (!tokenData.ok) {
      this.logger.error('Slack token exchange failed', { error: tokenData.error });
      throw new Error('Token exchange failed');
    }

    const userToken = tokenData.authed_user?.access_token || tokenData.access_token || null;
    const refreshToken = tokenData.authed_user?.refresh_token || tokenData.refresh_token || null;
    const expiresIn = tokenData.authed_user?.expires_in || tokenData.expires_in;
    const tokenExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    return {
      accessToken: userToken,
      refreshToken,
      tokenExpiry,
    } satisfies TokenExchange;
  }

  async refreshAccessToken(connection: Connection): Promise<TokenExchange> {
    if (!connection.refreshToken) {
      throw new BadRequestException('No refresh token available');
    }

    const clientCredentials = await this.getClientCredentials(connection);

    // Without user-supplied credentials the base implementation proxies the
    // refresh through CI Portal, which answers in plain OAuth2 — nothing
    // Slack-shaped to unwrap.
    if (!clientCredentials) {
      return super.refreshAccessToken(connection);
    }

    const tokenParams = new URLSearchParams({
      client_id: clientCredentials.clientId,
      client_secret: clientCredentials.clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: 'refresh_token',
    });

    const tokenResponse = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenParams.toString(),
    });

    if (!tokenResponse.ok) {
      throw new Error('Token refresh failed');
    }

    const tokenData = (await tokenResponse.json()) as SlackOAuthAccessResponse;

    // Slack reports a failed refresh as HTTP 200 with `ok: false`. Without this
    // check the unwrapping below yields nulls and the caller persists them,
    // wiping a token that was merely un-refreshable this once.
    if (!tokenData.ok) {
      this.logger.error('Slack token refresh failed', { error: tokenData.error });
      throw new Error(`Token refresh failed: ${tokenData.error || 'unknown error'}`);
    }

    const userToken = tokenData.authed_user?.access_token ?? tokenData.access_token ?? null;
    const refreshToken = tokenData.authed_user?.refresh_token ?? tokenData.refresh_token ?? null;
    const expiresIn = tokenData.authed_user?.expires_in ?? tokenData.expires_in;
    const tokenExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    return {
      accessToken: userToken,
      refreshToken,
      tokenExpiry,
    } satisfies TokenExchange;
  }

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    const response = await this.requestRaw(connection, endpoint, options);

    if (!response.ok) {
      throw new Error(`Slack API request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as SlackApiResponse & T;

    if (!data.ok) {
      throw new Error(data.error || 'Slack API request failed');
    }

    return data;
  }

  private async fetchAuthedUser(connection: Connection) {
    try {
      const response = await this.request<{ ok: boolean; user_id: string; team_id: string }>(
        connection,
        '/auth.test',
        { method: 'POST' },
      );

      return {
        id: response.user_id,
        teamId: response.team_id,
      };
    } catch (error) {
      this.logger.error('Failed to fetch Slack auth profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

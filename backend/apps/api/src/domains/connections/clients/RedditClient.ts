import { BadRequestException, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { Connection } from '../entities/ConnectionEntity';
import { oauthCallbackUrl } from '../utils/callbackUrls';

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

  /**
   * Least privilege, per Reddit's API reference: `/api/v1/me` is `identity`, and
   * `/user/{name}/submitted`, `/comments` and `/saved` are all `history`. `save`
   * is a WRITE scope (save/unsave on the user's behalf) and `read` covers
   * nothing these syncs call; both used to be requested and shown on the
   * consent screen for no use.
   */
  protected readonly endpointScopeMap = {
    Posts: ['history', 'identity'],
    Comments: ['history', 'identity'],
    Saved: ['history', 'identity'],
    default: ['identity'],
  };

  protected readonly scopes = ['identity', 'history'];

  /** RFC 7009-style, but Reddit requires the client's Basic credentials — see {@link revoke}. */
  protected readonly revocationEndpoint = 'https://www.reddit.com/api/v1/revoke_token';

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
      redirect_uri: oauthCallbackUrl(),
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

  /**
   * Revoke the grant with Reddit. The base implementation posts the token with
   * no client authentication, which Reddit refuses: `revoke_token` must be
   * authenticated with HTTP Basic exactly like the token request. So this needs
   * the user's own Reddit app credentials, looked up from `userId` +
   * `providerId` — the only connection fields beyond the tokens it reads.
   *
   * Only reached for connections made with the user's own app: a connection
   * Portal brokered is revoked through Portal by `DataDeletionService`, and its
   * `refresh_token` is a Portal proxy token Reddit has never seen.
   *
   * Best-effort by the base contract: never throws, `{ revoked: false }` when
   * there are no credentials or tokens, or Reddit errors. Reddit answers 204
   * even for a token that is already invalid, which is the outcome wanted.
   */
  async revoke(connection: Connection): Promise<{ revoked: boolean }> {
    const tokens = [
      { token: connection.refreshToken, hint: 'refresh_token' },
      { token: connection.accessToken, hint: 'access_token' },
    ].filter((t): t is { token: string; hint: string } => !!t.token);

    if (tokens.length === 0) {
      return { revoked: false };
    }

    let clientCredentials: { clientId: string; clientSecret: string } | null = null;

    try {
      const keys = await this.providerKeyService.findByProviderId(
        { userId: connection.userId },
        connection.provider?.id ?? connection.providerId,
      );
      clientCredentials = keys ? { clientId: keys.clientId, clientSecret: keys.clientSecret } : null;
    } catch (error) {
      this.logger.error('Could not read Reddit client credentials for revocation', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    if (!clientCredentials) {
      this.logger.log('No Reddit client credentials; skipping upstream revocation', {
        connectionId: connection.id,
      });

      return { revoked: false };
    }

    const authorization = `Basic ${Buffer.from(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`).toString('base64')}`;
    let revoked = false;

    // Refresh token first: revoking it ends the whole grant.
    for (const { token, hint } of tokens) {
      try {
        const response = await fetch(this.revocationEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: authorization,
            'User-Agent': REDDIT_USER_AGENT,
          },
          body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
        });

        if (response.ok) {
          revoked = true;
        } else {
          this.logger.log('Reddit token revocation returned non-OK; treating as best-effort', {
            connectionId: connection.id,
            status: response.status,
          });
        }
      } catch (error) {
        this.logger.error('Reddit token revocation request failed', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return { revoked };
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

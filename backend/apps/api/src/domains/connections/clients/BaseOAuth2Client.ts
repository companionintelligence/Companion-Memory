import { BadRequestException, Inject } from '@nestjs/common';

import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';
import { CloudOAuthProxyService } from '../services/CloudOAuthProxyService';
import { ProviderKeyService } from '../services/ProviderKeyService';

import { BaseClient } from './BaseClient';
import type { TokenExchange, TokenResponse } from './types';

/** Renders an OAuth token-endpoint error body into a message safe to append to an Error. */
export function formatTokenExchangeError(errorDetails: unknown): string {
  if (typeof errorDetails === 'string') {
    return errorDetails;
  }

  try {
    return JSON.stringify(errorDetails);
  } catch {
    return String(errorDetails);
  }
}

export abstract class BaseOAuth2Client extends BaseClient {
  @Inject(ProviderKeyService)
  protected readonly providerKeyService!: ProviderKeyService;

  @Inject(CloudOAuthProxyService)
  protected readonly cloudOAuthProxyService!: CloudOAuthProxyService;

  protected abstract baseUrl: string;

  protected abstract authorizationEndpoint: string;

  protected abstract tokenEndpoint: string;

  /**
   * The provider's OAuth 2.0 token-revocation endpoint (RFC 7009), when it
   * exposes one. Revoking here tells the provider to invalidate the token so
   * access actually stops on their side — required for Google's restricted-scope
   * policy and CASA/ASVS V8 ("delete user data on request" implies the grant is
   * also withdrawn). `null` for providers with no revocation endpoint (revocation
   * is then a best-effort no-op and we rely on local deletion of the token).
   */
  protected readonly revocationEndpoint: string | null = null;

  protected abstract scopes: string[];

  protected abstract extraAuthParams: Record<string, string>;

  protected abstract endpointScopeMap: Record<string, string[]>;

  abstract getScopesFromActiveEndpoints(activeEndpoints: string[]): string;

  getScopes(): string[] {
    return this.scopes;
  }

  /**
   * The OAuth app THIS USER registered for the provider, or null when they have
   * none — which is what sends a connect through CI Portal's proxy instead.
   *
   * Takes only the two fields it reads, not a whole `Connection`, so a caller
   * that has not created a connection yet can still ask "would this connect use
   * Portal?" (`ProvidersController.connect` does, to refuse before it writes
   * anything when the Portal sign-in switch is off). Every existing caller passes
   * a full `Connection`, which satisfies this.
   */
  async getClientCredentials(
    connection: Pick<Connection, 'userId' | 'provider'>,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    return this.providerKeyService
      .findByProviderId({ userId: connection.userId }, connection.provider!.id)
      .then((keys) => {
        return keys ? { clientId: keys.clientId, clientSecret: keys.clientSecret } : null;
      });
  }

  abstract getAccountIdentifier(connection: Connection): Promise<string>;

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
      },
    });
  }

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    const response = await this.requestRaw(connection, endpoint, options);

    if (!response.ok) {
      let errorMessage = `API request failed: ${response.statusText}`;
      let errorDetails: unknown;

      try {
        const errorData = (await response.json()) as {
          error?: { message?: string; type?: string; code?: number; error_subcode?: number };
        };
        if (errorData.error) {
          errorMessage = errorData.error.message || errorMessage;
          errorDetails = {
            type: errorData.error.type,
            code: errorData.error.code,
            error_subcode: errorData.error.error_subcode,
            message: errorData.error.message,
          };
        }
      } catch {
        errorDetails = {
          code: response.status,
          message: response.statusText,
        };
        // If we can't parse the error response, use the default message
      }

      const error = new Error(errorMessage);
      (error as Error & { details?: unknown }).details = errorDetails;

      throw error;
    }

    return (await response.json()) as T;
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
      response_type: 'code',
      scope: this.getScopesFromActiveEndpoints(connection.activeEndpoints),
      state: connection.id,
      ...this.extraAuthParams,
    });

    return `${this.authorizationEndpoint}?${params.toString()}`;
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

      this.logger.error('Token exchange failed', {
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

    //If the user has saved OAuth credentials for this provider, then refresh directly through their OAuth app.
    //Otherwise, proxy it through CI portal
    if (clientCredentials) {
      const tokenParams = new URLSearchParams({
        client_id: clientCredentials.clientId,
        client_secret: clientCredentials.clientSecret,
        scope: this.getScopesFromActiveEndpoints(connection.activeEndpoints),
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
        let errorDetails;

        try {
          errorDetails = await tokenResponse.json();
        } catch {
          errorDetails = await tokenResponse.text();
        }

        this.logger.error('Token refresh failed', {
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
        refreshToken: tokenData.refresh_token || null,
        tokenExpiry,
      } satisfies TokenExchange;
    } else {
      //Proxy the refresh request through CI Portal
      const proxyData = await this.cloudOAuthProxyService.refreshAccessToken(connection.refreshToken);

      const tokenExpiry = proxyData.expires_in ? new Date(Date.now() + proxyData.expires_in * 1000) : null;

      return {
        accessToken: proxyData.access_token,
        // Return the rotated proxy refresh token so the caller can persist it.
        refreshToken: proxyData.refresh_token,
        tokenExpiry,
      } satisfies TokenExchange;
    }
  }

  /**
   * Revoke this connection's OAuth grant with the provider (RFC 7009), so access
   * stops on the provider's side — not just in our database. Called when a
   * connection is disconnected or the owning account is deleted.
   *
   * Best-effort by contract: revocation is a courtesy to the provider and must
   * never block the local purge. If the provider has no revocation endpoint, the
   * connection carries no token, or the provider rejects/errors on the call
   * (including because the token was already revoked — providers commonly answer
   * 200 or a benign 400 there), we return `{ revoked: false }` and let the caller
   * proceed to delete the stored token locally. A revocation attempt is made for
   * BOTH the refresh token and the access token when present, because revoking a
   * Google refresh token invalidates the whole grant while an access-token-only
   * connection still needs its access token withdrawn.
   *
   * @returns whether at least one token was accepted for revocation by the provider.
   */
  async revoke(connection: Connection): Promise<{ revoked: boolean }> {
    if (this.revocationEndpoint == null) {
      return { revoked: false };
    }

    // Prefer the refresh token (revoking it invalidates the entire grant on most
    // providers, incl. Google), then the access token. Deduped + falsy-filtered.
    const tokens = Array.from(
      new Set([connection.refreshToken, connection.accessToken].filter((t): t is string => !!t)),
    );

    if (tokens.length === 0) {
      return { revoked: false };
    }

    let revoked = false;

    for (const token of tokens) {
      try {
        const response = await fetch(this.revocationEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({ token }).toString(),
        });

        if (response.ok) {
          revoked = true;
        } else {
          // A token that is already invalid/revoked is a success from our POV —
          // the goal (no live grant) is met. Log and continue; never throw.
          this.logger.log('Token revocation returned non-OK; treating as best-effort', {
            connectionId: connection.id,
            status: response.status,
          });
        }
      } catch (error) {
        this.logger.error('Token revocation request failed', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return { revoked };
  }
}

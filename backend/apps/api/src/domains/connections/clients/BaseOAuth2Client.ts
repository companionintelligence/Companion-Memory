import { BadRequestException, Inject } from '@nestjs/common';

import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';
import { CloudOAuthProxyService } from '../services/CloudOAuthProxyService';
import { ProviderKeyService } from '../services/ProviderKeyService';

import { BaseClient } from './BaseClient';
import type { TokenExchange, TokenResponse } from './types';

export abstract class BaseOAuth2Client extends BaseClient {
  @Inject(ProviderKeyService)
  protected readonly providerKeyService!: ProviderKeyService;

  @Inject(CloudOAuthProxyService)
  protected readonly cloudOAuthProxyService!: CloudOAuthProxyService;

  protected abstract baseUrl: string;

  protected abstract authorizationEndpoint: string;

  protected abstract tokenEndpoint: string;

  protected abstract scopes: string[];

  protected abstract extraAuthParams: Record<string, string>;

  protected abstract endpointScopeMap: Record<string, string[]>;

  abstract getScopesFromActiveEndpoints(activeEndpoints: string[]): string;

  async getClientCredentials(
    connection: Connection,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    return this.providerKeyService
      .findByProviderId({ userId: connection.userId }, connection.provider!.id)
      .then((keys) => {
        return keys ? { clientId: keys.clientId, clientSecret: keys.clientSecret } : null;
      });
  }

  abstract getAccountIdentifier(connection: Connection): Promise<string>;

  async request<T>(connection: Connection, endpoint: string, options?: RequestInit): Promise<T> {
    if (connection.accessToken == null) {
      throw new Error('Connection not authenticated');
    }

    const endpointSplitOnProtocol = /^(https:\/\/[^/]+)(\/.*)?$/.exec(endpoint);
    const baseUrl = endpointSplitOnProtocol ? endpointSplitOnProtocol[1] : this.baseUrl;
    const path = endpointSplitOnProtocol ? endpointSplitOnProtocol[2] || '' : endpoint;
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${connection.accessToken}`,
      },
    });

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
        // If we can't parse the error response, use the default message
      }

      const error = new Error(errorMessage);
      (error as Error & { details?: unknown }).details = errorDetails;

      throw error;
    }

    const data: T = await response.json();

    return data;
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

        this.logger.error('Token exchange failed', {
          status: tokenResponse.status,
          error: errorDetails,
          endpoint: this.tokenEndpoint,
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
}

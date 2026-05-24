import { BadRequestException } from '@nestjs/common';

import config from '@ci/configuration';

import type { Connection } from '../entities/ConnectionEntity';

import { BaseClient } from './BaseClient';
import type { TokenExchange, TokenResponse } from './types';

export abstract class BaseOAuth2Client extends BaseClient {
  protected abstract baseUrl: string;

  protected abstract authorizationEndpoint: string;

  protected abstract tokenEndpoint: string;

  protected abstract scopes: string[];

  protected abstract extraAuthParams: Record<string, string>;

  protected abstract endpointScopeMap: Record<string, string[]>;

  protected abstract getScopesFromActiveEndpoints(activeEndpoints: string[]): string;

  abstract getClientCredentials(connection: Connection): Promise<{ clientId: string; clientSecret: string }>;

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
    const params = new URLSearchParams({
      client_id: clientCredentials.clientId,
      redirect_uri: config.auth.oauth.callbackUrl,
      response_type: 'code',
      scope: this.getScopesFromActiveEndpoints(connection.activeEndpoints),
      state: connection.id,
      ...this.extraAuthParams,
    });

    return `${this.authorizationEndpoint}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(connection: Connection, code: string): Promise<TokenExchange> {
    const clientCredentials = await this.getClientCredentials(connection);
    const tokenParams = new URLSearchParams({
      code,
      client_id: clientCredentials.clientId,
      client_secret: clientCredentials.clientSecret,
      redirect_uri: config.auth.oauth.callbackUrl,
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
        errorDetails = tokenResponse.json();
      } catch {
        errorDetails = tokenResponse.text();
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
        errorDetails = tokenResponse.json();
      } catch {
        errorDetails = tokenResponse.text();
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
}

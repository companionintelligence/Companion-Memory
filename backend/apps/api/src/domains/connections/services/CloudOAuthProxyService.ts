import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

export interface CloudAuthorizeResponse {
  session_id: string;
  authorization_url: string;
}

export interface CloudTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token: string;
}

/**
 * Service for proxying OAuth flows through CI Cloud.
 *
 * This service replaces direct provider OAuth calls so that client secrets never need to live on the box.
 * However, users can input their own OAuth credentials, in which case this service will not be used.
 *
 * Auth model (mirrors CI Cloud):
 *  - authorize: sends box_id + device_key in the request body
 *  - token/refresh: self-authenticating via refresh_token
 *  - token/revoke:  self-authenticating via refresh_token
 */
@Injectable()
export class CloudOAuthProxyService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(CloudOAuthProxyService.name);
  }

  /**
   * Map a CI-Server provider UUID (from the providers config) to the CI Cloud
   * provider name. Returns undefined if the ID is unknown.
   */
  getProviderNameForId(providerId: string): string | undefined {
    const providers = config.auth.providers;
    const map: Record<string, string> = {
      [providers.google.id]: 'google',
      [providers.microsoft.id]: 'microsoft',
      [providers.facebook.id]: 'facebook',
      [providers.spotify.id]: 'spotify',
    };

    return map[providerId];
  }

  private get baseUrl(): string {
    const url = config.ciPortal.url;
    if (!url) {
      throw new Error('CI_CLOUD_URL is not configured');
    }

    return url.replace(/\/$/, '');
  }

  private get deviceId(): string {
    const id = config.ciPortal.deviceId;
    if (!id) {
      throw new Error('HUB_DEVICE_ID is not configured');
    }

    return id;
  }

  private get apiKey(): string {
    const key = config.ciPortal.apiKey;
    if (!key) {
      throw new Error('HUB_API_KEY is not configured');
    }

    return key;
  }

  private get authorizationHeader(): string {
    return `Basic ${Buffer.from(`${this.deviceId}:${this.apiKey}`).toString('base64')}`;
  }

  /**
   * Initiate an OAuth flow via CI Cloud.
   * Returns the authorization URL to redirect the user to.
   */
  async getAuthorizationUrl(
    provider: string,
    callbackUrl: string,
    scopes?: string[],
  ): Promise<CloudAuthorizeResponse> {
    if (!config.ciPortal.deviceId) {
      this.logger.error('Missing Hub Device ID');
      throw new Error('HUB_DEVICE_ID is not configured');
    }

    if (!config.ciPortal.apiKey) {
      this.logger.error('Missing Hub API key ID');
      throw new Error('HUB_API_KEY is not configured');
    }

    const response = await fetch(`${this.baseUrl}/api/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authorizationHeader,
      },
      body: JSON.stringify({
        provider,
        box_id: this.deviceId,
        device_key: this.apiKey,
        callback_url: callbackUrl,
        scopes,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error('CI Cloud authorize failed', { status: response.status, body: text });
      throw new Error(`CI Cloud authorize failed: ${text}`);
    }

    return response.json() as Promise<CloudAuthorizeResponse>;
  }

  /**
   * Refresh an access token using a proxy refresh token.
   * Returns a new access token and a rotated proxy refresh token.
   */
  async refreshAccessToken(proxyRefreshToken: string): Promise<CloudTokenResponse> {
    if (!config.ciPortal.deviceId) {
      this.logger.error('Missing Hub Device ID');
      throw new Error('HUB_DEVICE_ID is not configured');
    }

    if (!config.ciPortal.apiKey) {
      this.logger.error('Missing Hub API key ID');
      throw new Error('HUB_API_KEY is not configured');
    }

    const response = await fetch(`${this.baseUrl}/api/oauth/token/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authorizationHeader,
      },
      body: JSON.stringify({ refresh_token: proxyRefreshToken }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error('CI Cloud token refresh failed', { status: response.status, body: text });
      throw new Error(`CI Cloud token refresh failed: ${text}`);
    }

    return response.json() as Promise<CloudTokenResponse>;
  }

  /**
   * Revoke a token using its proxy refresh token.
   */
  async revokeToken(proxyRefreshToken: string): Promise<void> {
    if (!config.ciPortal.deviceId) {
      this.logger.error('Missing Hub Device ID');
      throw new Error('HUB_DEVICE_ID is not configured');
    }

    if (!config.ciPortal.apiKey) {
      this.logger.error('Missing Hub API key ID');
      throw new Error('HUB_API_KEY is not configured');
    }

    const response = await fetch(`${this.baseUrl}/api/oauth/token/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authorizationHeader,
      },
      body: JSON.stringify({ refresh_token: proxyRefreshToken }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error('CI Cloud token revoke failed', { status: response.status, body: text });
      throw new Error(`CI Cloud token revoke failed: ${text}`);
    }
  }
}

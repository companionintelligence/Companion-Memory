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
  proxy_refresh_token: string;
}

/**
 * Service for proxying OAuth flows through CI Cloud.
 *
 * When `ciCloud.enabled` is true, this service replaces direct provider
 * OAuth calls so that client secrets never need to live on the box.
 *
 * Auth model (mirrors CI Cloud):
 *  - authorize: sends x-device-key header (box's API key)
 *  - token/refresh: self-authenticating via proxy_refresh_token
 *  - token/revoke:  self-authenticating via proxy_refresh_token
 */
@Injectable()
export class CloudOAuthProxyService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(CloudOAuthProxyService.name);
  }

  get isEnabled(): boolean {
    return config.ciCloud.enabled;
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
    };
    if (providers.discord?.id) {
      map[providers.discord.id] = 'discord';
    }

    if (providers.instagram?.id) {
      map[providers.instagram.id] = 'instagram';
    }

    return map[providerId];
  }

  private get baseUrl(): string {
    const url = config.ciCloud.url;
    if (!url) {
      throw new Error('CI_CLOUD_URL is not configured');
    }

    return url.replace(/\/$/, '');
  }

  private get boxId(): string {
    const id = config.ciCloud.boxId;
    if (!id) {
      throw new Error('CI_CLOUD_BOX_ID is not configured');
    }

    return id;
  }

  private get boxApiKey(): string {
    const key = config.ciCloud.boxApiKey;
    if (!key) {
      throw new Error('CI_CLOUD_BOX_API_KEY is not configured');
    }

    return key;
  }

  /**
   * Translate CI Server endpoint names (e.g. "Gmail", "Calendar") into the actual
   * OAuth scope strings that CI Cloud expects. Always includes the provider's
   * baseline scopes (openid/email/profile etc.).
   */
  resolveEndpointsToScopes(provider: string, endpoints: string[]): string[] {
    switch (provider) {
      case 'google': {
        const base = ['openid', 'email', 'profile'];
        const map: Record<string, string> = {
          Calendar: 'https://www.googleapis.com/auth/calendar.readonly',
          Gmail: 'https://www.googleapis.com/auth/gmail.readonly',
          Drive: 'https://www.googleapis.com/auth/drive.readonly',
          YouTube: 'https://www.googleapis.com/auth/youtube.readonly',
          Contacts: 'https://www.googleapis.com/auth/contacts.readonly',
        };
        const extra = endpoints.flatMap((e) => (map[e] ? [map[e]] : []));

        return [...new Set([...base, ...extra])];
      }

      case 'microsoft': {
        const base = ['openid', 'email', 'profile', 'offline_access'];
        const map: Record<string, string> = {
          'Outlook Mail': 'Mail.Read',
          Calendar: 'Calendars.Read',
          OneDrive: 'Files.Read',
        };
        const extra = endpoints.flatMap((e) => (map[e] ? [map[e]] : []));

        return [...new Set([...base, ...extra])];
      }

      case 'facebook': {
        const base = ['email', 'public_profile'];
        const map: Record<string, string> = {
          Posts: 'user_posts',
          Photos: 'user_photos',
          Videos: 'user_videos',
          Friends: 'user_friends',
          Likes: 'user_likes',
        };
        const extra = endpoints.flatMap((e) => (map[e] ? [map[e]] : []));

        return [...new Set([...base, ...extra])];
      }

      default:
        return [];
    }
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
    const response = await fetch(`${this.baseUrl}/api/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-key': this.boxApiKey,
      },
      body: JSON.stringify({
        provider,
        box_id: this.boxId,
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
    const response = await fetch(`${this.baseUrl}/api/oauth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy_refresh_token: proxyRefreshToken }),
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
    const response = await fetch(`${this.baseUrl}/api/oauth/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy_refresh_token: proxyRefreshToken }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error('CI Cloud token revoke failed', { status: response.status, body: text });
      throw new Error(`CI Cloud token revoke failed: ${text}`);
    }
  }
}

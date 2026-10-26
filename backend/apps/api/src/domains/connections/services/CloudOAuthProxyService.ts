import { ConflictException, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { isOutboundEnabled } from '@ci/common/outbound';
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
  /**
   * The provider account id CI Portal stored this grant under. Returned by CI Portal
   * versions that carry it; absent from older ones, which callers must tolerate.
   */
  user_provider_id?: string;
}

/** Outcome of `POST /api/oauth/token/revoke` on CI Portal. */
export interface CloudRevokeResponse {
  success: boolean;
  /** Stored credential rows Portal hard-deleted for this device. */
  tokens_deleted: number;
  /** False when Portal attempted an upstream revocation and the provider refused it. */
  revocation_ok: boolean;
}

/** User-installed Hub app recorded in CI Portal for this device. */
export interface PortalDeviceApplication {
  id: string;
  name: string;
  slug: string;
  port: number;
  publicDomain: string | null;
  /** Browser-reachable URL built by Portal (same shape as ListMyApps). */
  openUrl?: string | null;
}

/** Minimal app row from Portal GET /api/users/me/apps?slug=… */
export interface PortalUserApplication {
  slug: string;
  url: string;
  deviceName: string;
  deviceSlug: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  facebook: 'Facebook',
  spotify: 'Spotify',
  github: 'GitHub',
  reddit: 'Reddit',
  slack: 'Slack',
  dropbox: 'Dropbox',
};

/**
 * What a refused Portal sign-in tells the user, in words that name both ways
 * out: bring your own OAuth app for this provider, or turn the switch back on.
 * Shared by the service (the choke point) and `ProvidersController` (which
 * refuses earlier, before it creates a connection row).
 */
export function portalOAuthOffMessage(provider: string): string {
  const label = PROVIDER_LABELS[provider] ?? provider;

  return (
    `Signing in to ${label} through CI Portal is turned off on this appliance, and you have not saved an ` +
    `OAuth app of your own for ${label}. Register your own ${label} OAuth app and add its credentials, or ` +
    `turn Portal sign-in back on under Settings → Privacy → What leaves your appliance.`
  );
}

/**
 * Service for proxying OAuth flows through CI Cloud.
 *
 * This service replaces direct provider OAuth calls so that client secrets never need to live on the box.
 * However, users can input their own OAuth credentials, in which case this service will not be used.
 *
 * Auth model (mirrors CI Cloud):
 *  - authorize: sends box_id + device_key in the request body
 *  - token/refresh: the device's Basic credentials plus the proxy refresh token,
 *    which CI Portal rotates on every use (store the one it returns)
 *  - token/revoke:  the device's Basic credentials plus the proxy refresh token
 *    and/or provider + user_provider_id
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
      [providers.github.id]: 'github',
      [providers.reddit.id]: 'reddit',
      [providers.slack.id]: 'slack',
      [providers.dropbox.id]: 'dropbox',
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
   *
   * ── The user's switch (`portal_oauth`) ─────────────────────────────────────
   *
   * This is the one place a NEW Portal-brokered sign-in leaves the box, and both
   * controllers that can start one (`ConnectionsController.connect`,
   * `ProvidersController.connect`) reach it only when the user has no OAuth app
   * of their own — so refusing here is exactly "a connect that would use the
   * Portal proxy is refused", while a connect using the user's own saved
   * credentials never calls this and is untouched. A 409 rather than a 500 or a
   * silent empty URL: nothing is wrong with the appliance, the user has told it
   * not to do this, and the message says how to proceed.
   *
   * ── What this deliberately does NOT govern ─────────────────────────────────
   *
   * {@link refreshAccessToken} and {@link revokeToken} are left alone. A
   * connection that already lives at Portal holds a proxy refresh token that only
   * Portal can exchange; refusing to refresh it would break an existing sync
   * with no visible cause, which is worse than the egress it saves. The user
   * turning this off means "do not start new sign-ins through Portal", not
   * "strand the ones I already have" — disconnecting a connection is how those
   * are ended, and revoke must keep working so that ends cleanly at Portal too.
   */
  async getAuthorizationUrl(
    provider: string,
    callbackUrl: string,
    scopes?: string[],
  ): Promise<CloudAuthorizeResponse> {
    if (!isOutboundEnabled('portal_oauth')) {
      throw new ConflictException(portalOAuthOffMessage(provider));
    }

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
   *
   * `signal` bounds the wait for a caller someone is waiting on: CI Portal calls the
   * provider's token endpoint in turn, and neither request times out on its own.
   */
  async refreshAccessToken(
    proxyRefreshToken: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudTokenResponse> {
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
      body: JSON.stringify({
        refresh_token: proxyRefreshToken,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error('CI Cloud token refresh failed', { status: response.status, body: text });
      throw new Error(`CI Cloud token refresh failed: ${text}`);
    }

    return response.json() as Promise<CloudTokenResponse>;
  }

  /**
   * Revoke and delete the credential CI Portal holds for a proxied connection.
   *
   * Portal revokes its stored provider refresh token upstream (best-effort),
   * then hard-deletes the row, so the grant actually ends and nothing about
   * the connection survives in the cloud. The row is addressed by the proxy
   * refresh token when the box still has a usable one, and by `provider` +
   * `userProviderId` otherwise — that pair is always known (it is the
   * connection's provider and `external_id`), so a stale or already-consumed
   * proxy token cannot leave an orphan behind. Idempotent on Portal's side: a
   * credential that is already gone is a successful no-op.
   */
  async revokeToken(input: {
    proxyRefreshToken?: string | null;
    provider: string;
    userProviderId?: string | null;
  }): Promise<CloudRevokeResponse> {
    if (!config.ciPortal.deviceId) {
      this.logger.error('Missing Hub Device ID');
      throw new Error('HUB_DEVICE_ID is not configured');
    }

    if (!config.ciPortal.apiKey) {
      this.logger.error('Missing Hub API key ID');
      throw new Error('HUB_API_KEY is not configured');
    }

    const body: Record<string, string> = { provider: input.provider };

    if (input.proxyRefreshToken) {
      body.refresh_token = input.proxyRefreshToken;
    }

    if (input.userProviderId) {
      body.user_provider_id = input.userProviderId;
    }

    if (!body.refresh_token && !body.user_provider_id) {
      // Nothing Portal could match a row on; there is nothing to revoke.
      return { success: true, tokens_deleted: 0, revocation_ok: true };
    }

    const response = await fetch(`${this.baseUrl}/api/oauth/token/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authorizationHeader,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error('CI Cloud token revoke failed', { status: response.status, body: text });
      throw new Error(`CI Cloud token revoke failed: ${text}`);
    }

    return (await response.json()) as CloudRevokeResponse;
  }

  /** Whether CI Portal credentials are present (best-effort reads may still fail). */
  isPortalConfigured(): boolean {
    return Boolean(config.ciPortal.url && config.ciPortal.deviceId && config.ciPortal.apiKey);
  }

  /**
   * List Hub apps registered for this device in CI Portal.
   * Returns an empty list when portal credentials are missing or the request fails.
   */
  async getDeviceApplications(): Promise<PortalDeviceApplication[]> {
    if (!this.isPortalConfigured()) {
      return [];
    }

    try {
      // Companion Portal reads a device on this route from `x-device-key` alone (its
      // `deviceOrUserAuthMiddleware`). The Basic header the OAuth routes take was ignored here, and
      // the call answered 401, so no installed agent counted as installed until it was connected.
      const response = await fetch(`${this.baseUrl}/api/devices/applications`, {
        headers: {
          'x-device-key': this.apiKey,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn('CI Portal device applications request failed', {
          status: response.status,
          body: text,
        });

        return [];
      }

      const body = (await response.json()) as { applications?: PortalDeviceApplication[] };

      return Array.isArray(body.applications) ? body.applications : [];
    } catch (error) {
      this.logger.warn('CI Portal device applications request errored', {
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  /**
   * Discover where a Hub app runs for the signed-in Portal user.
   * Mirrors the browser extension's post-OIDC lookup against ListMyApps.
   */
  async listMyApps(slug: string, bearerToken: string): Promise<PortalUserApplication[]> {
    if (!this.isPortalConfigured()) {
      return [];
    }

    if (!slug.trim() || !bearerToken.trim()) {
      return [];
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/api/users/me/apps?slug=${encodeURIComponent(slug.trim())}`,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
          },
        },
      );

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn('CI Portal ListMyApps request failed', {
          slug,
          status: response.status,
          body: text,
        });

        return [];
      }

      const body = (await response.json()) as { apps?: PortalUserApplication[] };

      return Array.isArray(body.apps) ? body.apps : [];
    } catch (error) {
      this.logger.warn('CI Portal ListMyApps request errored', {
        slug,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }
}

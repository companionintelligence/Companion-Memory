import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import config from '@ci/configuration';

export interface PowerSyncCredentials {
  /** Short-lived JWT the PowerSync client SDK presents to the PowerSync service. */
  token: string;
  /** The PowerSync service endpoint the client connects to. */
  powersync_url: string;
}

/**
 * Stable reason the token endpoint gives when this deployment runs no PowerSync
 * service. Clients stop asking this server for credentials when they see it.
 */
export const POWERSYNC_NOT_CONFIGURED = 'POWERSYNC_NOT_CONFIGURED';

/**
 * The 503 body for an unconfigured deployment: the shape Nest gave the
 * `ServiceUnavailableException` this endpoint used to throw, plus `code`, so
 * clients that only look at the status keep working.
 */
export const POWERSYNC_NOT_CONFIGURED_BODY = {
  statusCode: 503,
  error: 'Service Unavailable',
  message: 'PowerSync is not configured',
  code: POWERSYNC_NOT_CONFIGURED,
} as const;

export type PowerSyncNotConfigured = typeof POWERSYNC_NOT_CONFIGURED_BODY;

const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

function resolveCutoffIso(cutoff?: string): string {
  if (cutoff) {
    const parsed = Date.parse(cutoff);

    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
}

/**
 * Issues the short-lived JWT a PowerSync client uses to authenticate against the
 * self-hosted PowerSync service. The token's `sub` is the CI-Server user id, which
 * the sync rules read via `request.user_id()` to scope each user's buckets.
 *
 * `parameters.cutoff` is the rolling working-set window (default last 14 days).
 * Eviction on device is unsubscribe: a later cutoff, then PowerSync drops rows
 * that no longer match. This is not a clone of the appliance.
 *
 * Dev scaffold: HS256 with a shared secret (POWERSYNC_JWT_SECRET) that the PowerSync
 * service's `client_auth` is configured to trust. For production, switch to
 * asymmetric keys (RS256/EdDSA) exposed via a JWKS endpoint — see
 * infrastructure/powersync/README.md.
 */
/**
 * The configured URL as the client should use it: an absolute URL as is, a path
 * joined to the origin the request came in on. A path with no known origin is
 * returned unchanged rather than guessed at.
 */
export function resolvePowerSyncUrl(configured: string, requestOrigin: string): string {
  if (!configured.startsWith('/') || configured.startsWith('//') || !requestOrigin) {
    return configured;
  }

  return `${requestOrigin.replace(/\/+$/, '')}${configured}`;
}

@Injectable()
export class PowerSyncTokenService {
  constructor(private readonly jwtService: JwtService) {}

  /** Whether this deployment has a PowerSync service to issue tokens for. */
  isConfigured(): boolean {
    return Boolean(config.powersync.jwtSecret && config.powersync.url);
  }

  /**
   * @param requestOrigin `scheme://host` the request arrived on. Used only when the
   *   configured URL is a path (`/powersync`): an appliance reached through several
   *   addresses (LAN, a Hub tunnel, Tailscale) serves sync on each of them through its
   *   own gateway, so the one right answer is "this origin, at that path". The CSP pins
   *   `connect-src` to `'self'`, which this keeps satisfied too.
   */
  issueToken(userId: string, cutoff?: string, requestOrigin = ''): PowerSyncCredentials {
    if (!this.isConfigured()) {
      // The feature is scaffolded but not configured for this deployment. The
      // controller answers this case before calling here; a caller that does
      // not still gets the same body, `code` included.
      throw new ServiceUnavailableException(POWERSYNC_NOT_CONFIGURED_BODY);
    }

    const token = this.jwtService.sign(
      { parameters: { cutoff: resolveCutoffIso(cutoff) } },
      {
        secret: config.powersync.jwtSecret,
        subject: userId,
        audience: config.powersync.audience,
        expiresIn: config.powersync.tokenTtl,
        keyid: config.powersync.jwtKid,
      },
    );

    return { token, powersync_url: resolvePowerSyncUrl(config.powersync.url, requestOrigin) };
  }
}

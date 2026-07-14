import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import {
  CONNECT_NONCE_HEADER,
  CONNECT_SIGNATURE_HEADER,
  CONNECT_TIMESTAMP_HEADER,
  DEFAULT_CONNECT_MAX_SKEW_MS,
  verifyConnectRequest,
} from '@ci/common/crypto';
import config from '@ci/configuration';

/**
 * Guard for the Hub -> CI-Server app-connect endpoints. Verifies the signed
 * request (see connect-request-auth: method + path + body-hash + nonce +
 * timestamp) and enforces single-use of the nonce via an in-memory replay cache,
 * so a captured request cannot be replayed (e.g. to revoke another app's key)
 * within the skew window.
 *
 * Uses `auth.hubForwardAuth.{enabled,secret}` (the dedicated Hub<->CI-Server
 * shared secret) and fails closed when disabled, matching HubForwardAuthGuard.
 * The replay/skew window, however, is the connect-specific DEFAULT_CONNECT_MAX_SKEW_MS
 * (60s) — deliberately NOT the shared `hubForwardAuth.maxSkewMs` (which is a much
 * larger identity-header tolerance): a connect call is a low-latency same-host S2S
 * request, so a tight window minimises the interval in which a captured request
 * could be replayed.
 *
 * Residual (accepted for the single-instance appliance): the nonce cache is
 * in-memory and per-process, so single-use is not preserved across a CI-Server
 * restart or a second replica. Exposure is bounded to the 60s window and requires
 * an attacker already positioned to capture the internal S2S request; a shared/
 * persistent nonce store would be needed to close it for multi-replica setups.
 */
@Injectable()
export class ConnectRequestAuthGuard implements CanActivate {
  /** Consumed nonces → expiry (ms). Bounds replay within the skew window. */
  private readonly seenNonces = new Map<string, number>();

  private lastPrune = 0;

  canActivate(context: ExecutionContext): boolean {
    const cfg = config.auth.hubForwardAuth;

    if (!cfg.enabled) {
      throw new UnauthorizedException('Hub forward-auth verification is not enabled on this server');
    }

    const req = context.switchToHttp().getRequest<Request>();
    // Connect-specific window (60s), decoupled from the larger shared
    // hubForwardAuth.maxSkewMs so a captured connect request is replayable for at
    // most ~60s rather than the identity-header tolerance.
    const maxSkewMs = DEFAULT_CONNECT_MAX_SKEW_MS;

    const header = (name: string): string | null => {
      const raw = req.headers[name];

      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    };

    const result = verifyConnectRequest(
      cfg.secret,
      {
        // The path the client MUST sign is the one this API actually receives:
        // the nginx gateway strips `/api` (`rewrite ^/api/(.*)$ /$1`) and there is
        // no global route prefix, so this is server-relative (e.g.
        // `/connect/exchange`, not `/api/connect/exchange`). Strip any query
        // string, which is not part of the signed message.
        method: req.method,
        path: (req.originalUrl || req.url).split('?')[0],
        timestamp: header(CONNECT_TIMESTAMP_HEADER),
        nonce: header(CONNECT_NONCE_HEADER),
        signature: header(CONNECT_SIGNATURE_HEADER),
        body: req.body,
      },
      { maxSkewMs },
    );

    if (!result.ok) {
      throw new UnauthorizedException(`Invalid connect request signature: ${result.reason}`);
    }

    this.pruneExpired(maxSkewMs);

    if (this.seenNonces.has(result.nonce)) {
      throw new UnauthorizedException('Connect request replay detected');
    }

    // Keep the nonce until it can no longer pass the skew check anyway.
    this.seenNonces.set(result.nonce, Date.now() + maxSkewMs * 2);

    return true;
  }

  private pruneExpired(maxSkewMs: number): void {
    const now = Date.now();
    // Prune at most once per skew window to keep this O(1) amortized per request.
    if (now - this.lastPrune < maxSkewMs) {
      return;
    }

    this.lastPrune = now;

    for (const [nonce, expiry] of this.seenNonces) {
      if (expiry < now) {
        this.seenNonces.delete(nonce);
      }
    }
  }
}

import * as crypto from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { SYSTEM_USER } from '@ci/common/context';
import type { PortalTokenVerifier } from '@ci/common/guards/PortalTokenVerifier';
import config from '@ci/configuration';
import { type User, UserService } from '@ci/domains/user';

import {
  parseAllowedServiceClients,
  resolveServiceAccount,
  type ServiceAccountClaims,
} from '../utils/serviceAccountToken';

/**
 * Validates CI-Portal-issued OIDC tokens and maps them to a CI-Server user.
 *
 * CI-Portal (better-auth) is the identity provider; it signs JWTs with EdDSA and
 * publishes a JWKS. This service verifies a Bearer token against that JWKS
 * (issuer + audience checked) and JIT-provisions the matching CI-Server user, so
 * any portal-authenticated app can write to memory with one brokered token.
 *
 * ## Service accounts (Portal-brokered service credential — B5)
 *
 * Sidecars (HBPE, Summary) used to self-sign HS256 JWTs with the shared
 * `AUTH_JWT_AUTHTOKENSECRET`; a single leaked symmetric secret meant full user
 * impersonation. They now present a Portal-issued, EdDSA-signed service token
 * whose `client_id`/`act.sub` is one of `auth.portal.serviceClients`. Such tokens
 * are verified against the same Portal JWKS and resolve to the existing user
 * named in `sub` (the on-behalf-of principal) — never JIT-provisioned by email.
 * See CI-Engineering `architecture/identity/unified-identity-plan.md` · B5 / D3.
 *
 * Gated behind `auth.portal.enabled` so it runs alongside the legacy JWT/api-key
 * paths during migration. See unified-identity-pipeline.md.
 */
@Injectable()
export class PortalTokenService implements PortalTokenVerifier {
  private readonly logger = new Logger(PortalTokenService.name);

  // Lazily built so a disabled/misconfigured portal never blocks startup.
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  // Allow-listed service-account client ids, parsed once from config.
  private readonly serviceClients = parseAllowedServiceClients(config.auth.portal.serviceClients);

  constructor(private readonly userService: UserService) {}

  get enabled(): boolean {
    return config.auth.portal.enabled === true;
  }

  private getJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(config.auth.portal.jwksUri));
    }

    return this.jwks;
  }

  /**
   * Verify a portal token and return the corresponding CI-Server user, or null
   * if the token is not a valid portal token (so the caller can fall back to
   * the legacy strategies).
   */
  async verifyAndProvision(token: string): Promise<User | null> {
    if (!this.enabled) {
      return null;
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.getJwks(), {
        issuer: config.auth.portal.issuer,
        // The portal issues per-client tokens (aud === client_id), so accept any
        // first-party client audience. PORTAL_OIDC_AUDIENCE is a comma-separated list.
        audience: config.auth.portal.audience
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
      }));
    } catch {
      // Wrong signer / issuer / audience / expired — not a valid portal token.
      return null;
    }

    // A Portal-brokered service credential (e.g. HBPE) acts on behalf of an
    // existing user; resolve it distinctly from a human OIDC login.
    const serviceAccount = resolveServiceAccount(
      payload as JWTPayload & ServiceAccountClaims,
      this.serviceClients,
    );
    if (serviceAccount) {
      return this.resolveServiceAccountUser(serviceAccount.clientId, serviceAccount.onBehalfOfUserId);
    }

    return this.provisionUser(payload);
  }

  /**
   * Resolve the on-behalf-of user for a verified service-account token. Unlike
   * human logins, a service account never provisions a new user: `sub` must name
   * an existing CI-Server user, else the request is rejected (null). This keeps a
   * compromised or misconfigured sidecar from minting identities.
   */
  private async resolveServiceAccountUser(
    clientId: string,
    onBehalfOfUserId: string,
  ): Promise<User | null> {
    const user = await this.userService.findById({ userId: SYSTEM_USER }, onBehalfOfUserId);

    if (!user) {
      this.logger.warn(
        `Service account "${clientId}" presented a token for unknown user "${onBehalfOfUserId}"; rejecting.`,
      );

      return null;
    }

    return user;
  }

  private async provisionUser(payload: JWTPayload): Promise<User | null> {
    const sub = payload.sub;
    if (!sub) {
      return null;
    }

    // Map by email when present (the portal id-token carries it); otherwise a
    // deterministic shadow address keyed on the stable OIDC subject.
    const email = typeof payload.email === 'string' ? payload.email : `oidc-${sub}@portal.local`;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name : email;

    const existing = await this.userService.findByEmail(email);
    if (existing) {
      return existing;
    }

    // Portal-authenticated users have no CI-Server password; set a random one.
    return this.userService.create(
      { userId: SYSTEM_USER },
      { name, email, password: crypto.randomBytes(32).toString('hex') },
    );
  }
}

import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { SYSTEM_USER } from '@ci/common/context';
import type { PortalTokenVerifier } from '@ci/common/guards/PortalTokenVerifier';
import config from '@ci/configuration';
import { type User, UserService } from '@ci/domains/user';

import { FederatedIdentityService } from './FederatedIdentityService';

/**
 * Validates CI-Portal-issued OIDC tokens and maps them to a CI-Server user.
 *
 * CI-Portal (better-auth) is the identity provider; it signs JWTs with EdDSA and
 * publishes a JWKS. This service verifies a Bearer token against that JWKS
 * (issuer + audience checked) and JIT-provisions the matching CI-Server user, so
 * any portal-authenticated app can write to memory with one brokered token.
 *
 * Gated behind `auth.portal.enabled` so it runs alongside the legacy JWT/api-key
 * paths during migration. See unified-identity-pipeline.md.
 */
@Injectable()
export class PortalTokenService implements PortalTokenVerifier {
  // Lazily built so a disabled/misconfigured portal never blocks startup.
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly userService: UserService,
    private readonly federatedIdentityService: FederatedIdentityService,
  ) {}

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

    return this.provisionUser(payload);
  }

  private async provisionUser(payload: JWTPayload): Promise<User | null> {
    const sub = payload.sub;
    const issuer = typeof payload.iss === 'string' ? payload.iss : config.auth.portal.issuer;
    if (!sub) {
      return null;
    }

    // 1. Identity binding is keyed on the OIDC (issuer, subject) pair — the only
    //    stable, non-reassignable per-user handle. If we've seen this identity
    //    before, resolve straight to the bound local user. This is what closes
    //    the email-trust gap: a re-used email at the IdP can no longer reach
    //    another user's account.
    const boundUserId = await this.federatedIdentityService.findUserId(issuer, sub);
    if (boundUserId) {
      const bound = await this.userService.findById({ userId: SYSTEM_USER }, boundUserId);
      // The binding row survives its user via ON DELETE CASCADE, so a missing
      // user here means a race; fall through to (re-)provision below.
      if (bound) {
        return bound;
      }
    }

    // 2. First time we see this (issuer, subject). We only trust the email claim
    //    as an identity signal when the IdP asserts it is verified — otherwise a
    //    user could self-assert any address at signup and hijack an account.
    const emailVerified = payload.email_verified === true;
    const claimedEmail = typeof payload.email === 'string' ? payload.email.trim() : '';
    // Deterministic shadow address keyed on the stable subject when there is no
    // trustworthy email to key on.
    const email = emailVerified && claimedEmail ? claimedEmail : `oidc-${sub}@portal.local`;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name : email;

    // 3. One-time migration fallback: users provisioned before this table existed
    //    were keyed purely on email. Only when the IdP asserts a verified email do
    //    we adopt a matching pre-existing local user and back-fill the binding.
    if (emailVerified && claimedEmail) {
      const existing = await this.userService.findByEmail(claimedEmail);
      if (existing) {
        await this.federatedIdentityService.link(issuer, sub, existing.id);

        return existing;
      }
    }

    // 4. No local user for this identity — JIT-provision one and bind it.
    //    Portal-authenticated users have no CI-Server password; set a random one.
    const created = await this.userService.create(
      { userId: SYSTEM_USER },
      { name, email, password: crypto.randomBytes(32).toString('hex') },
    );
    await this.federatedIdentityService.link(issuer, sub, created.id);

    return created;
  }
}

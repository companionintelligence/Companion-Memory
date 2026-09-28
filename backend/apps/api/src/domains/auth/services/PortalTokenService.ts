import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { SYSTEM_USER } from '@ci/common/context';
import type { PortalTokenVerifier } from '@ci/common/guards/PortalTokenVerifier';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { type User, UserService } from '@ci/domains/user';

import {
  parseAllowedServiceClients,
  resolveServiceAccount,
  type ServiceAccountClaims,
} from '../utils/serviceAccountToken';

import { FederatedIdentityService } from './FederatedIdentityService';

/**
 * Validates CI-Portal-issued OIDC tokens and maps them to a CI-Server user.
 *
 * CI-Portal (better-auth) is the identity provider; it signs JWTs with EdDSA and
 * publishes a JWKS. This service verifies a Bearer token against that JWKS
 * (issuer + audience checked) and resolves it to the matching CI-Server user, so
 * a first-party client holding a brokered token (a phone, the browser extension)
 * can call the API without a browser session.
 *
 * ## Who may sign in with a Companion account
 *
 * An appliance serves one person, and that person's Portal identity is bound to
 * their local account the first time they sign in. Anyone else on the box is a
 * household member with an email-and-password account the owner invited. So a
 * Portal identity that is not yet bound here is admitted in exactly one case:
 * the appliance has no accounts at all, and this sign-in claims it. On a claimed
 * appliance an unbound Portal identity is refused — there is no invitation
 * mechanism on this path, and account creation belongs to the browser flow
 * (`OidcController`), which is where invitations are checked. Until this rule
 * existed the bearer path created an account for ANY valid Portal token, which
 * on a tunnelled Hub install meant anyone with a Portal login could sign up.
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
  // Lazily built so a disabled/misconfigured portal never blocks startup.
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  // Allow-listed service-account client ids, parsed once from config.
  private readonly serviceClients = parseAllowedServiceClients(config.auth.portal.serviceClients);

  constructor(
    private readonly userService: UserService,
    private readonly federatedIdentityService: FederatedIdentityService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PortalTokenService.name);
  }

  get enabled(): boolean {
    return config.auth.portal.enabled === true;
  }

  /**
   * better-auth's jwt() plugin defaults `aud` to the issuer URL (BASE_URL).
   * OIDC id_tokens use `aud === client_id`. Accept both so a phone that only
   * holds the access token is not 401'd while the id_token would have worked.
   */
  private acceptedAudiences(): string[] {
    const configured = config.auth.portal.audience
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    const issuer = config.auth.portal.issuer?.trim();

    return [...new Set(issuer ? [...configured, issuer] : configured)];
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
        // First-party client ids plus the issuer URL (better-auth access tokens).
        audience: this.acceptedAudiences(),
      }));
    } catch (error) {
      // Wrong signer / issuer / audience / expired — not a valid portal token,
      // so fall through to the legacy strategies.
      //
      // Log the reason. Returning a bare null made every rejection identical to
      // "no portal token present", which is why a misconfigured audience or
      // issuer surfaced only as a blanket 401 with nothing to go on — the
      // single hardest thing to diagnose in this auth path. `jose` codes are
      // specific (ERR_JWT_EXPIRED, ERR_JWT_CLAIM_VALIDATION_FAILED,
      // ERR_JWKS_NO_MATCHING_KEY), and none of them contain the token.
      this.logger.debug('Portal token rejected', {
        code: (error as { code?: string })?.code ?? 'unknown',
        reason: (error as Error)?.message,
        issuer: config.auth.portal.issuer,
        audience: config.auth.portal.audience,
      });

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
  private async resolveServiceAccountUser(clientId: string, onBehalfOfUserId: string): Promise<User | null> {
    const user = await this.userService.findById({ userId: SYSTEM_USER }, onBehalfOfUserId);

    if (!user) {
      this.logger.warn(
        `Service account "${clientId}" presented a token for unknown user "${onBehalfOfUserId}"; rejecting.`,
      );

      return null;
    }

    return user;
  }

  /**
   * Verify a portal token and return its claims WITHOUT provisioning a local
   * user. Used by the peer-ask surface: an inbound ask is authenticated as a
   * *peer's* identity, which must be matched against this box's peer links —
   * it must never mint a local account (that would let any portal user
   * accumulate a shadow user on every box they can reach).
   */
  async verifyClaims(
    token: string,
    options?: { audience?: string[] },
  ): Promise<{ issuer: string; subject: string } | null> {
    if (!this.enabled) {
      return null;
    }

    // A caller-supplied audience REPLACES the broad first-party list. The peer
    // surface uses this to bind a token to this specific box; jose fails the
    // verification when `aud` does not intersect, so a token addressed to a
    // different Companion is rejected rather than silently honoured.
    const audience =
      options?.audience && options.audience.length > 0 ? options.audience : this.acceptedAudiences();

    try {
      const { payload } = await jwtVerify(token, this.getJwks(), {
        issuer: config.auth.portal.issuer,
        audience,
      });

      const issuer = payload.iss ?? config.auth.portal.issuer;

      return payload.sub && issuer ? { issuer, subject: payload.sub } : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a verified token payload to a local user, keyed on the OIDC
   * **(issuer, subject)** pair.
   *
   * Email is NOT a matching key: it is re-assignable and not unique across
   * issuers, so matching on it once a second issuer is trusted (a peer box, a
   * partner IdP) hands the local account to whoever controls that address —
   * a cross-box account-takeover primitive. Email survives only as a ONE-TIME
   * link for accounts that pre-date the binding table, and only when the issuer
   * asserts `email_verified`.
   */
  private async provisionUser(payload: JWTPayload): Promise<User | null> {
    const sub = payload.sub;
    const issuer = payload.iss ?? config.auth.portal.issuer;
    if (!sub || !issuer) {
      return null;
    }

    // 1. Established binding wins outright.
    const boundUserId = await this.federatedIdentityService.findUserId(issuer, sub);
    if (boundUserId) {
      return this.userService.findById({ userId: SYSTEM_USER }, boundUserId);
    }

    const claimedEmail = typeof payload.email === 'string' ? payload.email : undefined;
    const emailVerified = payload.email_verified === true;
    // Shadow address keyed on the stable subject when no usable email is present.
    const email = claimedEmail ?? `oidc-${sub}@portal.local`;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name : email;

    // 2. One-time link: an account that pre-dates the binding table, matched on
    //    a VERIFIED email. Every later request for this (iss,sub) takes path 1.
    //
    //    "One-time" is enforced, not just intended: the link is allowed ONLY
    //    while the target account has no federated identity at all. Without that
    //    check, a *second* (iss,sub) presenting the same verified address would
    //    also adopt the account — which is exactly the email-is-not-an-identity
    //    takeover this binding exists to prevent, merely requiring the attacker
    //    to control a verified address at any trusted issuer.
    if (claimedEmail && emailVerified) {
      const existing = await this.userService.findByEmail(claimedEmail);
      if (existing) {
        const alreadyFederated = await this.federatedIdentityService.listForUser(existing.id);
        if (alreadyFederated.length > 0) {
          this.logger.warn(
            `refusing email link for ${issuer}#${sub}: user already bound to another identity`,
          );

          return null;
        }

        await this.federatedIdentityService.bind({
          userId: existing.id,
          issuer,
          subject: sub,
          email: claimedEmail,
          bindMethod: 'email_link',
        });

        return existing;
      }
    }

    // 3. Nobody here has claimed this Portal identity. Only an UNCLAIMED
    //    appliance admits it — the sign-in becomes the owner (UserService.create
    //    promotes the first account to admin). On a claimed appliance the answer
    //    is no: the owner already exists, and household members are invited
    //    through the browser flow as email-and-password accounts.
    if (!(await this.userService.hasNoUsers())) {
      this.logger.warn(`refusing to provision ${issuer}#${sub}: this appliance already has an owner`);

      return null;
    }

    //    Portal-authenticated users have no CI-Server password; set a random one.
    const created = await this.userService.create(
      { userId: SYSTEM_USER },
      { name, email, password: crypto.randomBytes(32).toString('hex'), passwordChosenByUser: false },
    );

    if (created) {
      await this.federatedIdentityService.bind({
        userId: created.id,
        issuer,
        subject: sub,
        email: claimedEmail ?? null,
        bindMethod: 'sub',
      });
    }

    return created;
  }
}

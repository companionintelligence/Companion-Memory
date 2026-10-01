import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';

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
 * Ceiling on one HTTP fetch of the Portal JWKS. jose defaults to 5s; stated here
 * so the number is ours and visible rather than inherited from a library default.
 */
export const PORTAL_JWKS_FETCH_TIMEOUT_MS = 3_000;

/** Minimum gap between JWKS reloads triggered by an unknown `kid` (jose's default, made explicit). */
export const PORTAL_JWKS_COOLDOWN_MS = 30_000;

/**
 * Hard ceiling on verifying one Bearer token against the Portal, for the whole
 * `jwtVerify` including the key fetch.
 *
 * This is a backstop ABOVE the fetch timeout, not a replacement for it. jose's
 * remote key set shares ONE in-flight fetch across every caller
 * (`pendingFetch ||= fetch(...)`), and the `AbortSignal` timeout only helps if
 * the transport honours it. A fetch that never settles therefore leaves every
 * later verification awaiting the same promise forever — and because the guard
 * verifies a bearer against the Portal before the local strategies, that took
 * every bearer-authenticated route down until the process restarted.
 */
export const PORTAL_VERIFY_TIMEOUT_MS = 5_000;

/**
 * JWS algorithms a JWKS can hold a key for — the asymmetric ones. Deliberately
 * the whole family rather than just the EdDSA the Portal signs with today, so a
 * key-type rotation on the Portal is not silently turned into a 401 here.
 */
const PORTAL_JWS_ALGS: ReadonlySet<string> = new Set([
  'EdDSA',
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
]);

class PortalVerifyTimeoutError extends Error {
  readonly code = 'ERR_PORTAL_VERIFY_TIMEOUT';

  constructor() {
    super(`Portal token verification exceeded ${PORTAL_VERIFY_TIMEOUT_MS}ms`);
  }
}

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
      this.jwks = createRemoteJWKSet(new URL(config.auth.portal.jwksUri), {
        timeoutDuration: PORTAL_JWKS_FETCH_TIMEOUT_MS,
        cooldownDuration: PORTAL_JWKS_COOLDOWN_MS,
      });
    }

    return this.jwks;
  }

  /**
   * Whether `token` could possibly be a Portal token — decided from its
   * protected header alone, before any network I/O.
   *
   * A JWKS holds public keys, so only an asymmetric alg can ever verify against
   * it. The web app's own session JWT is HS256 and reaches this service on every
   * authenticated request; jose would still fetch the Portal's key set for it
   * (the fetch happens before the alg is rejected), tying a local request's
   * latency to the Portal's availability. Not JWT-shaped at all is also "not a
   * Portal token": `jwtVerify` rejects it before fetching anything, so the
   * outcome is unchanged, just reached without building the JWKS first.
   *
   * This only ever NARROWS what reaches `jwtVerify`; it never accepts anything
   * `jwtVerify` would not.
   */
  private mayBePortalToken(token: string): boolean {
    try {
      const { alg } = decodeProtectedHeader(token);

      return typeof alg === 'string' && PORTAL_JWS_ALGS.has(alg);
    } catch (error) {
      this.logRejection(error);

      return false;
    }
  }

  private logRejection(error: unknown): void {
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
  }

  /**
   * Verify `token` against the Portal JWKS and return its claims, or null when
   * it is not a valid Portal token — including when the Portal cannot be
   * reached in time. Never throws and never waits longer than
   * {@link PORTAL_VERIFY_TIMEOUT_MS}, so a Portal outage degrades to "not a
   * Portal token" (the caller falls through to the legacy strategies) instead
   * of a hung request.
   */
  private async verifyPortalJwt(token: string, audience: string[]): Promise<JWTPayload | null> {
    if (!this.mayBePortalToken(token)) {
      return null;
    }

    const jwks = this.getJwks();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PortalVerifyTimeoutError()), PORTAL_VERIFY_TIMEOUT_MS);
    });

    try {
      // The verification keeps running in the background if the deadline wins;
      // `race` has already subscribed to it, so a late rejection is not unhandled.
      const { payload } = await Promise.race([
        jwtVerify(token, jwks, { issuer: config.auth.portal.issuer, audience }),
        deadline,
      ]);

      return payload;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const hitDeadline = error instanceof PortalVerifyTimeoutError;

      // The shared in-flight fetch inside this key set may never settle, and
      // every later request would join it. Discard the set so the next one
      // builds a fresh fetch — but only if a concurrent request has not already
      // replaced it. (jose's own ERR_JWKS_TIMEOUT clears its fetch itself.)
      if (hitDeadline && this.jwks === jwks) {
        this.jwks = undefined;
      }

      if (hitDeadline || code === 'ERR_JWKS_TIMEOUT') {
        this.logger.warn('Portal token verification timed out; treating it as not a portal token', {
          code: code ?? 'unknown',
          timeoutMs: PORTAL_VERIFY_TIMEOUT_MS,
          jwksUri: config.auth.portal.jwksUri,
        });
      } else {
        // Wrong signer / issuer / audience / expired — not a valid portal token,
        // so the caller falls through to the legacy strategies.
        this.logRejection(error);
      }

      return null;
    } finally {
      clearTimeout(timer);
    }
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

    // First-party client ids plus the issuer URL (better-auth access tokens).
    const payload = await this.verifyPortalJwt(token, this.acceptedAudiences());
    if (!payload) {
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

    const payload = await this.verifyPortalJwt(token, audience);
    if (!payload) {
      return null;
    }

    const issuer = payload.iss ?? config.auth.portal.issuer;

    return payload.sub && issuer ? { issuer, subject: payload.sub } : null;
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
    //    appliance admits it — the sign-in becomes the owner (the first account
    //    is promoted to admin). On a claimed appliance the answer is no: the
    //    owner already exists, and household members are invited through the
    //    browser flow as email-and-password accounts.
    //
    //    "Unclaimed" is decided by the transaction that creates the account, not
    //    before it. Asked first and acted on after, two first sign-ins racing on
    //    an empty appliance both saw it empty and both got in. The binding is
    //    written in that transaction too, so it exists exactly when the account
    //    does.
    const created = await this.userService.createFirstAccount(
      { userId: SYSTEM_USER },
      //    Portal-authenticated users have no CI-Server password; set a random one.
      { name, email, password: crypto.randomBytes(32).toString('hex'), passwordChosenByUser: false },
      (manager, user) =>
        this.federatedIdentityService.bind(
          { userId: user.id, issuer, subject: sub, email: claimedEmail ?? null, bindMethod: 'sub' },
          manager,
        ),
    );

    if (created) {
      return created;
    }

    //    Not the first account. It may be THIS identity's, though: a client that
    //    has just signed in fires its first requests concurrently, one of them
    //    claims the appliance, and its account and binding commit together before
    //    the rest get their answer. Path 1 finds them now; refusing would sign the
    //    owner out of the box they just claimed.
    const claimedBy = await this.federatedIdentityService.findUserId(issuer, sub);
    if (claimedBy) {
      return this.userService.findById({ userId: SYSTEM_USER }, claimedBy);
    }

    this.logger.warn(`refusing to provision ${issuer}#${sub}: this appliance already has an owner`);

    return null;
  }
}

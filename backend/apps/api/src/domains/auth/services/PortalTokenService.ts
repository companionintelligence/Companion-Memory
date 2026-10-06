import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';

import { SYSTEM_USER } from '@ci/common/context';
import {
  CAPTURE_SCOPE,
  INTENTS_SCOPE,
  MCP_SCOPE,
  MEMORY_SCOPE,
  WRITE_CAPABILITY,
} from '@ci/common/decorators';
import type { PortalPrincipal, PortalTokenVerifier } from '@ci/common/guards/PortalTokenVerifier';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { type User, UserService } from '@ci/domains/user';

import {
  isApplianceAudience,
  mintedByAddressingPortal,
  thisApplianceAudience,
} from '../utils/applianceAudience';
import {
  parseAllowedServiceClients as parseClientIds,
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

/** The scopes a service token's `scope` claim can grant: the api-key scopes, nothing else. */
const SERVICE_ACCOUNT_SCOPES: ReadonlySet<string> = new Set([
  MEMORY_SCOPE,
  INTENTS_SCOPE,
  MCP_SCOPE,
  CAPTURE_SCOPE,
]);

/** What a capture agent, or a token not addressed to this appliance, may do: record captures. */
const CAPTURE_ONLY = {
  limits: { scopes: [CAPTURE_SCOPE], capability: WRITE_CAPABILITY },
  credentialRoutes: false,
  admin: false,
} as const satisfies Omit<PortalPrincipal, 'user'>;

/** The user's full authority, as a session has it. Only for a token addressed to this appliance. */
const FULL_AUTHORITY = {
  limits: null,
  credentialRoutes: true,
  admin: true,
} as const satisfies Omit<PortalPrincipal, 'user'>;

/**
 * A token from a Portal that predates appliance addressing: nothing could have addressed it, so
 * it keeps what it always had (phone pairing mints its key with one), except the admin routes.
 */
const BEFORE_ADDRESSING = {
  limits: null,
  credentialRoutes: true,
  admin: false,
} as const satisfies Omit<PortalPrincipal, 'user'>;

/** Who a verified token was issued to, and whether it was addressed to this appliance. */
interface TokenAddress {
  /** The client the token was issued to: `azp`, else its only accepted `aud` value. */
  client: string;
  /** `aud` names this appliance. A token naming only another appliance never gets this far. */
  toThisAppliance: boolean;
}

function audienceList(aud: unknown): string[] {
  if (typeof aud === 'string') {
    return [aud];
  }

  return Array.isArray(aud) ? aud.filter((value): value is string => typeof value === 'string') : [];
}

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
 * household member with an email-and-password account the owner invited. A
 * Portal identity that is not yet bound here is refused: this path creates no
 * accounts, not even the first one. Account creation belongs to the browser
 * flow (`OidcController`), the Hub bridge and signup: someone setting the
 * Memory up in person, and where invitations are checked.
 *
 * ## Which Memory a token is for
 *
 * Every Memory trusts the same Portal and signs its users in as the same client
 * (`ci-server`), so a token's client id alone does not say which Memory it was
 * meant for. The Portal can now say: a token addressed to an appliance carries
 * `urn:ci:device:<device id>` in `aud` (see `utils/applianceAudience.ts`). Only a
 * token addressed to this appliance carries the user's full authority; one
 * addressed to another is refused; capture clients and unaddressed tokens get
 * the capture scope. See {@link PortalTokenService.authorityFor}.
 *
 * ## Service accounts
 *
 * A token whose `client_id`/`act.sub` is one of `auth.portal.serviceClients`
 * acts on behalf of the existing user named in `sub`, never JIT-provisioned.
 * Nothing ships one today: the HBPE and Summary sidecars authenticate with
 * `SIDECAR_AUTH_SECRET` and per-run tokens, so the list is empty by default. A
 * service token must be addressed to this appliance and is confined to the
 * api-key scopes in its `scope` claim.
 *
 * Gated behind `auth.portal.enabled` so it runs alongside the legacy JWT/api-key
 * paths during migration. See unified-identity-pipeline.md.
 */
@Injectable()
export class PortalTokenService implements PortalTokenVerifier {
  // Lazily built so a disabled/misconfigured portal never blocks startup.
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  // Allow-listed service-account client ids, parsed once from config.
  private readonly serviceClients = parseClientIds(config.auth.portal.serviceClients);

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
   * The client ids whose tokens are accepted at all (`auth.portal.audience`).
   *
   * The Portal's own URL used to be added here, for "a phone that only holds the access token".
   * The Portal's access tokens are opaque and never verify here; the only JWT carrying that
   * audience is the Portal's own session JWT, which names no client and so has no business on a
   * Memory. No client sends one.
   */
  private acceptedAudiences(): string[] {
    return parseClientIds(config.auth.portal.audience);
  }

  /** Clients that are capture agents (`auth.portal.captureClients`): capture scope, write, always. */
  private captureClients(): string[] {
    return parseClientIds(config.auth.portal.captureClients);
  }

  /**
   * Who a verified token was issued to and whether it is addressed to this appliance, or null when
   * it must be refused: it names another appliance, or its client cannot be told.
   *
   * A token naming an appliance is refused unless one of the appliances it names is this one.
   * That is the whole point of naming one: a token the Portal issued for a different Memory, or
   * that a different Memory received during its own sign-in, is not a credential here.
   */
  private addressOf(payload: JWTPayload, accepted: readonly string[]): TokenAddress | null {
    const audiences = audienceList(payload.aud);
    const appliances = audiences.filter(isApplianceAudience);
    const ours = thisApplianceAudience();
    const toThisAppliance = ours != null && appliances.includes(ours);

    if (appliances.length > 0 && !toThisAppliance) {
      this.logger.debug('Portal token refused: addressed to a different appliance', {
        audiences: appliances,
      });

      return null;
    }

    const clients = audiences.filter((aud) => accepted.includes(aud));
    const client = typeof payload.azp === 'string' ? payload.azp : clients.length === 1 ? clients[0] : null;

    if (!client || !accepted.includes(client)) {
      this.logger.debug('Portal token refused: no single accepted client', { audiences, azp: payload.azp });

      return null;
    }

    return { client, toThisAppliance };
  }

  /**
   * What a human's verified token may do here.
   *
   * | token                                                   | authority                         |
   * |---------------------------------------------------------|-----------------------------------|
   * | issued to a capture client                              | capture scope, write              |
   * | addressed to this appliance                             | full                              |
   * | not addressed, from a Portal that addresses tokens      | capture scope, write              |
   * | not addressed, from a Portal from before addressing     | full except the admin guards      |
   *
   * "From a Portal that addresses tokens" is read off the token itself (the
   * `ci_appliance_binding` claim), not from configuration or discovery. Memory can be upgraded
   * before the Portal: until the Portal stamps its tokens, phone pairing keeps working as it did,
   * and an hour after the Portal starts stamping (the life of the last unstamped token) the
   * unaddressed case is closed on every Memory at once.
   */
  private authorityFor(address: TokenAddress, payload: JWTPayload): Omit<PortalPrincipal, 'user'> {
    if (this.captureClients().includes(address.client)) {
      return CAPTURE_ONLY;
    }

    if (address.toThisAppliance) {
      return FULL_AUTHORITY;
    }

    return mintedByAddressingPortal(payload) ? CAPTURE_ONLY : BEFORE_ADDRESSING;
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
  async verifyAndProvision(token: string): Promise<PortalPrincipal | null> {
    if (!this.enabled) {
      return null;
    }

    const accepted = this.acceptedAudiences();
    const payload = await this.verifyPortalJwt(token, accepted);
    if (!payload) {
      return null;
    }

    // A Portal-brokered service credential acts on behalf of an existing user;
    // resolve it distinctly from a human OIDC login. Checked before the client is
    // read, because a service token names its service in `azp`/`client_id`.
    const serviceAccount = resolveServiceAccount(
      payload as JWTPayload & ServiceAccountClaims,
      this.serviceClients,
    );
    if (serviceAccount) {
      return this.resolveServiceAccountPrincipal(payload, serviceAccount);
    }

    const address = this.addressOf(payload, accepted);
    if (!address) {
      return null;
    }

    const user = await this.provisionUser(payload);

    return user ? { user, ...this.authorityFor(address, payload) } : null;
  }

  /**
   * A service token's principal: only when it is addressed to this appliance, and confined to the
   * api-key scopes its `scope` claim names, at `write`. Its `sub` is taken as a local user id, so a
   * token for another box (where that id means nothing, or someone else) must never get here; and
   * a service is never a person signing in, so it never reaches credential or admin routes. A
   * token naming no scope this server knows grants nothing.
   */
  private async resolveServiceAccountPrincipal(
    payload: JWTPayload,
    serviceAccount: { clientId: string; onBehalfOfUserId: string; scopes: string[] },
  ): Promise<PortalPrincipal | null> {
    const ours = thisApplianceAudience();
    if (!ours || !audienceList(payload.aud).includes(ours)) {
      this.logger.warn(
        `Service account "${serviceAccount.clientId}" token is not addressed to this appliance`,
      );

      return null;
    }

    const scopes = serviceAccount.scopes.filter((scope) => SERVICE_ACCOUNT_SCOPES.has(scope));
    if (scopes.length === 0) {
      this.logger.warn(`Service account "${serviceAccount.clientId}" token names no api-key scope`);

      return null;
    }

    const user = await this.resolveServiceAccountUser(
      serviceAccount.clientId,
      serviceAccount.onBehalfOfUserId,
    );

    return user
      ? { user, limits: { scopes, capability: WRITE_CAPABILITY }, credentialRoutes: false, admin: false }
      : null;
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
        // OIDC identities only: a Hub person's own binding is not another identity's claim.
        const alreadyFederated = await this.federatedIdentityService.listForUser(existing.id, {
          oidcOnly: true,
        });
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

    // 3. Nobody here has claimed this Portal identity, and a bearer token never
    //    creates an account. It used to on an appliance with none: whoever held
    //    any valid Portal token and reached the box first became its owner and
    //    administrator, a token sent to some other Memory included. The first
    //    account is created by a sign-in in the browser or the app
    //    (`OidcController`), the Hub (`HubForwardAuthBridgeService`) or a signup:
    //    by whoever sets this Memory up.
    this.logger.warn(`refusing Portal token for ${issuer}#${sub}: no account here is bound to it`);

    return null;
  }
}

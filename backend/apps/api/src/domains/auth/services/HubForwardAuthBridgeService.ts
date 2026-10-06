import { randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

import { isUniqueViolation } from '@ci/common/constants';
import { SYSTEM_USER } from '@ci/common/context';
import {
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_USER_HEADER,
  FORWARD_AUTH_USER_ID_HEADER,
  FORWARD_AUTH_USER_ID_SIGNATURE_HEADER,
  FORWARD_AUTH_USER_ISSUER_HEADER,
  type HubStableId,
  verifyForwardAuthHeaders,
} from '@ci/common/crypto';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { type CreateUserDto, type User, UserService } from '@ci/domains/user';

import { clearCsrfCookie, clearSessionCookie, setCsrfCookie, setSessionCookie } from '../utils/authCookies';

import { AuthService } from './AuthService';
import { CsrfService } from './CsrfService';
import { FederatedIdentityService } from './FederatedIdentityService';

/** A verified Hub forward-auth identity. */
export interface HubIdentity {
  /** The Hub username (an email address): what the person is called today. */
  username: string;
  /** Who they are for good, when the Hub sent it; null from a Hub that predates stable ids. */
  stableId: HubStableId | null;
}

/**
 * Why a verified Hub person was not signed in to Memory.
 *
 * - `account_unavailable`: their account was deleted and is awaiting its purge, or, for someone not
 *   linked yet, such an account still holds the address the Hub calls them.
 * - `account_linked_elsewhere`: the account their Hub username names belongs to another person of
 *   the same Hub. Somebody renamed away from this address, and the Hub later gave it to this person.
 * - `account_ambiguous`: no account has exactly this address, and several have it in other cases.
 * - `account_unproven`: the account their Hub username names has an address nothing proved is
 *   theirs (typed into signup or a later email change), and this browser is not signed in to it.
 *   Signing in to that account here with its password, then reloading, links them. Applies to a
 *   Hub that sends no stable id too: there the address is the whole link, so it is refused the same
 *   way, and a browser already signed in to that account keeps its session.
 */
export type HubBridgeRefusal =
  | 'account_unavailable'
  | 'account_linked_elsewhere'
  | 'account_ambiguous'
  | 'account_unproven';

export interface HubBridgeResult {
  /** Verified Hub username (email), or null when headers are absent/disabled/invalid. */
  username: string | null;
  /** True when the Memory session was replaced or minted for the Hub person. */
  replaced: boolean;
  /** Access JWT when a session is now aligned with the Hub person. */
  accessToken?: string;
  /** Set when the Hub person was not signed in; whatever session this browser held is signed out. */
  refused?: HubBridgeRefusal;
}

/** Where a Hub person with a stable id belongs in Memory; see {@link HubForwardAuthBridgeService.locate}. */
type Placement =
  | { kind: 'linked'; user: User }
  | { kind: 'adopt'; user: User }
  | { kind: 'create' }
  | { kind: 'refused'; reason: HubBridgeRefusal };

interface MemorySession {
  userId: string;
  token: string;
  email: string | null;
}

/** First-sight races a placement retries before giving up. One is all a second tab can cause. */
const MAX_PLACEMENT_ATTEMPTS = 3;

/**
 * The account this browser is signed in to, asked only when a placement needs the answer: an
 * account whose address is not proven. Most requests never get that far.
 */
type SignedInAs = () => Promise<string | null>;

const SIGNED_IN_AS_NOBODY: SignedInAs = async () => null;

function headerValue(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }

  return raw ?? null;
}

function emailsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/**
 * Aligns Memory's own session with a verified Hub forward-auth identity.
 *
 * Traefik already proves the Hub person on every request. If Memory's
 * `sessionToken` still belongs to someone else (or is missing), replace it so
 * the SPA never has to walk an OIDC logout loop to become the current person.
 *
 * ── Which account is the Hub person's ──────────────────────────────────────
 *
 * By the Hub person's stable id, when the Hub sends one: a `ci.federated_identities`
 * row keyed on (`urn:ci-hub:<directory>`, their Hub `public_id`). The link is made
 * the first time they arrive, to the account their Hub username names (or a new
 * one), and from then on neither name is consulted. A rename on the Hub, or of the
 * address here, no longer moves them into a fresh, empty account.
 *
 * By email alone, as before, for a Hub that sends no stable id. That is still the
 * failure the stable id exists to end, kept only so an older Hub works exactly as
 * it always did. See CI-Engineering/architecture/identity/hub-memory-account-link.md.
 */
@Injectable()
export class HubForwardAuthBridgeService {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly csrfService: CsrfService,
    private readonly federatedIdentityService: FederatedIdentityService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(HubForwardAuthBridgeService.name);
  }

  /** The verified Hub identity on this request, or null when the feature is off or headers do not verify. */
  verifyIdentity(req: Request): HubIdentity | null {
    const cfg = config.auth.hubForwardAuth;
    if (!cfg.enabled || !cfg.secret) {
      return null;
    }

    const result = verifyForwardAuthHeaders(
      cfg.secret,
      {
        user: headerValue(req, FORWARD_AUTH_USER_HEADER),
        timestamp: headerValue(req, FORWARD_AUTH_TIMESTAMP_HEADER),
        signature: headerValue(req, FORWARD_AUTH_SIGNATURE_HEADER),
        issuer: headerValue(req, FORWARD_AUTH_USER_ISSUER_HEADER),
        userId: headerValue(req, FORWARD_AUTH_USER_ID_HEADER),
        userIdSignature: headerValue(req, FORWARD_AUTH_USER_ID_SIGNATURE_HEADER),
      },
      { maxSkewMs: cfg.maxSkewMs },
    );

    return result.ok ? { username: result.username, stableId: result.stableId } : null;
  }

  /** Verified `X-CI-Hub-User`, or null when the feature is off or headers do not verify. */
  verifyUsername(req: Request): string | null {
    return this.verifyIdentity(req)?.username ?? null;
  }

  /**
   * Whether the Hub finds this request's person by `email`, so changing the address would lose them.
   *
   * True when the Hub signs this request in under this address and has no stable link to go by. That
   * covers a Hub that sends no stable id, and a stable id not linked yet: {@link alignSession} links
   * it on the next page load to the account this address names. Once the link exists it is what
   * finds them, and the address is the person's to change.
   */
  async namesAccount(req: Request, email: string): Promise<boolean> {
    const identity = this.verifyIdentity(req);
    if (!identity || !emailsEqual(identity.username, email)) {
      return false;
    }

    if (!identity.stableId) {
      return true;
    }

    const { issuer, subject } = identity.stableId;

    return (await this.federatedIdentityService.findUserId(issuer, subject)) == null;
  }

  /**
   * The verified Hub person and the Memory account they sign in as, without changing anything.
   *
   * `accountId` lets the SPA tell "the Hub named someone else" from "the Hub calls this person by
   * another address now" — the email comparison it used to make cannot. It is null for a Hub that
   * sends no stable id (compare by email, as before), for someone this Memory has no account for
   * yet, and for a person {@link alignSession} would refuse.
   */
  async describeIdentity(req: Request): Promise<{ username: string | null; accountId: string | null }> {
    const identity = this.verifyIdentity(req);
    if (!identity) {
      return { username: null, accountId: null };
    }

    if (!identity.stableId) {
      return { username: identity.username, accountId: null };
    }

    const placement = await this.locate(
      identity.username,
      identity.stableId,
      this.signedInAs(() => this.readSession(req)),
    );

    return {
      username: identity.username,
      accountId: placement.kind === 'linked' || placement.kind === 'adopt' ? placement.user.id : null,
    };
  }

  /**
   * If Hub headers name a different person than the Memory cookie, invalidate
   * the stale session and mint one for the Hub person (JIT-creating their
   * Memory user when they have never opened Memory on this box).
   */
  async alignSession(req: Request, res: Response): Promise<HubBridgeResult> {
    const identity = this.verifyIdentity(req);
    if (!identity) {
      return { username: null, replaced: false };
    }

    return identity.stableId
      ? this.alignByStableId(req, res, identity.username, identity.stableId)
      : this.alignByEmail(req, res, identity.username);
  }

  private async alignByStableId(
    req: Request,
    res: Response,
    username: string,
    stableId: HubStableId,
  ): Promise<HubBridgeResult> {
    const session = await this.readSession(req);

    let placed: { kind: 'account'; user: User } | { kind: 'refused'; reason: HubBridgeRefusal };
    try {
      placed = await this.place(
        username,
        stableId,
        this.signedInAs(async () => session),
      );
    } catch (error) {
      // Who the Hub person is could not be settled, so nobody can say this session is theirs.
      // Leaving it standing could leave them in someone else's account, so sign it out.
      await this.signOut(req, res, session);
      throw error;
    }

    if (placed.kind === 'refused') {
      await this.signOut(req, res, session);
      this.logger.warn(
        `not signing in Hub person ${stableId.issuer}#${stableId.subject} (${username}): ${placed.reason}`,
      );

      return { username, replaced: false, refused: placed.reason };
    }

    if (session?.userId === placed.user.id) {
      return { username, replaced: false };
    }

    await this.invalidate(req, session);

    return this.issueSessionFor(req, res, placed.user, username, session);
  }

  /** The bridge as it was before stable ids, for a Hub that sends none: the account is the address. */
  private async alignByEmail(req: Request, res: Response, username: string): Promise<HubBridgeResult> {
    const session = await this.readSession(req);

    if (session && emailsEqual(session.email, username)) {
      return { username, replaced: false };
    }

    // Before the account is found or created, as it always was: if that throws, the
    // previous person's session is already gone.
    await this.invalidate(req, session);

    const placed = await this.ensureUser(username);

    if (placed.kind === 'refused') {
      // The session above is already invalidated; this clears its cookies.
      await this.signOut(req, res, null);
      this.logger.warn(`not signing in Hub person ${username}: ${placed.reason}`);

      return { username, replaced: false, refused: placed.reason };
    }

    return this.issueSessionFor(req, res, placed.user, username, session);
  }

  /**
   * The account a Hub person with a stable id signs in as, linking them the first time.
   *
   * A unique violation is a concurrent first sight (a second tab) that won the race to link or
   * create; placing again finds its work.
   */
  private async place(
    username: string,
    stableId: HubStableId,
    signedInAs: SignedInAs,
  ): Promise<{ kind: 'account'; user: User } | { kind: 'refused'; reason: HubBridgeRefusal }> {
    const { issuer, subject } = stableId;

    for (let attempt = 1; ; attempt += 1) {
      const placement = await this.locate(username, stableId, signedInAs);

      try {
        if (placement.kind === 'linked') {
          return { kind: 'account', user: placement.user };
        }

        if (placement.kind === 'refused') {
          return placement;
        }

        if (placement.kind === 'adopt') {
          const binding = await this.federatedIdentityService.bind({
            userId: placement.user.id,
            issuer,
            subject,
            email: username,
            bindMethod: 'email_link',
          });

          // `bind` returns an existing (issuer, subject) row as it finds it: a racer linked them first.
          if (binding.userId === placement.user.id) {
            // Adopted on the strength of this browser's own session: the Hub has now vouched for
            // the address as this person's username, so it counts as proven from here on.
            if (!this.userService.isEmailProven(placement.user)) {
              await this.userService.markEmailProven(placement.user.id);
            }

            this.logger.log(
              `linked Hub person ${issuer}#${subject} to existing Memory user ${placement.user.id} (${username})`,
            );

            return { kind: 'account', user: placement.user };
          }
        } else {
          const created = await this.userService.create(
            { userId: SYSTEM_USER },
            this.accountFor(username),
            (manager, user) =>
              this.federatedIdentityService.bind(
                { userId: user.id, issuer, subject, email: username, bindMethod: 'sub' },
                manager,
              ),
          );

          this.logger.log(
            `JIT-created Memory user ${created.id} for Hub person ${issuer}#${subject} (${username})`,
          );

          return { kind: 'account', user: created };
        }
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= MAX_PLACEMENT_ATTEMPTS) {
          throw error;
        }
      }

      if (attempt >= MAX_PLACEMENT_ATTEMPTS) {
        throw new Error(`could not settle the Memory account for Hub person ${issuer}#${subject}`);
      }
    }
  }

  /**
   * Where a Hub person with a stable id belongs, without writing anything.
   *
   * 1. Linked: that account, whatever its address or the Hub username now say. Linked to an account
   *    that no longer resolves (deleted, awaiting its purge): refused, and nothing is created in its
   *    place.
   * 2. Not linked: the account the Hub username names, adopted once. That is the exact address, else
   *    the only case-insensitive match. Refused when another person of this Hub already holds it
   *    (the takeover a reused username would otherwise be), or when several accounts match. Also
   *    refused when the account's address is not proven, unless this browser is already signed in
   *    to that very account (`signedInAs`): an address typed into signup or an email change could
   *    be this person's, planted by someone else to receive their first sign-in.
   * 3. Nobody: a new account, unless an account awaiting its purge still holds the address.
   *
   * "This Hub" is the issuer: a directory of people that lives and dies with the Hub's database.
   * A Memory restored onto a fresh Hub keeps links into a directory that no longer signs anything,
   * and the new Hub's people are adopted by username exactly as before any link existed.
   */
  private async locate(
    username: string,
    { issuer, subject }: HubStableId,
    signedInAs: SignedInAs = SIGNED_IN_AS_NOBODY,
  ): Promise<Placement> {
    const linkedUserId = await this.federatedIdentityService.findUserId(issuer, subject);
    if (linkedUserId) {
      const linked = await this.userService.findById({ userId: SYSTEM_USER }, linkedUserId);

      return linked ? { kind: 'linked', user: linked } : { kind: 'refused', reason: 'account_unavailable' };
    }

    // The exact address, else the only case-insensitive match.
    const named = await this.userService.findAccountByEmail(username);
    if (named === 'ambiguous') {
      return { kind: 'refused', reason: 'account_ambiguous' };
    }

    if (named) {
      const holder = await this.federatedIdentityService.findForUserFromIssuer(named.id, issuer);

      if (holder) {
        return { kind: 'refused', reason: 'account_linked_elsewhere' };
      }

      return this.userService.isEmailProven(named) || (await signedInAs()) === named.id
        ? { kind: 'adopt', user: named }
        : { kind: 'refused', reason: 'account_unproven' };
    }

    // `ci.users.email` stays unique across soft-deleted rows (see `checkEmailAvailability`, which
    // reports whether an address is TAKEN), so a new account could not have it until the purge.
    return (await this.userService.checkEmailAvailability(username))
      ? { kind: 'refused', reason: 'account_unavailable' }
      : { kind: 'create' };
  }

  private async readSession(req: Request): Promise<MemorySession | null> {
    const token = req.cookies?.[config.auth.cookies.sessionTokenName] as string | undefined;
    if (!token) {
      return null;
    }

    try {
      const payload = this.authService.validateSessionToken(token);
      const existing = await this.userService.findById({ userId: payload.sub }, payload.sub);

      return { userId: payload.sub, token, email: existing?.email ?? null };
    } catch {
      return null;
    }
  }

  /**
   * The account this browser's session belongs to, when the session is still live (its
   * `ci.sessions` row exists and has not expired). A signed session cookie alone is not enough:
   * logging out deletes the row and leaves the cookie's signature valid.
   */
  private async liveSessionUserId(session: MemorySession | null): Promise<string | null> {
    if (!session) {
      return null;
    }

    try {
      return (await this.authService.sessionEstablishedAt(session.userId, session.token)) ? session.userId : null;
    } catch {
      return null;
    }
  }

  /** {@link liveSessionUserId}, looked up the first time a placement asks and remembered after. */
  private signedInAs(session: () => Promise<MemorySession | null>): SignedInAs {
    let answer: Promise<string | null> | null = null;

    return () => (answer ??= session().then((found) => this.liveSessionUserId(found)));
  }

  private async invalidate(req: Request, session: MemorySession | null): Promise<void> {
    if (!session) {
      return;
    }

    try {
      await this.authService.invalidateSession(
        session.userId,
        session.token,
        this.authService.getSessionMetadata(req),
      );
    } catch {
      // Cookie may already be expired; whatever replaces or clears it below still wins.
    }
  }

  /** End whatever session this browser holds: the Hub named someone this Memory will not sign in. */
  private async signOut(req: Request, res: Response, session: MemorySession | null): Promise<void> {
    await this.invalidate(req, session);
    clearSessionCookie(req, res);
    clearCsrfCookie(req, res);
  }

  private async issueSessionFor(
    req: Request,
    res: Response,
    user: { id: string },
    username: string,
    previous: MemorySession | null,
  ): Promise<HubBridgeResult> {
    const { sessionToken: nextToken, sessionId } = await this.authService.issueSessionToken(
      user.id,
      this.authService.getSessionMetadata(req),
    );

    setSessionCookie(req, res, nextToken);
    setCsrfCookie(req, res, this.csrfService.generateToken(sessionId));

    // Keep this line's shape: with the account's email in "was", it is the only record of which
    // account a person was moved out of, should a stranded one ever need re-pairing.
    this.logger.log(
      `aligned Memory session to Hub user ${username}${previous?.email ? ` (was ${previous.email})` : ''}`,
    );

    return {
      username,
      replaced: true,
      accessToken: this.authService.issueAccessToken(user.id),
    };
  }

  /**
   * The account a Hub that sends no stable id signs this person in to: the one their username
   * names, held to the same rules as a first link by stable id ({@link locate}). Refused when
   * several accounts match the address once case is ignored, or when the one that matches has an
   * address nothing proved is theirs: without a stable id the address is the whole link, so a
   * member who typed it into their own account would receive this person's every sign-in. The
   * caller has already kept the session of a browser signed in to that very account.
   */
  private async ensureUser(
    email: string,
  ): Promise<
    | { kind: 'account'; user: { id: string; email: string } }
    | { kind: 'refused'; reason: Extract<HubBridgeRefusal, 'account_ambiguous' | 'account_unproven'> }
  > {
    const existing = await this.userService.findAccountByEmail(email);
    if (existing === 'ambiguous') {
      return { kind: 'refused', reason: 'account_ambiguous' };
    }

    if (existing) {
      return this.userService.isEmailProven(existing)
        ? { kind: 'account', user: existing }
        : { kind: 'refused', reason: 'account_unproven' };
    }

    const created = await this.userService.create({ userId: SYSTEM_USER }, this.accountFor(email));

    this.logger.log(`JIT-created Memory user for Hub-invited person ${email}`);

    return { kind: 'account', user: created };
  }

  /** The account the bridge creates for a Hub person: nobody has seen its password, so none is stamped. */
  private accountFor(email: string): CreateUserDto {
    return {
      name: email.split('@')[0] || email,
      email,
      password: randomBytes(32).toString('hex'),
      passwordChosenByUser: false,
      // The address is the Hub-signed username of the person it is created for.
      emailProven: true,
    };
  }
}

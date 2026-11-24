import { createHmac } from 'crypto';

import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import parseDuration from 'parse-duration';
import { type FindOptionsWhere, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import config from '@ci/configuration';
import { LiveChangesService } from '@ci/domains/live-changes';

import { SessionEntity } from '../entities/SessionEntity';
import type { IssuedSession, JwtPayload, RotationResult, SessionMetadata } from '../types';

/** The OIDC (issuer, subject) pair a signup intent was minted for. */
export interface SignupIntentIdentity {
  issuer: string;
  subject: string;
}

/**
 * What the confirm-account step learns from its cookie. `issuer`/`subject` are
 * what let it bind the account it creates to the Portal identity that asked for
 * it — and recognise the one case where an account already exists for the
 * address legitimately (a concurrent tab that confirmed first).
 */
export interface SignupIntent extends Partial<SignupIntentIdentity> {
  email: string;
  name?: string;
  /**
   * The callback waived the signup code for this person only because the
   * appliance had no accounts. That was true when the intent was minted, which
   * can be its whole lifetime before the confirm step runs — so the confirm step
   * creates the account only if it is still the first, and decides that
   * atomically with the insert (`UserService.createFirstAccount`).
   *
   * Absent on an intent where nothing was waived: codes are off, or the person
   * holds an invitation.
   */
  firstAccountOnly?: boolean;
  /**
   * The Portal asserted `email_verified` for this address. The account the
   * confirm step creates counts its address as proven only then. Absent when the
   * Portal did not verify it.
   */
  emailVerified?: boolean;
}

const SESSION_EXPIRES_IN = parseDuration(config.auth.session.duration) ?? 0;
/**
 * How long the token a rotation replaced still matches, as a grace match that gets the current token
 * back ({@link AuthService.rotateSessionToken}). Long enough for the web app's own recovery from a
 * refresh whose answer it never got: a reloaded tab refreshes at once. The app retries five seconds
 * after a refresh Memory did not answer and gives up waiting on one after 25 seconds, so two minutes
 * also cover a short outage. Shorter than the app's refresh interval (it refreshes a minute before
 * its five-minute access token runs out), so a stale copy of the cookie that refreshes only on that
 * schedule usually lands outside the window after a rotation it missed and is refused, as it
 * always was.
 */
const REFRESH_GRACE_PERIOD = parseDuration(config.auth.session.refreshGracePeriod) ?? 0;

/**
 * The key signup-intent tokens are signed with: derived from the session secret, never equal to it.
 *
 * An intent used to be signed with the session secret itself, so it verified wherever a session
 * cookie does. It carries no `sub`, and the connect consent page read that missing `sub` straight
 * into a user lookup, which then matched whichever account came first. With a key of its own an
 * intent cannot verify as a session anywhere, and a session cookie cannot pass as an intent.
 *
 * Derived rather than configured, so no install needs a new secret. Changing it only voids intents
 * minted before the change, which live ten minutes and end in "sign in again".
 */
export function signupIntentSecret(): string {
  return createHmac('sha256', config.auth.jwt.refreshTokenSecret).update('ci:signup-intent:v1').digest('hex');
}

/**
 * Whether verified claims are a session's: a non-empty string `sub` and no `purpose`.
 *
 * The signature only says this server minted the token. Every other token signed with the session
 * secret (today, none; before {@link signupIntentSecret}, the signup intent) names its purpose, and
 * a session is the one kind that names a user.
 */
function isSessionClaims(payload: unknown): payload is JwtPayload {
  if (payload == null || typeof payload !== 'object') {
    return false;
  }

  const { sub, purpose } = payload as { sub?: unknown; purpose?: unknown };

  return typeof sub === 'string' && sub.length > 0 && purpose === undefined;
}

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepository: Repository<SessionEntity>,
    @Optional() private readonly liveChanges?: LiveChangesService,
  ) {}

  /**
   * Create a session row and sign its cookie token. The id is minted FIRST so
   * the JWT can carry it as the `sid` claim — that claim is what later lets a
   * request's CSRF token be checked against the session that minted it, without
   * a database read.
   */
  async issueSessionToken(
    userId: string,
    meta: SessionMetadata,
    expectedCredentialsResetAt?: Date | null,
  ): Promise<IssuedSession> {
    if (expectedCredentialsResetAt !== undefined) {
      // Local password validation happens before this call. A recovery that
      // won the owner lock in between must not admit that old password now.
      return this.sessionRepository.manager.transaction(async (manager) => {
        const rows = await manager.query(
          'SELECT credentials_reset_at FROM ci.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [userId],
        );
        const actual = rows[0]?.credentials_reset_at?.getTime() ?? null;
        if (!rows.length || actual !== (expectedCredentialsResetAt?.getTime() ?? null)) {
          throw new UnauthorizedException('Credentials changed. Sign in again.');
        }

        return this.persistSession(userId, meta, manager.getRepository(SessionEntity));
      });
    }

    return this.persistSession(userId, meta, this.sessionRepository);
  }

  private async persistSession(
    userId: string,
    meta: SessionMetadata,
    repository: Repository<SessionEntity>,
  ): Promise<IssuedSession> {
    const now = new Date().getTime();

    const sessionId = uuidv7();
    const token = this.generateSessionToken(userId, sessionId);
    const expiresAt = new Date(now + SESSION_EXPIRES_IN);

    const hashedToken = this.digest(token);
    // NULL when the request had none; findSession matches a missing value with IsNull().
    const hashedIp = this.digest(meta.ip) ?? null;
    const hashedUserAgent = this.digest(meta.userAgent) ?? null;

    const session = repository.create({
      id: sessionId,
      token: hashedToken,
      ip: hashedIp,
      user_agent: hashedUserAgent,
      expires_at: expiresAt,
      user: {
        id: userId,
      },
    });

    await repository.save(session);

    return { sessionToken: token, sessionId };
  }

  /**
   * Verify a session cookie's signature and expiry and that it names a user. Throws otherwise.
   *
   * This does not consult `ci.sessions`, so a cookie from a session that was signed out still
   * passes until it expires. Where that matters, use {@link resolveLiveSession}.
   */
  validateSessionToken(token: string): JwtPayload {
    const payload: unknown = this.jwtService.verify(token, {
      secret: config.auth.jwt.refreshTokenSecret,
    });

    if (!isSessionClaims(payload)) {
      throw new UnauthorizedException('Not a session token');
    }

    return payload;
  }

  /**
   * The live session behind a session cookie, or null.
   *
   * Live means the cookie verifies ({@link validateSessionToken}) AND its row in `ci.sessions` still
   * exists, has not expired and belongs to the user the cookie names. So signing out, or a password
   * change that signs other devices out, ends the session here too. The row is matched on the
   * token's hash, or on the previous hash inside the rotation grace window, the same two matches the
   * refresh path accepts. Unlike refresh, the client address and user agent are not compared: this
   * answers "is this person signed in", not "may this cookie be rotated".
   */
  async resolveLiveSession(token: string): Promise<{ userId: string; sessionId: string } | null> {
    let userId: string;

    try {
      userId = this.validateSessionToken(token).sub;
    } catch {
      return null;
    }

    const match = await this.findLiveSession(userId, token);

    return match ? { userId, sessionId: match.session.id } : null;
  }

  /**
   * Short-lived signed token that carries an OIDC-verified identity between the
   * OIDC callback and the "create your account?" confirmation step. It proves
   * the email/name came from a successful Portal sign-in (not client-supplied),
   * so the confirm endpoint can create the account without re-trusting inputs.
   *
   * Signed with {@link signupIntentSecret}, not the session secret, so it can
   * never verify as a session. The `purpose` claim stays as a second check.
   */
  issueSignupIntentToken(
    email: string,
    name?: string,
    identity?: SignupIntentIdentity,
    admission?: Pick<SignupIntent, 'firstAccountOnly' | 'emailVerified'>,
  ): string {
    return this.jwtService.sign(
      {
        email,
        name,
        purpose: 'signup_intent',
        issuer: identity?.issuer,
        subject: identity?.subject,
        // Only ever `true` or absent, so an intent that waived nothing reads exactly as before.
        firstAccountOnly: admission?.firstAccountOnly === true ? true : undefined,
        emailVerified: admission?.emailVerified === true ? true : undefined,
      },
      { secret: signupIntentSecret(), expiresIn: '10m' },
    );
  }

  verifySignupIntentToken(token: string): SignupIntent {
    const payload = this.jwtService.verify<{
      email?: string;
      name?: string;
      purpose?: string;
      issuer?: string;
      subject?: string;
      firstAccountOnly?: boolean;
      emailVerified?: boolean;
    }>(token, {
      secret: signupIntentSecret(),
    });

    if (payload.purpose !== 'signup_intent' || !payload.email) {
      throw new UnauthorizedException('Invalid signup intent token');
    }

    return {
      email: payload.email,
      name: payload.name,
      issuer: payload.issuer,
      subject: payload.subject,
      ...(payload.firstAccountOnly === true ? { firstAccountOnly: true } : {}),
      ...(payload.emailVerified === true ? { emailVerified: true } : {}),
    };
  }

  /**
   * Refresh: replace the session token, or answer a refresh with the token the last rotation
   * replaced (the grace match) with the session's current token.
   *
   * The replacement is conditional on the token this request read, so of several refreshes of one
   * session that arrive together exactly one replaces it and the others become grace matches. An
   * unconditional save let each of them write its own token: the last write kept the first old token
   * as `previous_token` and the other new cookies matched nothing from the start. Nor can a refresh
   * write back a row a sign-out deleted in the meantime, as that save did.
   *
   * A grace match comes from a refresh sent alongside the one that replaced the token, or from a
   * browser that never got that refresh's answer (the connection dropped, the tab reloaded). Both get
   * the current token again ({@link currentSessionToken}), so the browser catches up instead of
   * holding a cookie that stops working when the window ends. The previous token stops matching as
   * soon as the current one refreshes, because that rotation makes the current one the previous.
   */
  async rotateSessionToken(userId: string, token: string, meta: SessionMetadata): Promise<RotationResult> {
    const { session, graceMatch } = await this.findSession(userId, token, meta);

    if (graceMatch) {
      return this.graceAnswer(userId, session);
    }

    // The rotated token is signed with the SAME sid. For a legacy sid-less
    // cookie this first rotation is the upgrade point: the new JWT embeds the
    // session id, and the same response's ensureCsrfCookie re-binds the CSRF
    // token from the anonymous scope to it. Its `iat` is the second of
    // `rotated_at`, which is what lets currentSessionToken sign it again.
    const rotatedAt = new Date();
    const nextToken = this.generateSessionToken(userId, session.id, rotatedAt);
    const nextHash = this.digest(nextToken);

    // Signed in the same second as the token it would replace, so it is that token. Writing it
    // would move the current hash into previous_token, so the token before it (still in flight
    // from another tab) would stop matching. The browser already holds this one.
    if (nextHash === session.token) {
      return { sessionToken: nextToken, sessionId: session.id };
    }

    const { affected } = await this.sessionRepository.update(
      { id: session.id, token: session.token },
      { previous_token: session.token, token: nextHash, rotated_at: rotatedAt },
    );

    // `affected` is a number on Postgres. Read a missing count as "not written" too: looking again
    // costs a query and still answers right, while trusting it would hand out a token nothing holds.
    if (!affected) {
      // Another refresh replaced this token after it was read, or a sign-out ended the session.
      // Look again: the first is now a grace match, the second nothing.
      const raced = await this.findSession(userId, token, meta);

      if (!raced.graceMatch) {
        throw new UnauthorizedException('Invalid session');
      }

      return this.graceAnswer(userId, raced.session);
    }

    return {
      sessionToken: nextToken,
      sessionId: session.id,
    };
  }

  /**
   * End the session `token` belongs to, for sign-out and for the Hub bridge replacing a session.
   * True when a session was ended. False when none was left to end: signed out already, signed out
   * by a password change on another device, expired or ended by a concurrent sign-out between the
   * lookup and the delete.
   *
   * Matched like {@link resolveLiveSession}: the token's hash (or the previous hash inside the
   * rotation grace window) together with the user the token names. Not the address and user agent
   * the session was signed in from, which only refresh compares. A browser that updated, or a laptop
   * that moved to another network, must still be able to end its own session: matching them here
   * answered that sign-out with 401 and left the session refreshable for the rest of its week.
   */
  async invalidateSession(userId: string, token: string): Promise<boolean> {
    const match = await this.findLiveSession(userId, token);

    if (!match) {
      return false;
    }

    const { affected } = await this.sessionRepository.delete({
      id: match.session.id,
    });

    // Postgres always reports the count; a driver that reports none is taken at its word that it ran.
    const ended = affected !== 0;

    if (ended) {
      // Its open live-update streams end now, not at their next keep-alive.
      await this.liveChanges?.publishRevoked(userId);
    }

    return ended;
  }

  /**
   * Sign every OTHER browser/device out after a credential change. The
   * session making this request stays alive — deliberately: the point is to
   * force re-authentication elsewhere, not to log the person out of the flow
   * they're mid-way through. `currentToken` is null for an API-key-authenticated
   * request (native holds no session cookie at all), in which case there is no
   * "current session" to spare and every session is invalidated.
   *
   * The session that stays keeps only the token this request holds. The token its last refresh
   * replaced would still be a grace match for the rest of the window, and a grace match gets the
   * current token back, so a copy of the old cookie would outlive the credential change.
   */
  async invalidateOtherSessions(userId: string, currentToken: string | null | undefined): Promise<void> {
    const currentHashed = currentToken ? this.digest(currentToken) : null;

    const result = await this.sessionRepository.delete({
      user: { id: userId },
      ...(currentHashed ? { token: Not(currentHashed) } : {}),
    });

    if (currentHashed) {
      await this.sessionRepository.update(
        { user: { id: userId }, token: currentHashed },
        { previous_token: null },
      );
    }

    if ((result.affected ?? 0) > 0) {
      await this.liveChanges?.publishRevoked(userId);
    }
  }

  /**
   * When the session behind `token` was established — its sign-in time, which
   * survives token rotation because the row does. `null` when the token names
   * no live session of this user. Read by `AccountController.requireReauth`
   * as the "signed in recently" proof for an account with no password to ask
   * for; nothing about the session is touched or extended.
   */
  async sessionEstablishedAt(userId: string, token: string): Promise<Date | null> {
    const session = await this.sessionRepository.findOne({
      where: { token: this.digest(token), expires_at: MoreThan(new Date()), user: { id: userId } },
    });

    return session?.created_at ?? null;
  }

  /**
   * `sessionId` is the session the token is minted for, carried as `sid`. The
   * live-update stream and chat (generate, re-attach and the turn it queues)
   * read it, to refuse or end when that session is signed out; every other
   * request takes the token as it is until it expires.
   *
   * `issuedAtMs` is when the caller authenticated the request that mints the
   * token. JwtStrategy rejects a token whose `issuedAtMs` is not later than the
   * account's `credentials_reset_at`, so every token must carry it.
   */
  issueAccessToken(userId: string, sessionId?: string, issuedAtMs = Date.now()): string {
    const payload = {
      sub: userId,
      issuedAtMs,
      ...(sessionId ? { sid: sessionId } : {}),
    } satisfies JwtPayload;

    const accessToken = this.jwtService.sign(payload);

    return accessToken;
  }

  getSessionMetadata(request: Request): SessionMetadata {
    return {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }

  /**
   * The unexpired session of `userId` whose current token is `token`, or whose previous token it is
   * inside the rotation grace window (`graceMatch`). `binding` adds conditions to both lookups: refresh
   * passes the client address and user agent ({@link findSession}); sign-out and
   * {@link resolveLiveSession} pass nothing.
   */
  private async findLiveSession(
    userId: string,
    token: string,
    binding: FindOptionsWhere<SessionEntity> = {},
  ): Promise<{ session: SessionEntity; graceMatch: boolean } | null> {
    const now = new Date();
    const hashedToken = this.digest(token);
    const live = { ...binding, expires_at: MoreThan(now), user: { id: userId } };

    const current = await this.sessionRepository.findOne({ where: { ...live, token: hashedToken } });

    if (current) {
      return { session: current, graceMatch: false };
    }

    if (REFRESH_GRACE_PERIOD <= 0) {
      return null;
    }

    const previous = await this.sessionRepository.findOne({
      where: {
        ...live,
        previous_token: hashedToken,
        rotated_at: MoreThan(new Date(now.getTime() - REFRESH_GRACE_PERIOD)),
      },
    });

    return previous ? { session: previous, graceMatch: true } : null;
  }

  /** {@link findLiveSession} bound to the client address and user agent, for refresh. Throws when none matches. */
  private async findSession(
    userId: string,
    token: string,
    data: SessionMetadata,
  ): Promise<{ session: SessionEntity; graceMatch: boolean }> {
    // A request with no User-Agent header (or no address) has nothing to digest.
    // issueSessionToken stores NULL for it, so that is what to match: a session bound
    // to a User-Agent still needs that one; one bound to none needs none. TypeORM
    // refuses an `undefined` where value outright ("Undefined value encountered in
    // property 'SessionEntity.user_agent'"), which answered 500.
    const match = await this.findLiveSession(userId, token, {
      ip: this.digest(data.ip) ?? IsNull(),
      user_agent: this.digest(data.userAgent) ?? IsNull(),
    });

    if (!match) {
      throw new UnauthorizedException('Invalid session');
    }

    return match;
  }

  /**
   * Resolve the CSRF scope of a request: the id of the session its cookie
   * belongs to, or `null` when the request is effectively anonymous (no
   * session cookie, an unverifiable one, or a legacy token without a `sid`
   * claim).
   *
   * `ignoreExpiration` is deliberate: the CSRF scope identifies the principal
   * a token was MINTED for, and expiry says nothing about that. Session
   * validity is enforced where sessions are actually consumed — refresh and
   * logout both re-verify with expiry via validateSessionToken, so an expired
   * cookie still ends in a 401; API auth uses access tokens.
   *
   * What this buys is the ORDER of failure, not the outcome. Enforcing expiry
   * here would make an expired (or clock-skewed) session cookie resolve to the
   * anonymous scope, so its session-bound CSRF token would be rejected first
   * and the request would 403 before ever reaching the 401 that describes the
   * real problem — spending the SPA's one-shot CSRF retry on a token that was
   * never the issue. The signature check still stands, so a forged cookie
   * cannot choose a scope.
   */
  resolveCsrfScope(req: Request): string | null {
    const token: unknown = req.cookies?.[config.auth.cookies.sessionTokenName];

    if (typeof token !== 'string' || token === '') {
      return null;
    }

    try {
      const payload: unknown = this.jwtService.verify(token, {
        secret: config.auth.jwt.refreshTokenSecret,
        ignoreExpiration: true,
      });

      return isSessionClaims(payload) ? (payload.sid ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * The answer to a grace match: the session's current token again. The session id comes back too,
   * so the response can keep the CSRF cookie bound to this session.
   */
  private graceAnswer(userId: string, session: SessionEntity): RotationResult {
    return { sessionToken: this.currentSessionToken(userId, session), sessionId: session.id };
  }

  /**
   * The session's current token, signed again, for a grace match to send back. Only the token's hash
   * is stored, but the token itself is deterministic: a rotation signs it with `iat` taken from the
   * `rotated_at` it stores. Nothing else in it changes.
   *
   * Null unless the result hashes to the stored token: a session whose last rotation signed in another
   * second than the `rotated_at` it stored (possible before `iat` came from `rotated_at`), or one last
   * rotated before the refresh secret or token lifetime changed. The refresh then sets no cookie, as
   * it always did on a grace match; it never hands out a token the session does not hold.
   */
  private currentSessionToken(userId: string, session: SessionEntity): string | null {
    if (!session.rotated_at) {
      return null;
    }

    const token = this.generateSessionToken(userId, session.id, session.rotated_at);

    return this.digest(token) === session.token ? token : null;
  }

  private generateSessionToken(userId: string, sessionId: string, issuedAt = new Date()) {
    const payload = {
      sub: userId,
      // Binds the cookie to its session row; resolveCsrfScope reads this claim
      // to check a CSRF token against the session that minted it.
      sid: sessionId,
    } satisfies JwtPayload;

    // `iat` set here rather than by the signer, so the same claims sign the same token again
    // (currentSessionToken).
    return this.jwtService.sign(
      { ...payload, iat: Math.floor(issuedAt.getTime() / 1000) },
      {
        secret: config.auth.jwt.refreshTokenSecret,
        expiresIn: config.auth.jwt.refreshTokenExpiration as JwtSignOptions['expiresIn'],
      },
    );
  }

  private digest(value: string): string;

  private digest(value: string | null | undefined): string | undefined;

  private digest(value?: string | null) {
    if (value == null) {
      return undefined;
    }

    // Keyed HMAC mitigates pre-computation attacks against low-entropy fields
    // (IP addresses, user agents). For high-entropy session tokens, the pepper
    // is defense-in-depth; plain SHA-256 would suffice but peppering adds
    // marginal cost so we're simplifying code by using the same digest function
    // for all fields.
    return createHmac('sha256', config.auth.session.fieldPepper).update(value).digest('hex');
  }
}

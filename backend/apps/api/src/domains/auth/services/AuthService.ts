import { createHmac } from 'crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import parseDuration from 'parse-duration';
import { MoreThan, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import config from '@ci/configuration';

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
}

const SESSION_EXPIRES_IN = parseDuration(config.auth.session.duration) ?? 0;
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
  ) {}

  /**
   * Create a session row and sign its cookie token. The id is minted FIRST so
   * the JWT can carry it as the `sid` claim — that claim is what later lets a
   * request's CSRF token be checked against the session that minted it, without
   * a database read.
   */
  async issueSessionToken(userId: string, meta: SessionMetadata): Promise<IssuedSession> {
    const now = new Date().getTime();

    const sessionId = uuidv7();
    const token = this.generateSessionToken(userId, sessionId);
    const expiresAt = new Date(now + SESSION_EXPIRES_IN);

    const hashedToken = this.digest(token);
    const hashedIp = this.digest(meta.ip);
    const hashedUserAgent = this.digest(meta.userAgent);

    const session = this.sessionRepository.create({
      id: sessionId,
      token: hashedToken,
      ip: hashedIp,
      user_agent: hashedUserAgent,
      expires_at: expiresAt,
      user: {
        id: userId,
      },
    });

    await this.sessionRepository.save(session);

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

    const now = new Date();
    const hashedToken = this.digest(token);
    const user = { id: userId };

    const session =
      (await this.sessionRepository.findOne({
        where: { token: hashedToken, expires_at: MoreThan(now), user },
      })) ??
      (REFRESH_GRACE_PERIOD > 0
        ? await this.sessionRepository.findOne({
            where: {
              previous_token: hashedToken,
              rotated_at: MoreThan(new Date(now.getTime() - REFRESH_GRACE_PERIOD)),
              expires_at: MoreThan(now),
              user,
            },
          })
        : null);

    return session ? { userId, sessionId: session.id } : null;
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
    admission?: Pick<SignupIntent, 'firstAccountOnly'>,
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
    };
  }

  async rotateSessionToken(userId: string, token: string, meta: SessionMetadata): Promise<RotationResult> {
    const { session, graceMatch } = await this.findSession(userId, token, meta);

    // Token matched the previous (pre-rotation) hash within the grace window.
    // Don't rotate again, just signal the caller to issue an access token
    // without setting a new session cookie. This handles N concurrent
    // refreshes. sessionId is still returned so the response can keep the CSRF
    // cookie bound to this session.
    if (graceMatch) {
      return {
        sessionToken: null,
        sessionId: session.id,
      };
    }

    // The rotated token is signed with the SAME sid. For a legacy sid-less
    // cookie this first rotation is the upgrade point: the new JWT embeds the
    // session id, and the same response's ensureCsrfCookie re-binds the CSRF
    // token from the anonymous scope to it.
    const nextToken = this.generateSessionToken(userId, session.id);

    session.previous_token = session.token;
    session.token = this.digest(nextToken);
    session.rotated_at = new Date();

    await this.sessionRepository.save(session);

    return {
      sessionToken: nextToken,
      sessionId: session.id,
    };
  }

  async invalidateSession(userId: string, token: string, meta: SessionMetadata): Promise<void> {
    const { session } = await this.findSession(userId, token, meta);

    await this.sessionRepository.delete({
      id: session.id,
    });
  }

  /**
   * Sign every OTHER browser/device out after a credential change. The
   * session making this request stays alive — deliberately: the point is to
   * force re-authentication elsewhere, not to log the person out of the flow
   * they're mid-way through. `currentToken` is null for an API-key-authenticated
   * request (native holds no session cookie at all), in which case there is no
   * "current session" to spare and every session is invalidated.
   */
  async invalidateOtherSessions(userId: string, currentToken: string | null | undefined): Promise<void> {
    const currentHashed = currentToken ? this.digest(currentToken) : null;

    await this.sessionRepository.delete({
      user: { id: userId },
      ...(currentHashed ? { token: Not(currentHashed) } : {}),
    });
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

  issueAccessToken(userId: string): string {
    const payload = {
      sub: userId,
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

  private async findSession(
    userId: string,
    token: string,
    data: SessionMetadata,
  ): Promise<{ session: SessionEntity; graceMatch: boolean }> {
    const now = new Date();
    const hashedIp = this.digest(data.ip);
    const hashedUserAgent = this.digest(data.userAgent);
    const hashedToken = this.digest(token);

    const match = await this.sessionRepository.findOne({
      where: {
        token: hashedToken,
        ip: hashedIp,
        user_agent: hashedUserAgent,
        expires_at: MoreThan(now),
        user: {
          id: userId,
        },
      },
    });

    if (match) {
      return {
        session: match,
        graceMatch: false,
      };
    }

    // Check for a grace-period match where the token matches the previous hash
    // and the rotation happened within the configurable grace window.
    if (REFRESH_GRACE_PERIOD > 0) {
      const graceDeadline = new Date(now.getTime() - REFRESH_GRACE_PERIOD);

      const graceMatch = await this.sessionRepository.findOne({
        where: {
          previous_token: hashedToken,
          rotated_at: MoreThan(graceDeadline),
          ip: hashedIp,
          user_agent: hashedUserAgent,
          expires_at: MoreThan(now),
          user: {
            id: userId,
          },
        },
      });

      if (graceMatch) {
        return {
          session: graceMatch,
          graceMatch: true,
        };
      }
    }

    throw new UnauthorizedException('Invalid session');
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

  private generateSessionToken(userId: string, sessionId: string) {
    const payload = {
      sub: userId,
      // Binds the cookie to its session row; resolveCsrfScope reads this claim
      // to check a CSRF token against the session that minted it.
      sid: sessionId,
    } satisfies JwtPayload;

    return this.jwtService.sign(payload, {
      secret: config.auth.jwt.refreshTokenSecret,
      expiresIn: config.auth.jwt.refreshTokenExpiration,
    });
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

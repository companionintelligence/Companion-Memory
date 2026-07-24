import { createHmac } from 'crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import parseDuration from 'parse-duration';
import { MoreThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import config from '@ci/configuration';

import { SessionEntity } from '../entities/SessionEntity';
import type { IssuedSession, JwtPayload, RotationResult, SessionMetadata } from '../types';

const SESSION_EXPIRES_IN = parseDuration(config.auth.session.duration) ?? 0;
const REFRESH_GRACE_PERIOD = parseDuration(config.auth.session.refreshGracePeriod) ?? 0;

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

  validateSessionToken(token: string): JwtPayload {
    return this.jwtService.verify(token, {
      secret: config.auth.jwt.refreshTokenSecret,
    });
  }

  /**
   * Short-lived signed token that carries an OIDC-verified identity between the
   * OIDC callback and the "create your account?" confirmation step. It proves
   * the email/name came from a successful Portal sign-in (not client-supplied),
   * so the confirm endpoint can create the account without re-trusting inputs.
   * The `purpose` claim prevents it being accepted anywhere a session token is.
   */
  issueSignupIntentToken(email: string, name?: string): string {
    return this.jwtService.sign(
      { email, name, purpose: 'signup_intent' },
      { secret: config.auth.jwt.refreshTokenSecret, expiresIn: '10m' },
    );
  }

  verifySignupIntentToken(token: string): { email: string; name?: string } {
    const payload = this.jwtService.verify<{ email?: string; name?: string; purpose?: string }>(token, {
      secret: config.auth.jwt.refreshTokenSecret,
    });

    if (payload.purpose !== 'signup_intent' || !payload.email) {
      throw new UnauthorizedException('Invalid signup intent token');
    }

    return { email: payload.email, name: payload.name };
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
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: config.auth.jwt.refreshTokenSecret,
        ignoreExpiration: true,
      });

      return payload.sid ?? null;
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

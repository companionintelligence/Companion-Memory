import { randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

import { SYSTEM_USER } from '@ci/common/context';
import {
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_USER_HEADER,
  verifyForwardAuthHeaders,
} from '@ci/common/crypto';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { setCsrfCookie, setSessionCookie } from '../utils/authCookies';

import { AuthService } from './AuthService';
import { CsrfService } from './CsrfService';

export interface HubBridgeResult {
  /** Verified Hub username (email), or null when headers are absent/disabled/invalid. */
  username: string | null;
  /** True when the Memory session was replaced or minted for the Hub person. */
  replaced: boolean;
  /** Access JWT when a session is now aligned with the Hub person. */
  accessToken?: string;
}

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
 */
@Injectable()
export class HubForwardAuthBridgeService {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly csrfService: CsrfService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(HubForwardAuthBridgeService.name);
  }

  /** Verified `X-CI-Hub-User`, or null when the feature is off or headers do not verify. */
  verifyUsername(req: Request): string | null {
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
      },
      { maxSkewMs: cfg.maxSkewMs },
    );

    return result.ok ? result.username : null;
  }

  /**
   * Whether this request arrives through the Hub as the owner of `email`.
   *
   * {@link alignSession} finds a Hub person's Memory account by this address and
   * nothing else, so while it holds the address is the Hub's link to the account:
   * change it here and the next alignment finds no account for the Hub person,
   * JIT-creates an empty one and signs them into that instead.
   */
  namesAccount(req: Request, email: string): boolean {
    return emailsEqual(this.verifyUsername(req), email);
  }

  /**
   * If Hub headers name a different person than the Memory cookie, invalidate
   * the stale session and mint one for the Hub person (JIT-creating their
   * Memory user when they have never opened Memory on this box).
   */
  async alignSession(req: Request, res: Response): Promise<HubBridgeResult> {
    const username = this.verifyUsername(req);
    if (!username) {
      return { username: null, replaced: false };
    }

    const sessionToken = req.cookies?.[config.auth.cookies.sessionTokenName] as string | undefined;
    let sessionUserId: string | null = null;
    let sessionEmail: string | null = null;

    if (sessionToken) {
      try {
        const payload = this.authService.validateSessionToken(sessionToken);
        sessionUserId = payload.sub;
        const existing = await this.userService.findById({ userId: payload.sub }, payload.sub);
        sessionEmail = existing?.email ?? null;
      } catch {
        sessionUserId = null;
        sessionEmail = null;
      }
    }

    if (sessionUserId && emailsEqual(sessionEmail, username)) {
      return { username, replaced: false };
    }

    if (sessionUserId && sessionToken) {
      try {
        await this.authService.invalidateSession(
          sessionUserId,
          sessionToken,
          this.authService.getSessionMetadata(req),
        );
      } catch {
        // Cookie may already be expired; the Set-Cookie below still replaces it.
      }
    }

    const user = await this.ensureUser(username);
    const { sessionToken: nextToken, sessionId } = await this.authService.issueSessionToken(
      user.id,
      this.authService.getSessionMetadata(req),
    );

    setSessionCookie(req, res, nextToken);
    setCsrfCookie(req, res, this.csrfService.generateToken(sessionId));

    this.logger.log(
      `aligned Memory session to Hub user ${username}${sessionEmail ? ` (was ${sessionEmail})` : ''}`,
    );

    return {
      username,
      replaced: true,
      accessToken: this.authService.issueAccessToken(user.id),
    };
  }

  private async ensureUser(email: string): Promise<{ id: string; email: string }> {
    const existing = await this.userService.findByEmail(email);
    if (existing) {
      return existing;
    }

    const created = await this.userService.create(
      { userId: SYSTEM_USER },
      {
        name: email.split('@')[0] || email,
        email,
        password: randomBytes(32).toString('hex'),
        passwordChosenByUser: false,
      },
    );

    this.logger.log(`JIT-created Memory user for Hub-invited person ${email}`);

    return created;
  }
}

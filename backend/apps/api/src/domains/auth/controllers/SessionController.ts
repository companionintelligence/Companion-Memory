import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';

import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { CookieCsrfGuard, CsrfGuard } from '../guards/CsrfGuard';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';
import { LoginThrottleService } from '../services/LoginThrottleService';
import { JwtPayload, LoginDto } from '../types';
import {
  clearCsrfCookie,
  clearSessionCookie,
  ensureCsrfCookie,
  setCsrfCookie,
  setSessionCookie,
} from '../utils/authCookies';

const localStrategySchema = z.object({
  username: z.string(),
  password: z.string(),
});

@Controller('authenticate')
export class SessionController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly csrfService: CsrfService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly hubBridge: HubForwardAuthBridgeService,
  ) {}

  /**
   * Issue a pre-auth CSRF token cookie. The frontend should call this before
   * submitting the login form and include the token as an `X-CSRF-Token`
   * header on the POST /authenticate request.
   *
   * Reuses a valid existing cookie (only minting when absent/invalid), so the
   * endpoint is idempotent and safe to call at any time — it can never
   * invalidate a token already embedded in an open page or another tab.
   */
  @Get('csrf')
  @HttpCode(200)
  issueCsrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Scope the token to whoever is asking: an already-signed-in browser gets (or
    // keeps) a session-bound token, a pre-auth one an anon token. `ensureCsrfCookie`
    // reuses a still-valid cookie rather than rotating, and returns the token on the
    // response.
    const token = ensureCsrfCookie(this.csrfService, req, res, this.authService.resolveCsrfScope(req));

    // Also return that token in the body (so this is 200, not 204). Browser clients
    // ignore it and rely on the SameSite cookie (double-submit), but a cookie-less
    // native client — whose cross-origin webview can neither read nor send that
    // cookie — reads it here and echoes it as the `x-csrf-token` header, which
    // CsrfGuard accepts on its own when no cookie is present. A native request is
    // anon-scoped (no session cookie), so the anon token it receives is exactly what
    // the guard's cookie-less branch verifies.
    return { csrfToken: token };
  }

  /**
   * Verified Hub identity for this request, or `{ username: null, accountId: null }`
   * when forward-auth is off / headers are missing. The SPA uses this to refuse a
   * stale Memory home when Traefik already named a different person: by
   * `accountId` — the account the Hub person signs in as — when the Hub sends a
   * stable id, and by `username` against the account's email when it does not.
   */
  @Get('hub-identity')
  @HttpCode(200)
  async hubIdentity(@Req() req: Request) {
    return this.hubBridge.describeIdentity(req);
  }

  /**
   * If Traefik named a Hub person who does not match the Memory cookie, replace
   * the session (and CSRF) so the next refresh/query is already the right user.
   *
   * Browser only, so the cookie-and-header CSRF pair is required: the native
   * app's cookie-less shape is not accepted here.
   */
  @Post('hub-bridge')
  @HttpCode(200)
  @UseGuards(CookieCsrfGuard)
  async hubBridgeAlign(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.hubBridge.alignSession(req, res);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ValidationPipe(localStrategySchema)) input: LoginDto,
  ) {
    // Same metadata the session row is bound to, so the throttle keys on the
    // proxy-trust-resolved client IP rather than on a header an attacker can
    // vary per request to buy themselves a fresh budget every guess.
    const metadata = this.authService.getSessionMetadata(req);
    const throttled = this.loginThrottle.check(metadata.ip, input.username);

    if (throttled.locked) {
      res.setHeader('Retry-After', String(throttled.retryAfterSeconds));

      // Deliberately says nothing about whether the account exists — the 401
      // below is careful not to be an enumeration oracle, and a 429 that named
      // the account would hand back exactly what that hides.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many login attempts. Please try again later.',
          retryAfterSeconds: throttled.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // An unknown address costs a bcrypt comparison too (`authenticatePassword`), so the 401
    // takes as long either way. `accountExists` only decides whether the failure also counts
    // against that account's own budget; the response never says.
    const { user, accountExists } = await this.userService.authenticatePassword(
      input.username,
      input.password,
    );

    if (user == null) {
      this.loginThrottle.recordFailure(metadata.ip, input.username, undefined, { accountExists });

      throw new UnauthorizedException('Invalid credentials');
    }

    // Only failures spend the budget: a correct password wipes the counter, so
    // an owner who fat-fingers their way to the right password is never locked
    // out by the attempts that preceded it.
    this.loginThrottle.recordSuccess(metadata.ip, input.username);

    const { sessionToken, sessionId } = await this.authService.issueSessionToken(user.id, metadata);

    const accessToken = await this.authService.issueAccessToken(user.id);

    setSessionCookie(req, res, sessionToken);

    // Identity boundary: mint a fresh CSRF token bound to the new session
    // (token-fixation hygiene — the pre-auth token must not survive login).
    // This and the other auth boundaries (signup, OIDC sign-in) are the only
    // places that rotate — everywhere else reuses the existing valid cookie.
    setCsrfCookie(req, res, this.csrfService.generateToken(sessionId));

    return {
      accessToken,
    };
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.getSessionToken(req);
    const payload = this.validateSessionToken(token);
    const userId = payload.sub;
    const user = await this.userService.findById({ userId }, userId);

    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { sessionToken, sessionId } = await this.authService.rotateSessionToken(
      userId,
      token,
      this.authService.getSessionMetadata(req),
    );

    const accessToken = await this.authService.issueAccessToken(userId);

    // If we obtain a new session token from calling `rotateSessionToken` then
    // we conclude that we have not matched a grace-period rotation and must set
    // a new cookie value.
    //
    // Otherwise we have a grace-period match and we avoid setting a new cookie.
    // The browser keeps the cookie from the first concurrent request that
    // performed the real rotation.
    if (sessionToken) {
      setSessionCookie(req, res, sessionToken);
    }

    // Reuse the existing CSRF token (sliding its maxAge) rather than minting a
    // new one. Refresh is not an identity change, and rotating here invalidated
    // every token embedded in an open page — the no-JS connect-consent form
    // 403'd whenever the SPA's background refresh fired in another tab, and two
    // tabs refreshing concurrently could 403 each other into a spurious logout
    // (defeating the session-token grace period above, which exists precisely
    // to tolerate that concurrency).
    //
    // Scoped to the session the rotation matched (both branches of
    // RotationResult carry it): in steady state the incoming token is already
    // bound to it and is reused verbatim; for a legacy browser this is the
    // upgrade point where the anon-scoped token is re-minted session-bound —
    // the same response whose rotated JWT first embeds the sid.
    ensureCsrfCookie(this.csrfService, req, res, sessionId);

    return {
      accessToken,
    };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Clear the cookies FIRST, before any check that can throw. Logging out must
    // always leave the browser clean: previously an already-expired or missing
    // session threw here and skipped the clears, which mattered little when the
    // csrf cookie died with the browser session — but it now carries a 7-day
    // maxAge, so it would outlive the session it belongs to and keep being
    // reused by ensureToken.
    //
    // CsrfGuard is what makes clearing-before-validating safe. Without it this
    // ordering hands any third-party page a forced-logout primitive: a
    // credential-less cross-site POST sends no cookies (lax/strict), so the
    // handler throws — but the clears have already run and the deletion
    // Set-Cookie headers ride out on the error response, signing the victim out
    // repeatably. The guard rejects before the handler body, while a real
    // browser holding a valid double-submit pair still reaches the clears even
    // when its session has expired.
    clearSessionCookie(req, res);
    clearCsrfCookie(req, res);

    const token = this.getSessionToken(req);
    const payload = this.validateSessionToken(token);
    const userId = payload.sub;
    const user = await this.userService.findById({ userId }, userId);

    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    await this.authService.invalidateSession(userId, token, this.authService.getSessionMetadata(req));
  }

  private getSessionToken(req: Request) {
    return req.cookies?.[config.auth.cookies.sessionTokenName];
  }

  private validateSessionToken(token: string | null | undefined): JwtPayload {
    if (token == null) {
      throw new BadRequestException('No token provided');
    }

    try {
      return this.authService.validateSessionToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

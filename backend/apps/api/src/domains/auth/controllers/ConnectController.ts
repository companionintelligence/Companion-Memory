import { randomBytes } from 'crypto';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';

import { ConnectRequestAuthGuard } from '../guards/ConnectRequestAuthGuard';
import { ConnectService, scopesForApp } from '../services/ConnectService';
import { CsrfService } from '../services/CsrfService';
import {
  renderConnectConsentPage,
  renderConnectErrorPage,
  renderConnectRedirectPage,
} from '../utils/connectConsentPage';

const SESSION_COOKIE = config.auth.cookies.sessionTokenName;
const CSRF_COOKIE = config.auth.cookies.csrfTokenName;

const approveSchema = z.object({
  app: z.string().min(1),
  state: z.string().min(1),
  return: z.string().url(),
  // CSRF token, submitted as a hidden form field (the consent page has no JS to
  // set a header) and checked against the csrf cookie — signed double-submit.
  csrf: z.string().min(1),
});

const exchangeSchema = z.object({
  code: z.string().min(1),
});

const revokeSchema = z.object({
  app: z.string().min(1),
});

const rotateSchema = z.object({
  app: z.string().min(1),
});

type ApproveDto = z.infer<typeof approveSchema>;
type ExchangeDto = z.infer<typeof exchangeSchema>;
type RevokeDto = z.infer<typeof revokeSchema>;
type RotateDto = z.infer<typeof rotateSchema>;

/**
 * App-connect endpoints. CI-Hub brokers connecting an agent app (OpenClaw /
 * Hermes / Import-Tools) to the user's Companion Memory:
 *
 *   GET  /api/connect          → consent (signing the user in first if needed)
 *   POST /api/connect/approve  → mint a scoped key, hand back a one-time code
 *   POST /api/connect/exchange → CI-Hub swaps the code for the raw key (S2S)
 *   POST /api/connect/revoke   → CI-Hub revokes the app's key (S2S)
 *   POST /api/connect/rotate   → CI-Hub rotates the app's key before expiry (S2S)
 *
 * The browser-facing routes run on this origin so the session cookie is in
 * scope; the raw key only ever leaves via the forward-auth-protected exchange.
 */
@Controller('connect')
export class ConnectController {
  constructor(
    private readonly connectService: ConnectService,
    private readonly csrfService: CsrfService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConnectController.name);
  }

  /**
   * Entry point. Validates the CI-Hub return URL, ensures the user is signed in
   * (bouncing through OIDC and back here if not), then renders the consent page.
   */
  @Get()
  async connect(
    @Query('app') app: string | undefined,
    @Query('state') state: string | undefined,
    @Query('return') returnUrl: string | undefined,
    @Query('app_name') appName: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!app || !state || !returnUrl) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .type('html')
        .send(renderConnectErrorPage('Missing required parameters.'));

      return;
    }

    // Open-redirect guard: only ever redirect back to an allowlisted CI-Hub origin.
    if (!this.connectService.isReturnUrlAllowed(returnUrl)) {
      this.logger.warn(`Rejected connect: return URL origin not allowlisted (app ${app})`);
      res
        .status(HttpStatus.BAD_REQUEST)
        .type('html')
        .send(renderConnectErrorPage('This connection request is not from a trusted source.'));

      return;
    }

    const session = await this.connectService.resolveSessionUser(req.cookies?.[SESSION_COOKIE]);

    if (!session) {
      // Sign in, then return to this exact URL (same-origin path passes the OIDC
      // controller's safeRelativePath guard) with the session cookie set. Carry
      // app_name through the bounce so the consent page can show the friendly
      // name rather than falling back to the raw URN.
      const selfParams = new URLSearchParams({ app, state, return: returnUrl });

      if (appName) {
        selfParams.set('app_name', appName);
      }

      const selfPath = `/api/connect?${selfParams.toString()}`;

      res.redirect(`/api/authenticate/oidc?redirect=${encodeURIComponent(selfPath)}`);

      return;
    }

    // The consent page's Allow POST is CSRF-protected (signed double-submit): the
    // same token is set as the csrf cookie AND injected into the form's hidden
    // field, and /approve checks they match. Mint it here — a signed-in user who
    // did NOT just bounce through OIDC has no csrf cookie (it is a sameSite=strict
    // cookie that OIDC/login set), so without this the POST would submit against
    // an absent cookie and 403.
    const csrfToken = this.csrfService.generateToken();
    res.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: req.secure,
      sameSite: 'strict',
      path: '/',
    });

    // Per-request nonce: the page's own inline <style> carries it, so an injected
    // inline <style> (which cannot guess the nonce) is refused by CSP.
    const cspNonce = randomBytes(16).toString('base64');

    res
      .type('html')
      // Lock the consent page to exactly what it uses. The page runs NO
      // JavaScript (the nginx gateway stamps `script-src 'self'` on every
      // response, so a nonce'd inline script could never satisfy the enforced
      // intersection anyway), hence no script-src — it falls back to
      // `default-src 'none'`, blocking all script. It needs: its own nonce'd
      // inline <style>, the inlined `data:` memory logo, and a same-origin form
      // POST to /api/connect/approve. `form-action 'self'` permits that POST (the
      // 302 it returns to CI-Hub is a redirect, not re-checked); the "Not now"
      // link is a top-level navigation, not restricted here. frame-ancestors /
      // X-Frame-Options keep the page un-framable.
      .header(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'nonce-${cspNonce}'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .header('X-Frame-Options', 'DENY')
      .send(
        renderConnectConsentPage({
          appUrn: app,
          appName,
          state,
          returnUrl,
          denyUrl: this.connectService.buildDenyUrl(returnUrl, state),
          csrfToken,
          // Same source of truth as the key mint, so consent matches the grant.
          scopes: scopesForApp(app),
          userEmail: session.email,
          nonce: cspNonce,
        }),
      );
  }

  /**
   * Consent approval — the target of the consent page's "Allow" form (no JS, so
   * a plain same-origin POST). Validates the return origin and the double-submit
   * CSRF token (hidden field vs cookie), re-checks the session, mints the scoped
   * key, and 302-redirects the browser back to CI-Hub carrying the one-time code.
   *
   * Failure modes all send the user back to CI-Hub with an `error` (rather than
   * rendering a dead-end JSON error) so they land back on the originating app's
   * interstitial: a lost session → `login_required`, a minting failure →
   * `server_error`. A bad return origin (can't safely redirect anywhere) and a
   * bad/absent CSRF token (validateToken throws 403) are the only hard failures.
   *
   * The hop back to CI-Hub is a rendered meta-refresh page, NOT `res.redirect`:
   * the nginx gateway's `form-action 'self'` would make Chrome refuse to follow
   * a 302 from this form POST to the cross-origin CI-Hub URL. See
   * {@link renderConnectRedirectPage}.
   */
  @Post('approve')
  async approve(
    @Body(new ValidationPipe(approveSchema)) body: ApproveDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.connectService.isReturnUrlAllowed(body.return)) {
      throw new BadRequestException('Return URL origin is not allowlisted');
    }

    // Signed double-submit: the hidden `csrf` field must match the csrf cookie.
    // Throws ForbiddenException (403) on mismatch/absence.
    this.csrfService.validateToken(req.cookies?.[CSRF_COOKIE], body.csrf);

    const sendToHub = (url: string) =>
      res.status(HttpStatus.OK).type('html').send(renderConnectRedirectPage(url));

    const session = await this.connectService.resolveSessionUser(req.cookies?.[SESSION_COOKIE]);

    if (!session) {
      sendToHub(this.connectService.buildDenyUrl(body.return, body.state, 'login_required'));

      return;
    }

    try {
      const { code } = await this.connectService.approve(session.userId, body.app);

      sendToHub(this.connectService.buildReturnUrl(body.return, code, body.state));
    } catch (err) {
      this.logger.error(`[Connect] approve failed for app ${body.app}`, err as Error);
      sendToHub(this.connectService.buildDenyUrl(body.return, body.state, 'server_error'));
    }
  }

  /**
   * Server-to-server code exchange. Authenticated by CI-Hub's signed, replay-
   * resistant request signature. Returns the raw scoped key exactly once.
   */
  @UseGuards(ConnectRequestAuthGuard)
  @Post('exchange')
  async exchange(@Body(new ValidationPipe(exchangeSchema)) body: ExchangeDto) {
    const result = await this.connectService.exchange(body.code);

    if (!result) {
      throw new BadRequestException('Invalid or expired connect code');
    }

    return result;
  }

  /**
   * Server-to-server revoke (agent uninstall, user disconnect, ci-memory reset).
   * Authenticated by CI-Hub's signed, replay-resistant request signature.
   */
  @UseGuards(ConnectRequestAuthGuard)
  @Post('revoke')
  async revoke(@Body(new ValidationPipe(revokeSchema)) body: RevokeDto) {
    const revoked = await this.connectService.revokeByApp(body.app);

    return { revoked };
  }

  /**
   * Server-to-server key rotation (refresh before expiry). Re-mints the app's
   * connect key (with freshly-derived per-app scopes) for the same user and
   * returns the new raw key. Authenticated by CI-Hub's signed, replay-resistant
   * request signature.
   */
  @UseGuards(ConnectRequestAuthGuard)
  @Post('rotate')
  async rotate(@Body(new ValidationPipe(rotateSchema)) body: RotateDto) {
    const result = await this.connectService.rotateByApp(body.app);

    if (!result) {
      throw new BadRequestException('No connected key to rotate for this app');
    }

    return result;
  }
}

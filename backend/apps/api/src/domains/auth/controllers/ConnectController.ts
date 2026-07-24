import { randomBytes } from 'crypto';

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { AuthService } from '../services/AuthService';
import { ConnectService, scopesForApp } from '../services/ConnectService';
import { CsrfService } from '../services/CsrfService';
import { ensureCsrfCookie } from '../utils/authCookies';
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
  // Optional on purpose: the schema constrains the *shape* (a string if
  // present), while a missing or empty token is a CSRF decision owned by
  // CsrfService. Requiring it here would 400 in the pipe before the handler,
  // dead-ending exactly the requests the self-heal redirect exists to rescue.
  csrf: z.string().optional(),
  // Friendly app name, round-tripped through the form so the CSRF self-heal
  // redirect can re-render the consent page with the same display name.
  app_name: z.string().optional(),
  // Present when this submission came from the one-shot re-render after a CSRF
  // failure; a second consecutive failure returns to CI-Hub with an error
  // instead of redirecting again, bounding the retry loop.
  csrf_retry: z.string().optional(),
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

/**
 * Narrow a query-string value to a single string.
 *
 * Express's query parser yields an ARRAY when a key is repeated
 * (`?app_name=a&app_name=b`), so a `@Query()` parameter typed `string` is a lie
 * an attacker can falsify with one extra query pair. Without this, `.trim()`
 * and the HTML-escaping helpers throw a TypeError and the consent page 500s.
 * Repeats are treated as absent rather than "first wins", so an injected
 * duplicate cannot shadow the value the Hub actually sent.
 */
function singleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build this controller's own consent URL. Used both for the OIDC sign-in bounce
 * (return here once a session exists) and for the CSRF self-heal hop, so the two
 * cannot drift in how they carry `app`/`state`/`return`/`app_name`.
 */
function buildConnectUrl(params: {
  app: string;
  state: string;
  returnUrl: string;
  appName?: string;
  csrfRetry?: boolean;
}): string {
  const query = new URLSearchParams({
    app: params.app,
    state: params.state,
    return: params.returnUrl,
  });

  if (params.appName) {
    query.set('app_name', params.appName);
  }

  if (params.csrfRetry) {
    query.set('csrf_retry', '1');
  }

  return `/api/connect?${query.toString()}`;
}

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
    private readonly authService: AuthService,
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
    @Query('app') appParam: unknown,
    @Query('state') stateParam: unknown,
    @Query('return') returnUrlParam: unknown,
    @Query('app_name') appNameParam: unknown,
    @Query('csrf_retry') csrfRetryParam: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Repeated query keys arrive as arrays, so narrow before anything treats
    // these as strings (see singleQueryValue).
    const app = singleQueryValue(appParam);
    const state = singleQueryValue(stateParam);
    const returnUrl = singleQueryValue(returnUrlParam);
    const appName = singleQueryValue(appNameParam);
    const csrfRetry = singleQueryValue(csrfRetryParam);

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

    // Resolved before the DB-touching session lookup below: it is a pure JWT
    // read, and keeping the cheap checks first preserves the request's
    // fail-fast ordering.
    const csrfScope = this.authService.resolveCsrfScope(req);

    const session = await this.connectService.resolveSessionUser(req.cookies?.[SESSION_COOKIE]);

    if (!session) {
      // Sign in, then return to this exact URL (same-origin path passes the OIDC
      // controller's safeRelativePath guard) with the session cookie set. Carry
      // app_name through the bounce so the consent page can show the friendly
      // name rather than falling back to the raw URN.
      //
      // csrf_retry is deliberately NOT carried: signing in runs
      // OidcController.finishLogin, which MINTS a fresh csrf cookie, so the page
      // rendered afterwards is a genuine first attempt with a token that matches
      // by construction. Forwarding a spent retry budget onto it would make its
      // first real mismatch dead-end on "your browser is blocking cookies" for a
      // browser whose cookies work fine.
      const selfPath = buildConnectUrl({ app, state, returnUrl, appName });

      res.redirect(`/api/authenticate/oidc?redirect=${encodeURIComponent(selfPath)}`);

      return;
    }

    // The consent page's Allow POST is CSRF-protected (signed double-submit): the
    // same token is set as the csrf cookie AND injected into the form's hidden
    // field, and /approve checks they match. REUSE the browser's existing valid
    // token (minting only when absent/invalid — e.g. a signed-in user who never
    // bounced through OIDC/login on this browser has no csrf cookie). Reuse is
    // what makes this page immune to the SPA's background session refresh: with
    // every mint site converged on one stable token, a refresh firing in another
    // tab while this page is open can no longer rotate the cookie out from under
    // the embedded hidden field (previously a guaranteed 403 once the ~5-minute
    // access token expired with a Memory tab open).
    const csrfToken = ensureCsrfCookie(this.csrfService, req, res, csrfScope);

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
          // Round-trips through the form so a second consecutive CSRF failure
          // (cookies blocked) renders a hard error instead of looping.
          csrfRetry: csrfRetry != null,
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
   * rendering a dead-end error page) so they land back on the originating app's
   * interstitial: a lost session → `login_required`, a minting failure →
   * `server_error`, an unrecoverable CSRF failure → `csrf_failed`. A bad/absent
   * CSRF token first self-heals: a 303 back to the consent GET re-renders the
   * form against the browser's current cookie, so one extra click recovers.
   * `csrf_retry` bounds that to a single hop, and the second failure returns to
   * CI-Hub rather than stranding the user on a page with no way back — the Hub's
   * interstitial is still waiting for this flow to resolve.
   * A bad return origin (can't safely redirect anywhere) is the only remaining
   * hard failure.
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

    const sendToHub = (url: string) =>
      res.status(HttpStatus.OK).type('html').send(renderConnectRedirectPage(url));

    // Signed double-submit: the hidden `csrf` field must match the csrf cookie,
    // and the token must be bound to the session submitting it. On
    // mismatch/absence, self-heal: bounce back to the consent GET, which
    // re-renders the form against the browser's CURRENT cookie (connect()
    // re-runs the return-URL allowlist and session checks on the way, so the
    // redirect adds no new trust). The scope resolve is a pure JWT read, kept
    // ahead of the DB-touching resolveSessionUser in the catch below.
    try {
      this.csrfService.validateToken(
        req.cookies?.[CSRF_COOKIE],
        body.csrf,
        this.authService.resolveCsrfScope(req),
      );
    } catch (err) {
      // Only CSRF rejections self-heal. Anything else is an unexpected fault and
      // must surface as itself rather than be mislabelled a CSRF problem.
      if (!(err instanceof ForbiddenException)) {
        throw err;
      }

      // The self-heal hop is a same-origin 303, which the gateway's
      // `form-action 'self'` permits. But connect() would bounce a signed-OUT
      // user onward to the cross-origin OIDC issuer, and Chrome enforces
      // form-action across the whole redirect chain of a form submission — that
      // hop would be silently refused, leaving a blank page. So when the session
      // is already gone, go straight back to CI-Hub via the meta-refresh page
      // (the same reason renderConnectRedirectPage exists) and let the Hub
      // restart the flow.
      const session = await this.connectService.resolveSessionUser(req.cookies?.[SESSION_COOKIE]);

      if (!session) {
        sendToHub(this.connectService.buildDenyUrl(body.return, body.state, 'login_required'));

        return;
      }

      if (body.csrf_retry) {
        // Second consecutive failure with a live session: re-rendering will not
        // help. Return to CI-Hub with an error so its interstitial resolves
        // instead of waiting forever on a callback that will never arrive.
        this.logger.warn(`[Connect] CSRF failed twice for app ${body.app}; returning to Hub`);
        sendToHub(this.connectService.buildDenyUrl(body.return, body.state, 'csrf_failed'));

        return;
      }

      res.redirect(
        HttpStatus.SEE_OTHER,
        buildConnectUrl({
          app: body.app,
          state: body.state,
          returnUrl: body.return,
          appName: body.app_name,
          csrfRetry: true,
        }),
      );

      return;
    }

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

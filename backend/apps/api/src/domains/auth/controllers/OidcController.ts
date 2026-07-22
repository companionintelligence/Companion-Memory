import { createHash, randomBytes } from 'crypto';

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

import { SYSTEM_USER } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { ensureCsrfCookie, setCsrfCookie, setSessionCookie } from '../utils/authCookies';
import {
  OIDC_ORIGIN_BOUNCE_PARAM,
  type OidcCallbackRequestOrigin,
  resolveOidcCallbackUrl,
  resolveOidcOriginBounce,
} from '../utils/oidcCallbackUrl';
import { renderSignupConfirmPage } from '../utils/signupConfirmPage';

const STATE_COOKIE = 'oidc_state';
const PKCE_COOKIE = 'oidc_pkce';
// Carries the post-login destination (e.g. a /shared/<token> deep link) across
// the full-page OIDC round-trip, which discards the SPA's in-memory router state.
const REDIRECT_COOKIE = 'oidc_redirect';
// Holds the signed signup-intent token between the callback (first-time sign-in,
// no account yet) and the "create account?" confirmation step.
const SIGNUP_INTENT_COOKIE = 'oidc_signup_intent';
const SIGNUP_INTENT_MAX_AGE = 10 * 60 * 1000;

/**
 * Body of the confirm-account form POST. Mirrors ConnectController's
 * `approveSchema`: the fields arrive from a no-JS form, so they must be
 * constrained to strings before reaching the CSRF comparison, which would
 * otherwise surface a non-string as a 500 rather than a clean rejection.
 */
const confirmAccountSchema = z.object({
  // Optional on purpose: the schema constrains the *shape* (a string if
  // present), while whether a token is missing or empty is a CSRF decision that
  // belongs to CsrfService. Requiring it here would make the pipe reject with a
  // 400 before the handler runs, dead-ending exactly the requests the self-heal
  // redirect below exists to rescue.
  csrf: z.string().optional(),
  // Present when this submission came from the one-shot re-render after a CSRF
  // failure; a second consecutive failure exits to /login instead of looping.
  csrf_retry: z.string().optional(),
});

type ConfirmAccountDto = z.infer<typeof confirmAccountSchema>;

/**
 * Validate a post-login redirect target — an open-redirect guard. Returns the
 * value only when it is a safe SAME-ORIGIN relative path: a single leading '/',
 * never '//' (protocol-relative), no backslashes or control characters that a
 * browser might normalise into an origin change, and no scheme. Anything else
 * yields null, so the caller falls back to the home page.
 */
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }

  if (!value.startsWith('/') || value.startsWith('//')) {
    return null;
  }

  // Reject backslash (0x5c) and control characters (incl. tab/newline) that a
  // browser might normalise into an origin change, e.g. "/" + backslash + host.
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x5c || code === 0x7f) {
      return null;
    }
  }

  return value;
}

// Allow self-signed certificates when the OIDC issuer is on localhost (dev only).
// Short keepAlive prevents stale connections to Wrangler's dev server from hanging.
const fetchDispatcher =
  process.env.NODE_ENV !== 'production' && config.auth.oidc.issuerUrl.includes('localhost')
    ? new Agent({
        connect: { rejectUnauthorized: false },
        keepAliveTimeout: 1_000,
        keepAliveMaxTimeout: 2_000,
      })
    : undefined;

/**
 * Generate a PKCE code_verifier and code_challenge (S256).
 */
function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge };
}

/**
 * Handles the "Sign in with CI-Portal" OIDC authorization code flow with PKCE.
 *
 * GET /authenticate/oidc          → Redirects the browser to Portal's authorize endpoint
 * GET /authenticate/oidc/callback → Exchanges the code for tokens, resolves the user, issues a session
 */
@Controller('authenticate/oidc')
export class OidcController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly csrfService: CsrfService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OidcController.name);
  }

  /**
   * Resolve the OIDC callback URL.
   *
   * Prefers the app's public base URL (CI-Hub injects it as APP_BASE_URL →
   * config.auth.oidc.publicBaseUrl) so the redirect_uri is the app's stable
   * public origin. Falls back to the inbound request's origin for local/dev
   * installs without a public base URL. Building it from the request host alone
   * breaks when the app is reached at its local *.localhost route, since the
   * resulting localhost callback is unreachable for CI-Portal.
   */
  private getCallbackUrl(req: Request) {
    return resolveOidcCallbackUrl(this.requestOrigin(req), config.auth.oidc.publicBaseUrl);
  }

  /** The origin the browser used to reach this app, honouring the reverse proxy. */
  private requestOrigin(req: Request): OidcCallbackRequestOrigin {
    return {
      forwardedProto: req.headers['x-forwarded-proto'],
      forwardedHost: req.headers['x-forwarded-host'],
      host: req.headers.host,
      secure: req.secure,
    };
  }

  /**
   * Initiate the OIDC flow by redirecting to CI-Portal's authorize endpoint.
   */
  @Get()
  @HttpCode(302)
  initiate(@Query('redirect') redirectParam: string | undefined, @Req() req: Request, @Res() res: Response) {
    const { issuerUrl, publicBaseUrl } = config.auth.oidc;

    if (!issuerUrl) {
      // Redirect to the login page with an error rather than dead-ending the
      // browser on a raw JSON 401 — the "Sign in with CI-Portal" button lands
      // here, so the user must end up somewhere they can recover from.
      this.logger.error('OIDC initiate blocked: OIDC_ISSUER_URL is not configured');

      return res.redirect('/login?error=oidc_not_configured');
    }

    // Remember a safe same-origin destination (e.g. a /shared/<token> deep link,
    // or the /api/connect consent page) so the callback can return there.
    const redirect = safeRelativePath(redirectParam);

    // The cookies below are set on the origin the browser used, but redirect_uri
    // is always the public base URL. If those differ, the callback lands on an
    // origin holding neither cookie and sign-in fails with `invalid_state`, so
    // move onto the public origin before minting any of them.
    const bounceUrl = resolveOidcOriginBounce(
      this.requestOrigin(req),
      publicBaseUrl,
      redirect ?? undefined,
      // Already bounced once — proceed here rather than risk a redirect loop.
      req.query[OIDC_ORIGIN_BOUNCE_PARAM] !== undefined,
    );

    if (bounceUrl) {
      return res.redirect(bounceUrl);
    }

    const callbackUrl = this.getCallbackUrl(req);
    const state = randomBytes(32).toString('hex');
    const { verifier, challenge } = generatePkce();

    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });

    res.cookie(PKCE_COOKIE, verifier, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });

    // Clear any stale value when there is no redirect, so a plain sign-in never
    // inherits a previous attempt's destination.
    if (redirect) {
      res.cookie(REDIRECT_COOKIE, redirect, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60 * 1000,
      });
    } else {
      res.clearCookie(REDIRECT_COOKIE, { path: '/' });
    }

    const authorizeUrl = new URL('/api/auth/oauth2/authorize', issuerUrl);

    authorizeUrl.searchParams.set('client_id', 'ci-server');
    authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid email profile');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(authorizeUrl.toString());
  }

  /**
   * Handle the callback from CI-Portal after the user authenticates.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect(`/login?error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return res.redirect('/login?error=missing_params');
    }

    // Validate state matches cookie
    const storedState = req.cookies?.[STATE_COOKIE];

    if (!storedState || storedState !== state) {
      return res.redirect('/login?error=invalid_state');
    }

    // Clear state cookie
    res.clearCookie(STATE_COOKIE, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
    });

    // Retrieve and clear PKCE verifier
    const codeVerifier = req.cookies?.[PKCE_COOKIE];

    res.clearCookie(PKCE_COOKIE, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
    });

    if (!codeVerifier) {
      return res.redirect('/login?error=missing_pkce');
    }

    const { issuerUrl } = config.auth.oidc;

    if (!issuerUrl) {
      return res.redirect('/login?error=oidc_not_configured');
    }

    const callbackUrl = this.getCallbackUrl(req);

    try {
      // Exchange code for tokens using PKCE (public client — no client_secret)
      const tokenResponse = await undiciFetch(new URL('/api/auth/oauth2/token', issuerUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: callbackUrl,
          client_id: 'ci-server',
          code_verifier: codeVerifier,
        }),
        dispatcher: fetchDispatcher,
        signal: AbortSignal.timeout(10_000),
      });

      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();

        this.logger.error(`OIDC token exchange failed: ${tokenResponse.status} ${errorBody}`);

        return res.redirect('/login?error=token_exchange_failed');
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        id_token?: string;
        token_type: string;
      };

      // Fetch user info from Portal
      const userInfoResponse = await undiciFetch(new URL('/api/auth/oauth2/userinfo', issuerUrl), {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json',
        },
        dispatcher: fetchDispatcher,
        signal: AbortSignal.timeout(10_000),
      });

      if (!userInfoResponse.ok) {
        this.logger.error(`OIDC userinfo failed: ${userInfoResponse.status}`);

        return res.redirect('/login?error=userinfo_failed');
      }

      const userInfo = (await userInfoResponse.json()) as {
        sub: string;
        email?: string;
        name?: string;
      };

      if (!userInfo.email) {
        return res.redirect('/login?error=no_email');
      }

      // Existing account for this Portal identity → sign in.
      const user = await this.userService.findByEmail(userInfo.email);

      if (user) {
        return this.finishLogin(req, res, user);
      }

      // No account yet. The signup-code gate still applies: when codes are
      // required, only users that already exist on this server may sign in.
      const isSignupCodeRequired = await this.featureService.isFeatureEnabled('require.signup.codes');

      if (isSignupCodeRequired) {
        this.logger.warn(`OIDC sign-in rejected for unknown user (signup codes required): ${userInfo.email}`);

        return res.redirect('/login?error=signup_code_required');
      }

      // First-time sign-in: do NOT create the account silently. Stash the
      // OIDC-verified identity in a signed, short-lived cookie and send the user
      // to the "create account?" confirmation (GET/POST confirm-account below).
      // REDIRECT_COOKIE is left intact so the confirm POST can honour the
      // original destination.
      res.cookie(
        SIGNUP_INTENT_COOKIE,
        this.authService.issueSignupIntentToken(userInfo.email, userInfo.name),
        {
          httpOnly: true,
          secure: req.secure,
          sameSite: 'lax',
          path: '/',
          maxAge: SIGNUP_INTENT_MAX_AGE,
        },
      );

      return res.redirect('/api/authenticate/oidc/confirm-account');
    } catch (err) {
      this.logger.error('OIDC callback error', err instanceof Error ? err.stack : String(err));

      return res.redirect('/login?error=oidc_failed');
    }
  }

  /**
   * First-time sign-in confirmation page. Reads the signed signup-intent cookie
   * (set by the callback) and asks the user to confirm creating an account. No
   * JavaScript (gateway CSP); "Create account" is a same-origin form POST.
   */
  @Get('confirm-account')
  async confirmAccountPage(
    // `unknown`, not `string`: a repeated query key (`?csrf_retry=1&csrf_retry=2`)
    // arrives as an array, so only a single string counts as the marker (mirrors
    // singleQueryValue in ConnectController). Treating an array as present would
    // let a crafted link prematurely burn the one-shot self-heal for the user.
    @Query('csrf_retry') csrfRetry: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    let identity: { email: string; name?: string };

    try {
      identity = this.authService.verifySignupIntentToken(req.cookies?.[SIGNUP_INTENT_COOKIE]);
    } catch {
      res.redirect('/login?error=signup_expired');

      return;
    }

    // CSRF cookie for the confirm POST (double-submit): same value is embedded
    // in the form's hidden field. Reuses a valid existing cookie so re-rendering
    // (or another tab minting) never invalidates an already-open copy of this
    // page; see utils/authCookies.ts.
    const csrfToken = ensureCsrfCookie(this.csrfService, req, res);

    const cspNonce = randomBytes(16).toString('base64');

    res
      .type('html')
      .header(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'nonce-${cspNonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .header('X-Frame-Options', 'DENY')
      .send(
        renderSignupConfirmPage({
          email: identity.email,
          csrfToken,
          cancelUrl: '/login',
          nonce: cspNonce,
          // Round-trips through the form so a second consecutive CSRF failure
          // (cookies blocked) lands on /login instead of looping.
          csrfRetry: typeof csrfRetry === 'string',
        }),
      );
  }

  /**
   * Create the account after the user confirms. Authorised by the signed
   * signup-intent cookie (proves the email came from a verified Portal sign-in)
   * and CSRF-guarded. Then signs the user in and returns to their destination.
   */
  // No @HttpCode: this handler injects a non-passthrough @Res(), so Nest's
  // response pipeline (and with it @HttpCode) never runs — the decorator that
  // used to sit here claimed 302 while `res.redirect` actually emits 303 for
  // the CSRF self-heal, which is the status that matters (303 is what forces a
  // POST to be re-issued as a GET).
  @Post('confirm-account')
  async confirmAccount(
    @Body(new ValidationPipe(confirmAccountSchema)) body: ConfirmAccountDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    let identity: { email: string; name?: string };

    try {
      identity = this.authService.verifySignupIntentToken(req.cookies?.[SIGNUP_INTENT_COOKIE]);
    } catch {
      // 303, not the default 302: this exits a POST, and only 303 guarantees the
      // browser re-issues it as a GET rather than re-POSTing to /login.
      res.redirect(HttpStatus.SEE_OTHER, '/login?error=signup_expired');

      return;
    }

    // Signed double-submit CSRF: the hidden `csrf` field must match the csrf
    // cookie. On failure, self-heal instead of dead-ending on a raw 403: a 303
    // back to the GET re-renders the page against the browser's current cookie
    // (the signup-intent cookie is still present), so one extra click recovers.
    // A second consecutive failure means cookies are blocked — land on /login.
    try {
      this.csrfService.validateToken(req.cookies?.[config.auth.cookies.csrfTokenName], body.csrf);
    } catch (err) {
      // Only CSRF rejections self-heal; anything else must surface as itself.
      if (!(err instanceof ForbiddenException)) {
        throw err;
      }

      res.redirect(
        HttpStatus.SEE_OTHER,
        body.csrf_retry ? '/login?error=csrf' : '/api/authenticate/oidc/confirm-account?csrf_retry=1',
      );

      return;
    }

    // Create only if it doesn't already exist (guards a double-submit / a
    // concurrent tab that already confirmed).
    const user =
      (await this.userService.findByEmail(identity.email)) ??
      (await this.userService.create(
        { userId: SYSTEM_USER },
        {
          name: identity.name || identity.email.split('@')[0],
          email: identity.email,
          // Random password — the account authenticates via OIDC.
          password: randomBytes(32).toString('hex'),
        },
      ));

    res.clearCookie(SIGNUP_INTENT_COOKIE, { path: '/' });

    await this.finishLogin(req, res, user);
  }

  /**
   * Issue the session + CSRF cookies (same as local login) and redirect to the
   * stored post-login destination. Shared by the existing-user callback path and
   * the confirm-account POST.
   */
  private async finishLogin(req: Request, res: Response, user: { id: string }): Promise<void> {
    const sessionToken = await this.authService.issueSessionToken(
      user.id,
      this.authService.getSessionMetadata(req),
    );

    setSessionCookie(req, res, sessionToken);

    // Identity boundary: mint a fresh CSRF token (the only rotation points are
    // login, signup, and this OIDC sign-in — see utils/authCookies.ts).
    setCsrfCookie(req, res, this.csrfService.generateToken());

    // Return to the deep link the user was headed for before being bounced to
    // login (re-validated on read), then clear the one-shot cookie.
    const storedRedirect = safeRelativePath(req.cookies?.[REDIRECT_COOKIE]);
    res.clearCookie(REDIRECT_COOKIE, { path: '/' });

    res.redirect(storedRedirect ?? '/');
  }
}

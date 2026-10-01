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
  // Still required: the native one-time-code exchange rejects a bad code with a 401.
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { EntityManager } from 'typeorm';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

import { SYSTEM_USER } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { type CreateUserDto, UserService } from '@ci/domains/user';

import { AuthService, type SignupIntent } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { FederatedIdentityService } from '../services/FederatedIdentityService';
import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';
import { OidcNativeCodeService } from '../services/OidcNativeCodeService';
import { SignupCodeService } from '../services/SignupCodeService';
import { ensureCsrfCookie, setCsrfCookie, setSessionCookie } from '../utils/authCookies';
import {
  OIDC_ORIGIN_BOUNCE_PARAM,
  type OidcCallbackRequestOrigin,
  resolveOidcCallbackUrl,
  resolveOidcOriginBounce,
} from '../utils/oidcCallbackUrl';
import { renderSignupConfirmPage } from '../utils/signupConfirmPage';

/**
 * How a Portal identity maps onto this appliance's accounts. `refused` carries
 * the `?error=` key the login page shows; it is deliberately distinct from
 * `unknown` (no account for the address at all), which is the only outcome
 * that may continue into the first-time sign-in flow.
 */
type PortalUserResolution =
  | { kind: 'user'; user: { id: string } }
  | { kind: 'refused'; reason: 'account_linked_elsewhere' | 'email_unverified' }
  | { kind: 'unknown' };

const STATE_COOKIE = 'oidc_state';
const PKCE_COOKIE = 'oidc_pkce';
// Carries the "this flow was launched by the native app" signal through the IdP round
// trip. Set alongside state/pkce on initiate and read on callback; both cookies live on
// CI-Server's own domain in the SAME system browser, so they survive the redirect.
const CLIENT_COOKIE = 'oidc_client';
const NATIVE_CLIENT = 'native';

const nativeExchangeSchema = z.object({
  code: z.string().min(1),
});

// Carries the post-login destination (e.g. a /shared/<token> deep link) across
// the full-page OIDC round-trip, which discards the SPA's in-memory router state.
const REDIRECT_COOKIE = 'oidc_redirect';
// Holds the signed signup-intent token between the callback (first-time sign-in,
// no account yet) and the "create account?" confirmation step.
const SIGNUP_INTENT_COOKIE = 'oidc_signup_intent';
/** An invite code offered at initiate, held until the callback can check it. */
const SIGNUP_CODE_COOKIE = 'oidc_signup_code';
const SIGNUP_INTENT_MAX_AGE = 10 * 60 * 1000;

/**
 * Rolls back an account being created for an invitation that another sign-in redeemed first.
 * Thrown inside that account's transaction and caught by `OidcController.createOidcUser`; it never
 * reaches the caller.
 */
class InvitationRedeemedElsewhere extends Error {
  constructor() {
    super('The invitation was redeemed by another sign-in first');
  }
}

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
    private readonly oidcNativeCodeService: OidcNativeCodeService,
    private readonly signupCodeService: SignupCodeService,
    private readonly federatedIdentityService: FederatedIdentityService,
    private readonly hubBridge: HubForwardAuthBridgeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OidcController.name);
  }

  /** Build the native deep-link return URL (`<scheme>://oidc/callback?...`). */
  private nativeRedirectUrl(params: Record<string, string>): string {
    const scheme = config.auth.oidc.nativeRedirectScheme || 'companion';
    const search = new URLSearchParams(params).toString();

    return `${scheme}://oidc/callback${search ? `?${search}` : ''}`;
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
  initiate(
    @Query('client') client: string | undefined,
    @Query('redirect') redirectParam: string | undefined,
    @Query('signup_code') signupCodeParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
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
      client,
      signupCodeParam,
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

    // Remember whether the native app launched this flow, so the callback returns the
    // result via the custom-scheme deep link instead of a browser session cookie.
    if (client === NATIVE_CLIENT) {
      res.cookie(CLIENT_COOKIE, NATIVE_CLIENT, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60 * 1000,
      });
    }

    // An invitation, carried across the round-trip.
    //
    // The callback is where an unknown identity gets refused, but by then the
    // request is a redirect back from the identity provider and can no longer
    // carry anything the user supplied — so a code offered at initiate has to
    // be parked here to still exist at the end. Same lifetime as the state and
    // PKCE cookies, and read exactly once.
    if (signupCodeParam) {
      res.cookie(SIGNUP_CODE_COOKIE, signupCodeParam, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60 * 1000,
      });
    } else {
      res.clearCookie(SIGNUP_CODE_COOKIE, { path: '/' });
    }

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
    // Whether the native app launched this flow (set on `initiate`). When native, every
    // exit — success or failure — returns via the custom-scheme deep link rather than a
    // browser redirect, so the system browser can hand control back to the app.
    const isNative = req.cookies?.[CLIENT_COOKIE] === NATIVE_CLIENT;

    res.clearCookie(CLIENT_COOKIE, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
    });

    // Route a failure to the native deep link (`?error=...`) or the web login page.
    const failRedirect = (reason: string) =>
      isNative
        ? res.redirect(this.nativeRedirectUrl({ error: reason }))
        : res.redirect(`/login?error=${encodeURIComponent(reason)}`);

    if (error) {
      return failRedirect(error);
    }

    if (!code || !state) {
      return failRedirect('missing_params');
    }

    // Validate state matches cookie
    const storedState = req.cookies?.[STATE_COOKIE];

    if (!storedState || storedState !== state) {
      return failRedirect('invalid_state');
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
      return failRedirect('missing_pkce');
    }

    const { issuerUrl } = config.auth.oidc;

    if (!issuerUrl) {
      return failRedirect('oidc_not_configured');
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

        return failRedirect('token_exchange_failed');
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

        return failRedirect('userinfo_failed');
      }

      const userInfo = (await userInfoResponse.json()) as {
        sub: string;
        iss?: string;
        email?: string;
        name?: string;
        email_verified?: boolean;
      };

      if (!userInfo.email) {
        return failRedirect('no_email');
      }

      const issuer = this.resolveOidcIssuer(userInfo, tokens.id_token);
      // (iss, sub) first; email is only a one-time link for unfederated rows.
      const resolution = await this.resolvePortalUser({
        subject: userInfo.sub,
        issuer,
        email: userInfo.email,
        emailVerified: userInfo.email_verified === true,
      });

      // An address that names an existing account this identity may not have:
      // say why and stop, rather than falling into the first-time flow, whose
      // confirm step would otherwise be handed that same address.
      if (resolution.kind === 'refused') {
        this.logger.warn(`OIDC sign-in refused for ${userInfo.email}: ${resolution.reason}`);

        return failRedirect(resolution.reason);
      }

      if (resolution.kind === 'user') {
        const { user } = resolution;

        // Native: return the credential via the deep link — no browser session cookie
        // can reach the app's cross-origin webview. Mint a short-lived, single-use code
        // and deep-link it back; the app exchanges it for a JWT at /oidc/native/exchange.
        if (isNative) {
          const oneTimeCode = this.oidcNativeCodeService.issue(user.id);

          return res.redirect(this.nativeRedirectUrl({ code: oneTimeCode }));
        }

        return this.finishLogin(req, res, user);
      }

      // No account yet. An appliance nobody has claimed is the one case where
      // that is expected rather than suspicious: a freshly installed box has an
      // empty user table, an empty signup-code table, and no way to mint a code,
      // so every gate below would otherwise leave the owner locked out of the
      // machine they just installed. The first account is therefore always
      // allowed; from the second onwards the gates below apply as before.
      //
      // `unclaimed` only sorts this request onto a path and refuses early. It is
      // never what creates an account: where it is the ONLY thing letting this
      // person in, the account is created through `claimApplianceFor`, which
      // decides "still unclaimed?" atomically with the insert. Another sign-in
      // can claim the appliance between this line and that one.
      const unclaimed = await this.userService.hasNoUsers();

      // The signup-code gate still applies: when codes are required, only users
      // that already exist on this server may sign in — or someone the owner
      // invited, whose code rode along in a cookie from initiate.
      //
      // Without that second path the gate is unsatisfiable rather than strict:
      // an OIDC redirect cannot carry a code, so before this every unknown
      // identity was refused outright and a claimed appliance could never admit
      // a second person at all.
      const cookieCode: unknown = req.cookies?.[SIGNUP_CODE_COOKIE];
      const offeredCode = typeof cookieCode === 'string' && cookieCode.length > 0 ? cookieCode : null;
      // Enough to refuse on, never to admit on: every sign-in presenting the
      // same code sees it unused here until one of them redeems it.
      const invitedByCode =
        offeredCode != null && (await this.signupCodeService.findOne(offeredCode)) != null;
      // Signed into this Hub (verified forward-auth) is an invitation: the
      // person already passed the Hub org-member gate.
      const invitedByHub = Boolean(this.hubBridge.verifyUsername(req));
      const invited = invitedByCode || invitedByHub;

      res.clearCookie(SIGNUP_CODE_COOKIE, { path: '/' });

      const signupCodesRequired = await this.featureService.isFeatureEnabled('require.signup.codes');
      // Whether this person needs an invitation they do not hold. Waived only
      // for the first account; anyone else is refused here.
      const codeRequired = !invited && signupCodesRequired;

      if (codeRequired && !unclaimed) {
        this.logger.warn(`OIDC sign-in rejected for unknown user (signup codes required): ${userInfo.email}`);

        return isNative
          ? res.redirect(this.nativeRedirectUrl({ error: 'signup_code_required' }))
          : res.redirect('/login?error=signup_code_required');
      }

      // Where the admission rests on the code — no Hub vouches for this
      // person, and it is a native sign-in or codes are required, the two
      // cases that turn away an unknown identity without one — it is redeemed
      // before anyone is admitted on it, and atomically, so that it admits one
      // person however many present it at once. Where the account is created
      // in this request, that happens in the same transaction; otherwise it
      // happens before the confirmation page (see below). A code nothing rests
      // on is left unspent, for whoever it was meant for.
      const invitation =
        invitedByCode && !invitedByHub && (isNative || signupCodesRequired) ? offeredCode : null;

      // Native first-time sign-in can't run the web "create account?" confirmation
      // (it lives outside the deep-link flow), so surface it as an error the app can
      // handle rather than stranding the user on a web page.
      //
      // Except where the question has already been answered. On an unclaimed
      // appliance that error is a dead end: the desktop app signs in as a native
      // client, so this branch was the last door out of a box with no accounts
      // on it — and claiming an empty appliance is exactly what the confirmation
      // would ask about. An invitation answers it too: the owner chose to issue
      // it and this person chose to present it, which is the whole of what the
      // confirmation asks. Refusing here anyway — as this did — meant the code
      // was burned and the person was still turned away, so every attempt an
      // invited person made from the desktop cost the owner an invitation and
      // admitted nobody.
      if (isNative && !unclaimed && !invited) {
        return res.redirect(this.nativeRedirectUrl({ error: 'signup_required' }));
      }

      if (isNative) {
        // An invitation admits whoever holds it. Without one, the only way in is
        // to be the appliance's first account.
        let created: { id: string } | null;

        if (invited) {
          created = await this.createOidcUser(userInfo.email, userInfo.name, invitation);

          if (created == null) {
            // Another sign-in redeemed the invitation after it was checked
            // above. Refused as it would be with a code that was already used.
            this.logger.warn(
              `OIDC sign-in refused for ${userInfo.email}: its invitation was redeemed by another sign-in first`,
            );

            return res.redirect(
              this.nativeRedirectUrl({
                error: signupCodesRequired ? 'signup_code_required' : 'signup_required',
              }),
            );
          }

          await this.bindIfPossible(created.id, issuer, userInfo.sub, userInfo.email);
        } else {
          created = await this.claimApplianceFor(
            { issuer, subject: userInfo.sub, email: userInfo.email },
            this.oidcAccount(userInfo.email, userInfo.name),
          );
        }

        if (!created) {
          // Another sign-in claimed the appliance after `unclaimed` was read.
          // Refused exactly as it would have been had it arrived a moment later.
          this.logger.warn(`OIDC sign-in refused for ${userInfo.email}: the appliance was claimed first`);

          return res.redirect(
            this.nativeRedirectUrl({ error: codeRequired ? 'signup_code_required' : 'signup_required' }),
          );
        }

        this.logger.log(
          invited
            ? `Invited OIDC sign-in created Memory account for ${userInfo.email}`
            : `Unclaimed appliance claimed by first OIDC sign-in: ${userInfo.email}`,
        );

        return res.redirect(this.nativeRedirectUrl({ code: this.oidcNativeCodeService.issue(created.id) }));
      }

      // Hub already admitted this person as an org member. Skip the Memory
      // signup-code / confirm-account gates and give them an empty onboarding.
      if (invitedByHub) {
        const created = await this.createOidcUser(userInfo.email, userInfo.name);
        await this.bindIfPossible(created.id, issuer, userInfo.sub, userInfo.email);
        this.logger.log(`Hub-invited Memory account created for ${userInfo.email}`);

        return this.finishLogin(req, res, created);
      }

      // First-time web sign-in: do NOT create the account silently. Stash the
      // OIDC-verified identity in a signed, short-lived cookie and send the user
      // to the "create account?" confirmation (GET/POST confirm-account below).
      // REDIRECT_COOKIE is left intact so the confirm POST can honour the
      // original destination.
      //
      // Where the code was waived only because the appliance is empty, the
      // intent says so: the confirm step may run minutes from now, and must
      // create the account only if it is still the first.
      //
      // An invitation is redeemed here, before that page, rather than by the
      // step that creates the account: reaching the page is then a promise the
      // confirm step keeps, not a race with whoever else holds the code for the
      // intent's lifetime. The price is that declining the confirmation, or
      // letting it expire, spends the invitation too.
      if (invitation != null && !(await this.signupCodeService.consume(invitation))) {
        this.logger.warn(
          `OIDC sign-in refused for ${userInfo.email}: its invitation was redeemed by another sign-in first`,
        );

        return res.redirect('/login?error=signup_code_required');
      }

      res.cookie(
        SIGNUP_INTENT_COOKIE,
        this.authService.issueSignupIntentToken(
          userInfo.email,
          userInfo.name,
          { issuer, subject: userInfo.sub },
          { firstAccountOnly: codeRequired },
        ),
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

      return failRedirect('oidc_failed');
    }
  }

  /**
   * Native-only: exchange the short-lived one-time code delivered by the
   * `<scheme>://oidc/callback?code=...` deep link for a real access token (JWT). The app
   * then trades that JWT for a durable API key — the same credential path as password
   * login. The code is single-use and expires after ~2 minutes; redeeming it here
   * invalidates it, so it is replay-safe. Unauthenticated by design: the one-time code
   * IS the bearer of proof, and it never grants access beyond a single JWT issuance.
   */
  @Post('native/exchange')
  @HttpCode(200)
  nativeExchange(@Body(new ValidationPipe(nativeExchangeSchema)) input: { code: string }) {
    const userId = this.oidcNativeCodeService.redeem(input.code);

    if (!userId) {
      // Generic message — do not distinguish "expired" from "unknown" to a caller.
      this.logger.warn('OIDC native code exchange rejected (invalid or expired code)');

      throw new UnauthorizedException('Invalid or expired code');
    }

    const accessToken = this.authService.issueAccessToken(userId);

    return { accessToken };
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
    let identity: SignupIntent;

    try {
      identity = this.authService.verifySignupIntentToken(req.cookies?.[SIGNUP_INTENT_COOKIE]);
    } catch {
      res.redirect('/login?error=signup_expired');

      return;
    }

    // CSRF cookie for the confirm POST (double-submit): same value is embedded
    // in the form's hidden field. Reuses a valid existing cookie (of the same
    // scope) so re-rendering (or another tab minting) never invalidates an
    // already-open copy of this page; see utils/authCookies.ts. The scope is
    // usually anon here — first-time sign-in has no session yet — but a browser
    // already holding a session keeps its bound token.
    const csrfToken = ensureCsrfCookie(this.csrfService, req, res, this.authService.resolveCsrfScope(req));

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
    let identity: SignupIntent;

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
      this.csrfService.validateToken(
        req.cookies?.[config.auth.cookies.csrfTokenName],
        body.csrf,
        this.authService.resolveCsrfScope(req),
      );
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
    const existing = await this.userService.findByEmail(identity.email);
    let user: { id: string };

    if (existing) {
      // An account for this address already exists. The only way that is
      // legitimate here is a concurrent tab that confirmed first — in which
      // case that tab also bound the account to this very (issuer, subject).
      // Any other existing account (a password account, or one bound to a
      // different Portal identity) must not be handed to whoever holds a
      // Portal login for the same address; the callback already refused those
      // and this step must not undo it.
      const boundUserId =
        identity.issuer && identity.subject
          ? await this.federatedIdentityService.findUserId(identity.issuer, identity.subject)
          : null;

      if (boundUserId !== existing.id) {
        this.logger.warn(
          `confirm-account refused for ${identity.email}: an account for this address already exists`,
        );
        res.clearCookie(SIGNUP_INTENT_COOKIE, { path: '/' });
        res.redirect(HttpStatus.SEE_OTHER, '/login?error=account_exists');

        return;
      }

      user = existing;
    } else {
      const account = {
        name: identity.name || identity.email.split('@')[0],
        email: identity.email,
        // Random password — the account authenticates via OIDC.
        password: randomBytes(32).toString('hex'),
        passwordChosenByUser: false,
      };

      if (identity.firstAccountOnly) {
        // The callback let this person past the signup-code gate only because
        // the appliance had no accounts, up to the intent's lifetime ago. Still
        // true, or no account: decided now, atomically with creating it.
        const claimed = await this.claimApplianceFor(identity, account);

        if (claimed == null) {
          this.logger.warn(
            `confirm-account refused for ${identity.email}: the appliance was claimed after this sign-in began, and signup codes are required`,
          );
          res.clearCookie(SIGNUP_INTENT_COOKIE, { path: '/' });
          res.redirect(HttpStatus.SEE_OTHER, '/login?error=signup_code_required');

          return;
        }

        user = claimed;
      } else {
        user = await this.userService.create({ userId: SYSTEM_USER }, account);

        // Bind the new account to the Portal identity that asked for it, so the
        // bearer path resolves it by (iss, sub) from the first API call on.
        if (identity.issuer && identity.subject) {
          await this.bindIfPossible(user.id, identity.issuer, identity.subject, identity.email);
        }
      }
    }

    res.clearCookie(SIGNUP_INTENT_COOKIE, { path: '/' });

    await this.finishLogin(req, res, user);
  }

  private resolveOidcIssuer(userInfo: { iss?: string }, idToken?: string): string {
    if (typeof userInfo.iss === 'string' && userInfo.iss.length > 0) {
      return userInfo.iss;
    }

    if (idToken) {
      try {
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as {
          iss?: string;
        };
        if (typeof payload.iss === 'string' && payload.iss.length > 0) {
          return payload.iss;
        }
      } catch {
        // Fall through to configured issuer.
      }
    }

    return config.auth.portal.issuer || config.auth.oidc.issuerUrl;
  }

  /**
   * Resolve a Portal person to a Memory user. `(issuer, subject)` wins;
   * verified email is only a one-time link for accounts that pre-date the
   * binding table and are not already federated.
   */
  private async resolvePortalUser(identity: {
    subject?: string;
    issuer: string;
    email: string;
    emailVerified: boolean;
  }): Promise<PortalUserResolution> {
    if (identity.subject && identity.issuer) {
      const boundUserId = await this.federatedIdentityService.findUserId(identity.issuer, identity.subject);
      if (boundUserId) {
        const bound = await this.userService.findById({ userId: SYSTEM_USER }, boundUserId);

        return bound ? { kind: 'user', user: bound } : { kind: 'unknown' };
      }
    }

    const existing = await this.userService.findByEmail(identity.email);
    if (!existing) {
      return { kind: 'unknown' };
    }

    // The address names an existing account. Email is not an identity — it is
    // re-assignable and shared across issuers — so it links an account exactly
    // once, only when the issuer vouches for it, and never one that is already
    // somebody's. Both refusals are terminal for this sign-in: the caller must
    // not fall through to the first-time flow with the same address in hand.
    const alreadyFederated = await this.federatedIdentityService.listForUser(existing.id);
    if (alreadyFederated.length > 0) {
      this.logger.warn(
        `refusing email link for ${identity.issuer}#${identity.subject ?? '?'}: user already bound to another identity`,
      );

      return { kind: 'refused', reason: 'account_linked_elsewhere' };
    }

    if (!identity.emailVerified) {
      this.logger.warn(
        `refusing email link for ${identity.issuer}#${identity.subject ?? '?'}: issuer has not verified the address`,
      );

      return { kind: 'refused', reason: 'email_unverified' };
    }

    await this.bindIfPossible(existing.id, identity.issuer, identity.subject, identity.email, 'email_link');

    return { kind: 'user', user: existing };
  }

  /**
   * The account a native or Hub-admitted OIDC sign-in creates.
   *
   * @param invitation the signup code admitting this person, if one is. It is redeemed in the
   *   transaction that creates the account, so of two sign-ins presenting it only the one that
   *   redeems it gets an account — and a sign-in whose account cannot be created leaves it unspent.
   * @returns the new account; `null`, with nothing created, when another sign-in redeemed
   *   `invitation` first.
   */
  private createOidcUser(email: string, name?: string): Promise<{ id: string; email: string }>;

  private createOidcUser(
    email: string,
    name: string | undefined,
    invitation: string | null,
  ): Promise<{ id: string; email: string } | null>;

  private async createOidcUser(
    email: string,
    name?: string,
    invitation: string | null = null,
  ): Promise<{ id: string; email: string } | null> {
    try {
      return await this.userService.create(
        { userId: SYSTEM_USER },
        this.oidcAccount(email, name),
        invitation == null
          ? undefined
          : async (manager) => {
              if (!(await this.signupCodeService.consume(invitation, manager))) {
                throw new InvitationRedeemedElsewhere();
              }
            },
      );
    } catch (err) {
      if (err instanceof InvitationRedeemedElsewhere) {
        return null;
      }

      throw err;
    }
  }

  /** The account a native or Hub-invited OIDC sign-in creates. */
  private oidcAccount(email: string, name?: string): CreateUserDto {
    return {
      name: name || email.split('@')[0],
      email,
      password: randomBytes(32).toString('hex'),
      // Nobody has seen this password. Stamped as chosen, the account is asked
      // for it before every email or password change.
      passwordChosenByUser: false,
    };
  }

  /**
   * Create `account` as the appliance's FIRST account, bound to `identity` in the same transaction —
   * or, when the appliance already has an account, create nothing.
   *
   * For a sign-in that holds no invitation, being first is the whole of what admits it, so it is
   * decided as the account is created (`UserService.createFirstAccount`) rather than trusted from an
   * earlier look: two first sign-ins racing on an empty appliance used to both get in.
   *
   * @returns the new account; otherwise the account this same identity already claimed the
   *   appliance with — a second tab, or a second flow, that won the race and committed its binding
   *   with it; otherwise `null`, because the owner is somebody else.
   */
  private async claimApplianceFor(
    identity: { issuer?: string; subject?: string; email: string },
    account: CreateUserDto,
  ): Promise<{ id: string } | null> {
    const { issuer, subject, email } = identity;

    const created = await this.userService.createFirstAccount(
      { userId: SYSTEM_USER },
      account,
      (manager, user) => this.bindIfPossible(user.id, issuer, subject, email, 'sub', manager),
    );

    if (created) {
      return created;
    }

    const boundUserId =
      issuer && subject ? await this.federatedIdentityService.findUserId(issuer, subject) : null;

    return boundUserId ? this.userService.findById({ userId: SYSTEM_USER }, boundUserId) : null;
  }

  private async bindIfPossible(
    userId: string,
    issuer: string | undefined,
    subject: string | undefined,
    email: string,
    bindMethod: 'sub' | 'email_link' = 'sub',
    manager?: EntityManager,
  ): Promise<void> {
    if (!subject || !issuer) {
      return;
    }

    await this.federatedIdentityService.bind(
      {
        userId,
        issuer,
        subject,
        email,
        bindMethod,
      },
      manager,
    );
  }

  /**
   * Issue the session + CSRF cookies (same as local login) and redirect to the
   * stored post-login destination. Shared by the existing-user callback path and
   * the confirm-account POST.
   */
  private async finishLogin(req: Request, res: Response, user: { id: string }): Promise<void> {
    const { sessionToken, sessionId } = await this.authService.issueSessionToken(
      user.id,
      this.authService.getSessionMetadata(req),
    );

    setSessionCookie(req, res, sessionToken);

    // Identity boundary: mint a fresh CSRF token bound to the new session (the
    // only rotation points are login, signup, and this OIDC sign-in — see
    // utils/authCookies.ts).
    setCsrfCookie(req, res, this.csrfService.generateToken(sessionId));

    // Return to the deep link the user was headed for before being bounced to
    // login (re-validated on read), then clear the one-shot cookie.
    const storedRedirect = safeRelativePath(req.cookies?.[REDIRECT_COOKIE]);
    res.clearCookie(REDIRECT_COOKIE, { path: '/' });

    res.redirect(storedRedirect ?? '/');
  }
}

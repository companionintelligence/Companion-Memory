import type { Request, Response } from 'express';
import parseDuration from 'parse-duration';

import config from '@ci/configuration';

import type { CsrfService } from '../services/CsrfService';

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const SESSION_COOKIE_NAME = config.auth.cookies.sessionTokenName;

/**
 * Lifetime shared by the session and csrf cookies, so the pair lives and dies
 * together. Previously the csrf cookie was session-lived while sessionToken
 * persisted for the refresh-token lifetime — after a browser restart the
 * mount-time /authenticate/refresh failed CSRF ("Missing CSRF token") despite a
 * perfectly valid session, forcing a needless re-login.
 *
 * Fail fast on an unparseable duration rather than defaulting to 0: Express
 * treats `maxAge: 0` as an immediate expiry, which would silently delete both
 * auth cookies on every response and lock every user out of the app.
 */
const parsedCookieMaxAge = parseDuration(config.auth.jwt.refreshTokenExpiration);

if (!parsedCookieMaxAge || parsedCookieMaxAge <= 0) {
  throw new Error(
    `auth.jwt.refreshTokenExpiration is not a valid duration: ${JSON.stringify(config.auth.jwt.refreshTokenExpiration)}`,
  );
}

const AUTH_COOKIE_MAX_AGE = parsedCookieMaxAge;

/**
 * Session cookie attributes. `httpOnly` keeps it out of reach of scripts;
 * `sameSite: 'lax'` (not strict) is required so the cookie survives the
 * top-level redirect back from the OIDC provider.
 */
export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Single source of truth for the csrf cookie's attributes. `httpOnly: false`
 * is required by the double-submit pattern (the SPA reads the cookie to set
 * the X-CSRF-Token header); `secure` mirrors the actual connection so plain-
 * HTTP Tailscale deployments keep working (see docs/api/auth-and-conventions.md).
 */
export function setCsrfCookie(req: Request, res: Response, token: string): void {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: req.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE,
  });
}

export function clearCsrfCookie(req: Request, res: Response): void {
  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    secure: req.secure,
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Reuse the browser's existing csrf token when its signature is valid, minting
 * one only when it is absent or invalid. Always re-sets the cookie so the
 * maxAge slides alongside the session. Returns the token in effect, for
 * embedding in server-rendered forms.
 *
 * Note: two concurrent requests that both find NO cookie will each mint a
 * different token, and the later Set-Cookie wins — inherent to a stateless
 * double-submit scheme. The client's one-shot 403 retry (useAuth) and the
 * consent page's self-heal redirect both recover from that, and it cannot
 * happen once any valid cookie exists, which is the steady state.
 */
export function ensureCsrfCookie(csrfService: CsrfService, req: Request, res: Response): string {
  const token = csrfService.ensureToken(req.cookies?.[CSRF_COOKIE_NAME]);

  setCsrfCookie(req, res, token);

  return token;
}

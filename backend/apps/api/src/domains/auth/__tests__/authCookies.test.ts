import type { Request, Response } from 'express';

import { clearCsrfCookie, clearSessionCookie, setCsrfCookie, setSessionCookie } from '../utils/authCookies';

/**
 * The `secure` flag on both auth cookies mirrors `req.secure`, and nothing else
 * pins that. It is the whole point of the gateway forwarding the client's
 * `X-Forwarded-Proto` (commit ca1d33e4): on an HTTPS deployment the 7-day
 * `sessionToken` and `csrfToken` MUST carry `Secure` (CWE-614), while a plain-
 * HTTP Tailscale/LAN hit must still receive a non-secure cookie rather than have
 * the browser drop it. A revert of the nginx map or an edit to these helpers
 * would silently reintroduce the vulnerability without this test.
 */
describe('authCookies', () => {
  const req = (secure: boolean) => ({ secure, cookies: {} }) as unknown as Request;

  function mockRes() {
    const cookie = jest.fn();
    const clearCookie = jest.fn();

    return { res: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
  }

  describe('the Secure flag mirrors req.secure', () => {
    it.each([
      ['session', setSessionCookie],
      ['csrf', setCsrfCookie],
    ] as const)('%s cookie carries Secure on a TLS request', (_name, set) => {
      const { res, cookie } = mockRes();

      set(req(true), res, 'token-value');

      expect(cookie).toHaveBeenCalledTimes(1);
      expect(cookie.mock.calls[0][2]).toMatchObject({ secure: true });
    });

    it.each([
      ['session', setSessionCookie],
      ['csrf', setCsrfCookie],
    ] as const)('%s cookie omits Secure on plain HTTP (Tailscale/LAN keeps working)', (_name, set) => {
      const { res, cookie } = mockRes();

      set(req(false), res, 'token-value');

      expect(cookie.mock.calls[0][2]).toMatchObject({ secure: false });
    });

    it.each([
      ['session', clearSessionCookie],
      ['csrf', clearCsrfCookie],
    ] as const)('%s clear mirrors req.secure', (_name, clear) => {
      const secure = mockRes();
      clear(req(true), secure.res);
      expect(secure.clearCookie.mock.calls[0][1]).toMatchObject({ secure: true });

      const plain = mockRes();
      clear(req(false), plain.res);
      expect(plain.clearCookie.mock.calls[0][1]).toMatchObject({ secure: false });
    });
  });

  describe('the other fixed attributes', () => {
    it('session cookie is httpOnly, sameSite lax, path /, with a positive maxAge', () => {
      const { res, cookie } = mockRes();

      setSessionCookie(req(true), res, 'token-value');

      const opts = cookie.mock.calls[0][2] as Record<string, unknown>;
      expect(opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
      expect(opts.maxAge as number).toBeGreaterThan(0);
    });

    it('csrf cookie is NOT httpOnly (double-submit needs a JS read), sameSite strict, path /, positive maxAge', () => {
      const { res, cookie } = mockRes();

      setCsrfCookie(req(true), res, 'token-value');

      const opts = cookie.mock.calls[0][2] as Record<string, unknown>;
      expect(opts).toMatchObject({ httpOnly: false, sameSite: 'strict', path: '/' });
      expect(opts.maxAge as number).toBeGreaterThan(0);
    });
  });
});

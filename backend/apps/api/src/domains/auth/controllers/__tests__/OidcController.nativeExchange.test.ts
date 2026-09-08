import { UnauthorizedException } from '@nestjs/common';

import { OidcController } from '../OidcController';

/**
 * `POST /authenticate/oidc/native/exchange` is how the native app trades the
 * short-lived one-time code (delivered by the `companion://oidc/callback` deep link)
 * for a real access token. It is unauthenticated by design — the one-time code IS the
 * proof — so these tests pin that a valid code yields a token and anything else is
 * rejected with 401 (never leaking whether the code was unknown vs expired).
 */
function makeController() {
  const authService = { issueAccessToken: jest.fn().mockReturnValue('access-token-value') };
  const oidcNativeCodeService = { issue: jest.fn(), redeem: jest.fn() };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  const controller = new OidcController(
    {} as never, // userService — unused by nativeExchange
    authService as never,
    {} as never, // csrfService
    {} as never, // featureService
    oidcNativeCodeService as never,
    {} as never, // signupCodeService — unused by nativeExchange
    logger as never,
  );

  return { controller, authService, oidcNativeCodeService, logger };
}

describe('OidcController — native code exchange', () => {
  it('exchanges a valid one-time code for an access token', () => {
    const { controller, authService, oidcNativeCodeService } = makeController();
    oidcNativeCodeService.redeem.mockReturnValue('user-42');

    const result = controller.nativeExchange({ code: 'good-code' });

    expect(oidcNativeCodeService.redeem).toHaveBeenCalledWith('good-code');
    expect(authService.issueAccessToken).toHaveBeenCalledWith('user-42');
    expect(result).toEqual({ accessToken: 'access-token-value' });
  });

  it('rejects an invalid or expired code with 401 and issues no token', () => {
    const { controller, authService, oidcNativeCodeService } = makeController();
    // `redeem` returns null for both unknown and expired codes.
    oidcNativeCodeService.redeem.mockReturnValue(null);

    expect(() => controller.nativeExchange({ code: 'bad-or-expired' })).toThrow(UnauthorizedException);
    expect(authService.issueAccessToken).not.toHaveBeenCalled();
  });

  it('redeems the code exactly once (single-use / replay-safe)', () => {
    const { controller, oidcNativeCodeService } = makeController();
    oidcNativeCodeService.redeem.mockReturnValue('user-7');

    controller.nativeExchange({ code: 'single-use' });

    expect(oidcNativeCodeService.redeem).toHaveBeenCalledTimes(1);
  });
});

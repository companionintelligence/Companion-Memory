import { UnauthorizedException } from '@nestjs/common';

import { ValidationPipe } from '@ci/common/pipes';

import { OidcController } from '../OidcController';

const VERIFIER = 'v'.repeat(43);

/**
 * `POST /authenticate/oidc/native/exchange` is how the native app trades the
 * short-lived one-time code (delivered by the `companion://oidc/callback` deep link)
 * for a real access token. It is unauthenticated, and the proof is the code TOGETHER with
 * the PKCE verifier the app kept when it started the sign-in, so these tests pin that both
 * reach `redeem` and that anything it refuses is a 401 (never leaking whether the code was
 * unknown, expired or presented with the wrong verifier).
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
    {} as never, // federatedIdentityService
    {} as never, // hubBridge
    logger as never,
  );

  return { controller, authService, oidcNativeCodeService, logger };
}

describe('OidcController — native code exchange', () => {
  it('exchanges a valid one-time code for an access token', () => {
    const { controller, authService, oidcNativeCodeService } = makeController();
    oidcNativeCodeService.redeem.mockReturnValue('user-42');

    const result = controller.nativeExchange({ code: 'good-code', code_verifier: VERIFIER });

    expect(oidcNativeCodeService.redeem).toHaveBeenCalledWith('good-code', VERIFIER);
    expect(authService.issueAccessToken).toHaveBeenCalledWith('user-42');
    expect(result).toEqual({ accessToken: 'access-token-value' });
  });

  it('rejects an invalid or expired code with 401 and issues no token', () => {
    const { controller, authService, oidcNativeCodeService } = makeController();
    // `redeem` returns null for both unknown and expired codes.
    oidcNativeCodeService.redeem.mockReturnValue(null);

    expect(() => controller.nativeExchange({ code: 'bad-or-expired', code_verifier: VERIFIER })).toThrow(
      UnauthorizedException,
    );
    expect(authService.issueAccessToken).not.toHaveBeenCalled();
  });

  it('redeems the code exactly once (single-use / replay-safe)', () => {
    const { controller, oidcNativeCodeService } = makeController();
    oidcNativeCodeService.redeem.mockReturnValue('user-7');

    controller.nativeExchange({ code: 'single-use', code_verifier: VERIFIER });

    expect(oidcNativeCodeService.redeem).toHaveBeenCalledTimes(1);
  });

  it('refuses a body without a code_verifier before anything is redeemed', () => {
    // The schema on the route, read back off the decorator: the exchange takes no code alone.
    const pipes = Reflect.getMetadata('__routeArguments__', OidcController, 'nativeExchange') as Record<
      string,
      { pipes?: unknown[] }
    >;
    const pipe = Object.values(pipes)
      .flatMap((argument) => argument.pipes ?? [])
      .find((candidate): candidate is ValidationPipe => candidate instanceof ValidationPipe);

    expect(pipe).toBeDefined();
    expect(() => pipe!.transform({ code: 'good-code' })).toThrow();
    expect(() => pipe!.transform({ code: 'good-code', code_verifier: 'short' })).toThrow();
    expect(pipe!.transform({ code: 'good-code', code_verifier: VERIFIER })).toEqual({
      code: 'good-code',
      code_verifier: VERIFIER,
    });
  });
});

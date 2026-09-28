import { GUARDS_METADATA } from '@nestjs/common/constants';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { OnboardingController } from '../OnboardingController';

/**
 * The native app authenticates with `x-api-key` only. `JwtAuthGuard` on these
 * routes 401s that credential, so the phone can walk the wizard (the steps are
 * local) and then fail the one call that finishes it.
 */
describe('OnboardingController accepts the phone API key', () => {
  it.each(['getProgress', 'saveProgress', 'onboard'] as const)(
    '%s is guarded by JwtOrApiKeyAuthGuard',
    (method) => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, OnboardingController.prototype[method]) as
        | unknown[]
        | undefined;

      expect(guards).toContain(JwtOrApiKeyAuthGuard);
    },
  );
});

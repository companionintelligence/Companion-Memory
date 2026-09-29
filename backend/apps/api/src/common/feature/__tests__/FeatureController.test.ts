import { GUARDS_METADATA } from '@nestjs/common/constants';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { FeatureController } from '../controllers/FeatureController';
import { FeatureService, PUBLIC_FEATURES } from '../services/FeatureService';

describe('FeatureController', () => {
  const controller = new FeatureController(new FeatureService());

  it('answers the unauthenticated route with the public allowlist only', async () => {
    const global = await controller.globalFeatures();

    expect(Object.keys(global).sort()).toEqual([...PUBLIC_FEATURES].sort());
    for (const value of Object.values(global)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('accepts a session token or an API key on the full map', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, FeatureController.prototype.features) as
      | unknown[]
      | undefined;

    expect(guards).toContain(JwtOrApiKeyAuthGuard);
  });

  it('keeps the full map behind the guarded route', async () => {
    const all = await controller.features();
    const global = await controller.globalFeatures();

    // The guarded route is the superset; the public one must not have grown
    // to match it by accident.
    expect(Object.keys(all).length).toBeGreaterThan(Object.keys(global).length);
    // `toContain` on the key list, not `toHaveProperty`: the flag names carry
    // dots, which the latter would read as a path.
    expect(Object.keys(all)).toContain('tools.pendingActions');
    expect(Object.keys(global)).not.toContain('tools.pendingActions');
  });
});

const settings = { applianceAudience: '', deviceId: undefined as string | undefined };

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: {
    auth: {
      portal: {
        get applianceAudience() {
          return settings.applianceAudience;
        },
      },
    },
    ciPortal: {
      get deviceId() {
        return settings.deviceId;
      },
    },
  },
}));

import {
  APPLIANCE_BINDING_CLAIM,
  applianceAudienceFor,
  isApplianceAudience,
  mintedByAddressingPortal,
  thisApplianceAudience,
} from './applianceAudience';

/**
 * The wire contract with CI-Portal. Every literal below is also asserted on the Portal side
 * (`apps/hono-app/src/domains/core/services/applianceAudience.test.ts`); changing one here without
 * the other makes every addressed token a stranger.
 */
describe('appliance audience contract', () => {
  beforeEach(() => {
    settings.applianceAudience = '';
    settings.deviceId = undefined;
  });

  it('names an appliance as urn:ci:device:<Hub device id>', () => {
    expect(applianceAudienceFor('3f2b9c1e')).toBe('urn:ci:device:3f2b9c1e');
    expect(APPLIANCE_BINDING_CLAIM).toBe('ci_appliance_binding');
  });

  it('derives this appliance from the device id the Hub passes in', () => {
    settings.deviceId = '3f2b9c1e';

    expect(thisApplianceAudience()).toBe('urn:ci:device:3f2b9c1e');
  });

  it('lets an explicit PORTAL_APPLIANCE_AUDIENCE win', () => {
    settings.deviceId = '3f2b9c1e';
    settings.applianceAudience = 'urn:ci:device:configured';

    expect(thisApplianceAudience()).toBe('urn:ci:device:configured');
  });

  it('reads a PORTAL_APPLIANCE_AUDIENCE set to a bare device id as that device', () => {
    settings.applianceAudience = ' 3f2b9c1e ';

    expect(thisApplianceAudience()).toBe('urn:ci:device:3f2b9c1e');
  });

  it('has no audience on an install without a Hub', () => {
    expect(thisApplianceAudience()).toBeNull();

    settings.deviceId = '   ';
    expect(thisApplianceAudience()).toBeNull();
  });

  it('tells appliance audiences from client ids', () => {
    expect(isApplianceAudience('urn:ci:device:3f2b9c1e')).toBe(true);
    expect(isApplianceAudience('urn:ci:device:')).toBe(false);
    expect(isApplianceAudience('ci-server')).toBe(false);
    expect(isApplianceAudience('https://hub.ci.computer')).toBe(false);
  });

  it('reads the binding stamp only as a version number of at least 1', () => {
    expect(mintedByAddressingPortal({ ci_appliance_binding: 1 })).toBe(true);
    expect(mintedByAddressingPortal({ ci_appliance_binding: 2 })).toBe(true);
    expect(mintedByAddressingPortal({})).toBe(false);
    expect(mintedByAddressingPortal({ ci_appliance_binding: '1' })).toBe(false);
    expect(mintedByAddressingPortal({ ci_appliance_binding: 0 })).toBe(false);
  });
});

const owner = {
  email: '',
  hubIssuer: '',
  hubSubject: '',
  portalIssuer: '',
  portalSubject: '',
  claimToken: '',
};

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: {
    auth: {
      get applianceOwner() {
        return owner;
      },
      portal: { issuer: 'https://hub.ci.computer' },
    },
  },
}));

import { isDesignatedOwner, ownerClaimTokenConfigured, ownerIsDesignated } from '../applianceOwner';

const HUB = 'urn:ci-hub:0b6f0c55-34b1-4f7e-9c3a-5f2d8a0e1c11';

/**
 * Who may create the first account. Every way a door can show it is the owner, and the near
 * misses that must not count.
 */
describe('applianceOwner', () => {
  beforeEach(() => {
    Object.assign(owner, {
      email: '',
      hubIssuer: '',
      hubSubject: '',
      portalIssuer: '',
      portalSubject: '',
      claimToken: '',
    });
  });

  it('names nobody by default, so the first account stays first come', () => {
    expect(ownerIsDesignated()).toBe(false);
    expect(ownerClaimTokenConfigured()).toBe(false);
    // Nobody is the owner of an appliance that names none: a door cannot claim the gate for itself.
    expect(isDesignatedOwner({ portal: { issuer: 'https://hub.ci.computer', subject: 'anyone' } })).toBe(
      false,
    );
  });

  it.each([['email'], ['hubSubject'], ['portalSubject'], ['claimToken']] as const)(
    'counts an owner as named once %s is set',
    (field) => {
      owner[field] = 'set';

      expect(ownerIsDesignated()).toBe(true);
    },
  );

  describe('by Portal identity', () => {
    beforeEach(() => {
      owner.portalSubject = 'portal-user-1';
    });

    it("matches the owner's (iss, sub), with the configured Portal as the default issuer", () => {
      expect(
        isDesignatedOwner({ portal: { issuer: 'https://hub.ci.computer/', subject: 'portal-user-1' } }),
      ).toBe(true);
    });

    it('refuses the same subject from another issuer, and another subject from this one', () => {
      expect(
        isDesignatedOwner({ portal: { issuer: 'https://other.example', subject: 'portal-user-1' } }),
      ).toBe(false);
      expect(
        isDesignatedOwner({ portal: { issuer: 'https://hub.ci.computer', subject: 'portal-user-2' } }),
      ).toBe(false);
    });

    it('uses CI_OWNER_PORTAL_ISSUER when it is set', () => {
      owner.portalIssuer = 'https://hub.dev.example';

      expect(
        isDesignatedOwner({ portal: { issuer: 'https://hub.dev.example', subject: 'portal-user-1' } }),
      ).toBe(true);
      expect(
        isDesignatedOwner({ portal: { issuer: 'https://hub.ci.computer', subject: 'portal-user-1' } }),
      ).toBe(false);
    });
  });

  describe('by Hub stable id', () => {
    beforeEach(() => {
      owner.hubIssuer = HUB;
      owner.hubSubject = '7c1e2f9a-0d4b-4a8e-b6f1-2e9d3c5a7b80';
    });

    it("matches the Hub owner's directory and public id", () => {
      expect(
        isDesignatedOwner({ hub: { issuer: HUB, subject: '7c1e2f9a-0d4b-4a8e-b6f1-2e9d3c5a7b80' } }),
      ).toBe(true);
    });

    it('refuses another person of the same Hub, and the same id from another Hub', () => {
      expect(
        isDesignatedOwner({ hub: { issuer: HUB, subject: '11111111-0d4b-4a8e-b6f1-2e9d3c5a7b80' } }),
      ).toBe(false);
      expect(
        isDesignatedOwner({
          hub: {
            issuer: 'urn:ci-hub:ffffffff-34b1-4f7e-9c3a-5f2d8a0e1c11',
            subject: '7c1e2f9a-0d4b-4a8e-b6f1-2e9d3c5a7b80',
          },
        }),
      ).toBe(false);
    });
  });

  describe('by address', () => {
    beforeEach(() => {
      owner.email = 'owner@example.com';
    });

    it('matches a Portal sign-in whose address the Portal verified, in any case', () => {
      expect(isDesignatedOwner({ portal: { email: 'Owner@Example.com', emailVerified: true } })).toBe(true);
    });

    it('refuses the same address when the Portal has not verified it', () => {
      expect(isDesignatedOwner({ portal: { email: 'owner@example.com', emailVerified: false } })).toBe(false);
      expect(isDesignatedOwner({ portal: { email: 'owner@example.com' } })).toBe(false);
    });

    it('matches the username the Hub signed for the person it let in', () => {
      expect(isDesignatedOwner({ hub: { username: 'owner@example.com' } })).toBe(true);
      expect(isDesignatedOwner({ hub: { username: 'member@example.com' } })).toBe(false);
    });
  });

  describe('by setup code', () => {
    beforeEach(() => {
      owner.claimToken = 'setup-code-7f3a';
    });

    it('matches the exact code only', () => {
      expect(ownerClaimTokenConfigured()).toBe(true);
      expect(isDesignatedOwner({ claimToken: 'setup-code-7f3a' })).toBe(true);
      expect(isDesignatedOwner({ claimToken: 'setup-code-7f3b' })).toBe(false);
      expect(isDesignatedOwner({ claimToken: 'setup-code' })).toBe(false);
      expect(isDesignatedOwner({ claimToken: null })).toBe(false);
    });
  });
});

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      auth: {
        ...actual.auth,
        portal: {
          enabled: true,
          issuer: 'https://hub.test',
          jwksUri: 'https://hub.test/api/auth/jwks',
          audience: 'ci-server,ci-import-tools',
        },
      },
    },
  };
});

jest.mock('jose', () => ({
  __esModule: true,
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
}));

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { PortalTokenService } from '../services/PortalTokenService';

const mockJwtVerify = jwtVerify as unknown as jest.Mock;
const mockCreateRemoteJWKSet = createRemoteJWKSet as unknown as jest.Mock;

describe('PortalTokenService', () => {
  let userService: { findByEmail: jest.Mock; findById: jest.Mock; create: jest.Mock };
  let federatedIdentityService: { findUserId: jest.Mock; link: jest.Mock };
  let service: PortalTokenService;

  beforeEach(() => {
    mockJwtVerify.mockReset();
    mockCreateRemoteJWKSet.mockReset();
    mockCreateRemoteJWKSet.mockReturnValue('JWKS');
    userService = { findByEmail: jest.fn(), findById: jest.fn(), create: jest.fn() };
    federatedIdentityService = { findUserId: jest.fn().mockResolvedValue(null), link: jest.fn() };
    service = new PortalTokenService(userService as never, federatedIdentityService as never);
  });

  it('verifies against the portal JWKS with the configured issuer + audience', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: 's1', email: 'liam@ci.computer', email_verified: true },
    });
    userService.findByEmail.mockResolvedValue({ id: 'u1' });

    await service.verifyAndProvision('the-token');

    expect(mockJwtVerify).toHaveBeenCalledWith('the-token', 'JWKS', {
      issuer: 'https://hub.test',
      // PORTAL_OIDC_AUDIENCE is a comma-separated list, split to an array so jose
      // accepts a token whose aud matches any first-party client.
      audience: ['ci-server', 'ci-import-tools'],
    });
  });

  it('resolves to the user bound by (issuer, subject) without touching email', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: 's1', iss: 'https://hub.test', email: 'someone-else@ci.computer', email_verified: true },
    });
    federatedIdentityService.findUserId.mockResolvedValue('u-bound');
    userService.findById.mockResolvedValue({ id: 'u-bound' });

    const user = await service.verifyAndProvision('t');

    expect(user).toEqual({ id: 'u-bound' });
    expect(federatedIdentityService.findUserId).toHaveBeenCalledWith('https://hub.test', 's1');
    // Existing binding: email is never consulted, nothing created or re-linked.
    expect(userService.findByEmail).not.toHaveBeenCalled();
    expect(userService.create).not.toHaveBeenCalled();
    expect(federatedIdentityService.link).not.toHaveBeenCalled();
  });

  it('JIT-provisions a new user and binds it to (issuer, subject)', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: 's1', iss: 'https://hub.test', email: 'liam@ci.computer', email_verified: true, name: 'Liam' },
    });
    federatedIdentityService.findUserId.mockResolvedValue(null);
    userService.findByEmail.mockResolvedValue(null);
    userService.create.mockResolvedValue({ id: 'u-new' });

    const user = await service.verifyAndProvision('t');

    expect(user).toEqual({ id: 'u-new' });
    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'liam@ci.computer', name: 'Liam' }),
    );
    expect(federatedIdentityService.link).toHaveBeenCalledWith('https://hub.test', 's1', 'u-new');
  });

  it('adopts a pre-existing email-keyed user once (migration fallback) and back-fills the binding', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: 's1', iss: 'https://hub.test', email: 'liam@ci.computer', email_verified: true },
    });
    federatedIdentityService.findUserId.mockResolvedValue(null);
    userService.findByEmail.mockResolvedValue({ id: 'u-existing' });

    const user = await service.verifyAndProvision('t');

    expect(user).toEqual({ id: 'u-existing' });
    expect(userService.create).not.toHaveBeenCalled();
    expect(federatedIdentityService.link).toHaveBeenCalledWith('https://hub.test', 's1', 'u-existing');
  });

  it('ignores an unverified email claim and does NOT adopt a matching user', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: 's1', iss: 'https://hub.test', email: 'liam@ci.computer', email_verified: false },
    });
    federatedIdentityService.findUserId.mockResolvedValue(null);
    userService.create.mockResolvedValue({ id: 'u-shadow' });

    await service.verifyAndProvision('t');

    // Email is untrusted: never used to look up an existing account, and the new
    // user is keyed on the stable subject via a shadow address.
    expect(userService.findByEmail).not.toHaveBeenCalled();
    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'oidc-s1@portal.local' }),
    );
    expect(federatedIdentityService.link).toHaveBeenCalledWith('https://hub.test', 's1', 'u-shadow');
  });

  it('falls back to a deterministic shadow email when the token has no email', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'sub-xyz', iss: 'https://hub.test' } });
    federatedIdentityService.findUserId.mockResolvedValue(null);
    userService.create.mockResolvedValue({ id: 'u2' });

    await service.verifyAndProvision('t');

    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'oidc-sub-xyz@portal.local' }),
    );
    expect(federatedIdentityService.link).toHaveBeenCalledWith('https://hub.test', 'sub-xyz', 'u2');
  });

  it('returns null for an invalid token (bad signature / issuer / audience / expiry)', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));

    expect(await service.verifyAndProvision('bad')).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
  });
});

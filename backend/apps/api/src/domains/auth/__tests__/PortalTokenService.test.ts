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
          audience: 'ci-server,ci-import-tools,ci-even',
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
  let userService: { findByEmail: jest.Mock; create: jest.Mock };
  let service: PortalTokenService;

  beforeEach(() => {
    mockJwtVerify.mockReset();
    mockCreateRemoteJWKSet.mockReset();
    mockCreateRemoteJWKSet.mockReturnValue('JWKS');
    userService = { findByEmail: jest.fn(), create: jest.fn() };
    service = new PortalTokenService(userService as never);
  });

  it('verifies against the portal JWKS with the configured issuer + audience', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 's1', email: 'liam@ci.computer' } });
    userService.findByEmail.mockResolvedValue({ id: 'u1' });

    await service.verifyAndProvision('the-token');

    expect(mockJwtVerify).toHaveBeenCalledWith('the-token', 'JWKS', {
      issuer: 'https://hub.test',
      // PORTAL_OIDC_AUDIENCE is a comma-separated list, split to an array so jose
      // accepts a token whose aud matches any first-party client.
      audience: ['ci-server', 'ci-import-tools', 'ci-even'],
    });
  });

  it('JIT-provisions a new user from the token claims', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 's1', email: 'liam@ci.computer', name: 'Liam' } });
    userService.findByEmail.mockResolvedValue(null);
    userService.create.mockResolvedValue({ id: 'u-new' });

    const user = await service.verifyAndProvision('t');

    expect(user).toEqual({ id: 'u-new' });
    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'liam@ci.computer', name: 'Liam' }),
    );
  });

  it('returns the existing user without creating a duplicate', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 's1', email: 'liam@ci.computer' } });
    userService.findByEmail.mockResolvedValue({ id: 'u-existing' });

    expect(await service.verifyAndProvision('t')).toEqual({ id: 'u-existing' });
    expect(userService.create).not.toHaveBeenCalled();
  });

  it('falls back to a deterministic shadow email when the token has no email', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 'sub-xyz' } });
    userService.findByEmail.mockResolvedValue(null);
    userService.create.mockResolvedValue({ id: 'u2' });

    await service.verifyAndProvision('t');

    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'oidc-sub-xyz@portal.local' }),
    );
  });

  it('returns null for an invalid token (bad signature / issuer / audience / expiry)', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));

    expect(await service.verifyAndProvision('bad')).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
  });
});

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

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { PortalTokenService } from '../services/PortalTokenService';

const mockJwtVerify = jwtVerify as unknown as jest.Mock;
const mockCreateRemoteJWKSet = createRemoteJWKSet as unknown as jest.Mock;

describe('PortalTokenService', () => {
  let userService: { findByEmail: jest.Mock; create: jest.Mock; findById: jest.Mock };
  let federatedIdentityService: { findUserId: jest.Mock; bind: jest.Mock; listForUser: jest.Mock };
  let logger: { setContext: jest.Mock; debug: jest.Mock; warn: jest.Mock };
  let service: PortalTokenService;

  beforeEach(() => {
    mockJwtVerify.mockReset();
    mockCreateRemoteJWKSet.mockReset();
    mockCreateRemoteJWKSet.mockReturnValue('JWKS');
    userService = { findByEmail: jest.fn(), create: jest.fn(), findById: jest.fn() };
    federatedIdentityService = {
      findUserId: jest.fn().mockResolvedValue(null),
      bind: jest.fn(),
      listForUser: jest.fn().mockResolvedValue([]),
    };
    logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn() };
    service = new PortalTokenService(
      userService as never,
      federatedIdentityService as never,
      logger as never,
    );
  });

  it('verifies against the portal JWKS with the configured issuer + audience', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: 's1', email: 'liam@ci.computer' } });
    userService.create.mockResolvedValue({ id: 'u1' });

    await service.verifyAndProvision('the-token');

    expect(mockJwtVerify).toHaveBeenCalledWith('the-token', 'JWKS', {
      issuer: 'https://hub.test',
      // PORTAL_OIDC_AUDIENCE plus the issuer URL (better-auth access-token default).
      audience: ['ci-server', 'ci-import-tools', 'ci-even', 'https://hub.test'],
    });
  });

  it('resolves an established (iss,sub) binding without touching email', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 's1', email: 'liam@ci.computer' },
    });
    federatedIdentityService.findUserId.mockResolvedValue('u-bound');
    userService.findById.mockResolvedValue({ id: 'u-bound' });

    expect(await service.verifyAndProvision('t')).toEqual({ id: 'u-bound' });
    expect(federatedIdentityService.findUserId).toHaveBeenCalledWith('https://hub.test', 's1');
    expect(userService.findByEmail).not.toHaveBeenCalled();
    expect(userService.create).not.toHaveBeenCalled();
  });

  it('JIT-provisions a new user and binds it on (iss,sub)', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 's1', email: 'liam@ci.computer', name: 'Liam' },
    });
    userService.findByEmail.mockResolvedValue(null);
    userService.create.mockResolvedValue({ id: 'u-new' });

    const user = await service.verifyAndProvision('t');

    expect(user).toEqual({ id: 'u-new' });
    expect(federatedIdentityService.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-new',
        issuer: 'https://hub.test',
        subject: 's1',
        bindMethod: 'sub',
      }),
    );
  });

  it('links a pre-existing account by VERIFIED email exactly once', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 's1', email: 'liam@ci.computer', email_verified: true },
    });
    userService.findByEmail.mockResolvedValue({ id: 'u-existing' });

    expect(await service.verifyAndProvision('t')).toEqual({ id: 'u-existing' });
    expect(userService.create).not.toHaveBeenCalled();
    // The link is recorded so every LATER request for this (iss,sub) skips email.
    expect(federatedIdentityService.bind).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-existing', bindMethod: 'email_link' }),
    );
  });

  it('SECURITY: email_link is ONE-TIME — a second (iss,sub) cannot adopt a federated account', async () => {
    // The account already has a federated identity, so the email path must not
    // hand it to a different subject that merely proves the same address.
    mockJwtVerify.mockResolvedValue({
      payload: {
        iss: 'https://hub.test',
        sub: 'second-sub',
        email: 'liam@ci.computer',
        email_verified: true,
      },
    });
    userService.findByEmail.mockResolvedValue({ id: 'u-existing' });
    federatedIdentityService.listForUser.mockResolvedValue([
      { id: 'fed-1', userId: 'u-existing', issuer: 'https://hub.test', subject: 'first-sub' },
    ]);

    expect(await service.verifyAndProvision('t')).toBeNull();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
  });

  it('SECURITY: an unverified email never adopts an existing account', async () => {
    // The takeover shape: an attacker controls an unverified address at a
    // trusted issuer that collides with a local user. It must provision a NEW
    // account rather than inherit the victim's.
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 'attacker-sub', email: 'liam@ci.computer' },
    });
    userService.findByEmail.mockResolvedValue({ id: 'u-victim' });
    userService.create.mockResolvedValue({ id: 'u-fresh' });

    expect(await service.verifyAndProvision('t')).toEqual({ id: 'u-fresh' });
    expect(federatedIdentityService.bind).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-fresh', subject: 'attacker-sub', bindMethod: 'sub' }),
    );
  });

  it('falls back to a deterministic shadow email when the token has no email', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { iss: 'https://hub.test', sub: 'sub-xyz' } });
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

  describe('verifyClaims', () => {
    it('returns claims WITHOUT provisioning a local user (peer path)', async () => {
      mockJwtVerify.mockResolvedValue({ payload: { iss: 'https://hub.test', sub: 'peer-sub' } });

      expect(await service.verifyClaims('t')).toEqual({
        issuer: 'https://hub.test',
        subject: 'peer-sub',
      });
      // The whole point: a peer must never mint a shadow account here.
      expect(userService.create).not.toHaveBeenCalled();
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    });

    it('returns null for an invalid token', async () => {
      mockJwtVerify.mockRejectedValue(new Error('bad'));

      expect(await service.verifyClaims('bad')).toBeNull();
    });
  });

  // A rejected token used to be indistinguishable from no token at all: the
  // catch returned a bare null, so a misconfigured audience or issuer surfaced
  // only as a blanket 401 with nothing to go on. The reason is now logged —
  // without the token itself.
  it('logs why a token was rejected instead of failing silently', async () => {
    const err = Object.assign(new Error('unexpected "aud" claim value'), {
      code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    });
    mockJwtVerify.mockRejectedValue(err);

    expect(await service.verifyAndProvision('bad-token')).toBeNull();

    expect(logger.debug).toHaveBeenCalledWith(
      'Portal token rejected',
      expect.objectContaining({
        code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        reason: 'unexpected "aud" claim value',
      }),
    );
    // The token itself must never reach the logs.
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('bad-token');
  });
});

// The suite above mocks `config`, so it cannot catch an audience missing from
// the config we actually ship. A first-party client absent from this list gets
// a correctly-signed token rejected by jwtVerify — now logged, but still a 401.
// Assert the real default instead.
//
// Keep in step with CI-Portal's PUBLIC_CLIENTS (createAuth.ts): the portal
// issues per-client tokens with `aud === client_id`, so any client registered
// there must be accepted here or it can authenticate but not write to memory.
describe('shipped PORTAL_OIDC_AUDIENCE default', () => {
  it('accepts every first-party client that CI-Portal can issue tokens for', () => {
    // Read rather than import: the api workspace's tsconfig has no
    // resolveJsonModule, so a JSON import passes jest (swc) but fails typecheck.
    const raw = readFileSync(resolvePath(__dirname, '../../../../config/default.json'), 'utf8');
    const defaults = JSON.parse(raw) as { auth: { portal: { audience: string } } };
    const audiences = defaults.auth.portal.audience.split(',').map((a) => a.trim());

    expect(audiences).toContain('ci-server');
    expect(audiences).toContain('ci-hub');
    expect(audiences).toContain('ci-import-tools');
    expect(audiences).toContain('ci-browser-extension');
    expect(audiences).toContain('ci-even');
    // Companion Memory App (CI-Applet), the desktop capture client.
    expect(audiences).toContain('ci-applet');

    expect(new Set(audiences).size).toBe(audiences.length);
    expect(audiences.every((a) => a.length > 0)).toBe(true);
  });
});

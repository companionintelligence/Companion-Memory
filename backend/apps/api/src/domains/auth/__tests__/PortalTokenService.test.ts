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

// Only the parts that verify a signature or touch the network are mocked. The
// service reads the protected header itself (to skip the Portal for tokens it can
// never have signed), so that stays real — which is why the tokens below have to
// be JWT-shaped.
jest.mock('jose', () => ({
  __esModule: true,
  decodeProtectedHeader: jest.requireActual('jose').decodeProtectedHeader,
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
}));

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import {
  PORTAL_JWKS_COOLDOWN_MS,
  PORTAL_JWKS_FETCH_TIMEOUT_MS,
  PortalTokenService,
} from '../services/PortalTokenService';

const mockJwtVerify = jwtVerify as unknown as jest.Mock;
const mockCreateRemoteJWKSet = createRemoteJWKSet as unknown as jest.Mock;

// jwtVerify is mocked, so the signature is never checked: only the header has to
// parse, and carry an alg a Portal JWKS could serve.
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = (alg: string) => `${b64({ alg, kid: 'k1' })}.${b64({ sub: 's' })}.sig`;
const TOKEN = fakeJwt('EdDSA');

describe('PortalTokenService', () => {
  let userService: { findByEmail: jest.Mock; create: jest.Mock; findById: jest.Mock; hasNoUsers: jest.Mock };
  let federatedIdentityService: { findUserId: jest.Mock; bind: jest.Mock; listForUser: jest.Mock };
  let logger: { setContext: jest.Mock; debug: jest.Mock; warn: jest.Mock };
  let service: PortalTokenService;

  beforeEach(() => {
    mockJwtVerify.mockReset();
    mockCreateRemoteJWKSet.mockReset();
    mockCreateRemoteJWKSet.mockReturnValue('JWKS');
    // A claimed appliance is the steady state; tests that exercise the
    // first-sign-in claim flip this to true explicitly.
    userService = {
      findByEmail: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      hasNoUsers: jest.fn().mockResolvedValue(false),
    };
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
    userService.hasNoUsers.mockResolvedValue(true);
    userService.create.mockResolvedValue({ id: 'u1' });

    await service.verifyAndProvision(TOKEN);

    expect(mockJwtVerify).toHaveBeenCalledWith(TOKEN, 'JWKS', {
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

    expect(await service.verifyAndProvision(TOKEN)).toEqual({ id: 'u-bound' });
    expect(federatedIdentityService.findUserId).toHaveBeenCalledWith('https://hub.test', 's1');
    expect(userService.findByEmail).not.toHaveBeenCalled();
    expect(userService.create).not.toHaveBeenCalled();
  });

  it('claims an UNCLAIMED appliance: provisions the first user and binds it on (iss,sub)', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 's1', email: 'liam@ci.computer', name: 'Liam' },
    });
    userService.findByEmail.mockResolvedValue(null);
    userService.hasNoUsers.mockResolvedValue(true);
    userService.create.mockResolvedValue({ id: 'u-new' });

    const user = await service.verifyAndProvision(TOKEN);

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

  it('SECURITY: a CLAIMED appliance refuses a Portal identity nobody here has bound', async () => {
    // The appliance already has its owner. A valid Portal login — anyone can
    // register one — must not become a fresh local account on it: this was the
    // path by which any Portal user could sign up to any reachable appliance.
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 'stranger-sub', email: 'stranger@example.com', name: 'S' },
    });
    userService.findByEmail.mockResolvedValue(null);
    userService.hasNoUsers.mockResolvedValue(false);

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/already has an owner/));
  });

  it('links a pre-existing account by VERIFIED email exactly once', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 's1', email: 'liam@ci.computer', email_verified: true },
    });
    userService.findByEmail.mockResolvedValue({ id: 'u-existing' });

    expect(await service.verifyAndProvision(TOKEN)).toEqual({ id: 'u-existing' });
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

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
  });

  it('SECURITY: an unverified email never adopts an existing account', async () => {
    // The takeover shape: an attacker controls an unverified address at a
    // trusted issuer that collides with a local user. It must not inherit the
    // victim's account — and on a claimed appliance (the victim's account IS
    // the claim) it gets nothing at all, not even a fresh account.
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 'attacker-sub', email: 'liam@ci.computer' },
    });
    userService.findByEmail.mockResolvedValue({ id: 'u-victim' });

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
  });

  it('falls back to a deterministic shadow email when the token has no email', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { iss: 'https://hub.test', sub: 'sub-xyz' } });
    userService.hasNoUsers.mockResolvedValue(true);
    userService.create.mockResolvedValue({ id: 'u2' });

    await service.verifyAndProvision(TOKEN);

    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'oidc-sub-xyz@portal.local' }),
    );
  });

  it('returns null for an invalid token (bad signature / issuer / audience / expiry)', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
  });

  it('builds the JWKS with explicit fetch timeout + cooldown, once, lazily', async () => {
    mockJwtVerify.mockRejectedValue(new Error('nope'));

    expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();

    await service.verifyAndProvision(TOKEN);
    await service.verifyClaims(TOKEN);

    expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(new URL('https://hub.test/api/auth/jwks'), {
      timeoutDuration: PORTAL_JWKS_FETCH_TIMEOUT_MS,
      cooldownDuration: PORTAL_JWKS_COOLDOWN_MS,
    });
  });

  it.each(['HS256', 'HS384', 'HS512', 'none'])(
    'never consults the Portal for a %s token — it cannot verify against a JWKS',
    async (alg) => {
      const token = fakeJwt(alg);

      expect(await service.verifyAndProvision(token)).toBeNull();
      expect(await service.verifyClaims(token)).toBeNull();

      expect(mockJwtVerify).not.toHaveBeenCalled();
      expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();
    },
  );

  it.each(['EdDSA', 'ES256', 'RS256', 'PS256'])('still sends a %s token to the Portal JWKS', async (alg) => {
    mockJwtVerify.mockResolvedValue({ payload: { iss: 'https://hub.test', sub: 'peer-sub' } });

    expect(await service.verifyClaims(fakeJwt(alg))).toEqual({
      issuer: 'https://hub.test',
      subject: 'peer-sub',
    });
    expect(mockJwtVerify).toHaveBeenCalledTimes(1);
  });

  it('rejects a bearer that is not JWT-shaped without building the JWKS, and says why', async () => {
    expect(await service.verifyAndProvision('opaque-api-token')).toBeNull();

    expect(mockJwtVerify).not.toHaveBeenCalled();
    expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Portal token rejected',
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('opaque-api-token');
  });

  it('warns (not just debug) when jose itself reports a JWKS timeout', async () => {
    mockJwtVerify.mockRejectedValue(
      Object.assign(new Error('request timed out'), { code: 'ERR_JWKS_TIMEOUT' }),
    );

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/timed out/i),
      expect.objectContaining({ code: 'ERR_JWKS_TIMEOUT' }),
    );
  });

  describe('verifyClaims', () => {
    it('returns claims WITHOUT provisioning a local user (peer path)', async () => {
      mockJwtVerify.mockResolvedValue({ payload: { iss: 'https://hub.test', sub: 'peer-sub' } });

      expect(await service.verifyClaims(TOKEN)).toEqual({
        issuer: 'https://hub.test',
        subject: 'peer-sub',
      });
      // The whole point: a peer must never mint a shadow account here.
      expect(userService.create).not.toHaveBeenCalled();
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    });

    it('returns null for an invalid token', async () => {
      mockJwtVerify.mockRejectedValue(new Error('bad'));

      expect(await service.verifyClaims(TOKEN)).toBeNull();
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

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();

    expect(logger.debug).toHaveBeenCalledWith(
      'Portal token rejected',
      expect.objectContaining({
        code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        reason: 'unexpected "aud" claim value',
      }),
    );
    // The token itself must never reach the logs.
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(TOKEN);
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

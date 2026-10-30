/** The portal config every case reads; a case may change it and `beforeEach` puts it back. */
const portalConfig = {
  enabled: true,
  issuer: 'https://hub.test',
  jwksUri: 'https://hub.test/api/auth/jwks',
  audience: 'ci-server,ci-import-tools,ci-even',
  captureClients: 'ci-import-tools,ci-even',
  serviceClients: '',
  applianceAudience: 'urn:ci:device:this-box',
};
const initialPortalConfig = { ...portalConfig };

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      auth: {
        ...actual.auth,
        get portal() {
          return portalConfig;
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

import { UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import {
  MEMORY_SIGN_IN_REFUSED_MESSAGE,
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

/** Stands in for the transaction `UserService.createFirstAccount` runs its `alongside` work in. */
const CLAIM_TRANSACTION = { transaction: 'first-account' };

describe('PortalTokenService', () => {
  let userService: {
    findAccountByEmail: jest.Mock;
    isEmailProven: jest.Mock;
    create: jest.Mock;
    createFirstAccount: jest.Mock;
    findById: jest.Mock;
  };
  let federatedIdentityService: { findUserId: jest.Mock; bind: jest.Mock; listForUser: jest.Mock };
  let logger: { setContext: jest.Mock; debug: jest.Mock; warn: jest.Mock };
  let service: PortalTokenService;

  beforeEach(() => {
    Object.assign(portalConfig, initialPortalConfig);
    mockJwtVerify.mockReset();
    mockCreateRemoteJWKSet.mockReset();
    mockCreateRemoteJWKSet.mockReturnValue('JWKS');
    // A claimed appliance is the steady state (createFirstAccount declines);
    // tests that exercise the first-sign-in claim use `claimsTheAppliance`.
    userService = {
      findAccountByEmail: jest.fn(),
      // The accounts these cases link into carry a proven address unless a case says otherwise.
      isEmailProven: jest.fn().mockReturnValue(true),
      create: jest.fn(),
      createFirstAccount: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
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

  /**
   * The appliance is empty and this sign-in claims it: `createFirstAccount` creates the account,
   * runs the caller's `alongside` work in its transaction, and returns the account.
   */
  const claimsTheAppliance = (user: { id: string }) =>
    userService.createFirstAccount.mockImplementation(
      async (
        _context: unknown,
        _data: unknown,
        alongside?: (manager: unknown, created: unknown) => Promise<unknown>,
      ) => {
        await alongside?.(CLAIM_TRANSACTION, { ...user, role: 'admin' });

        return user;
      },
    );

  it('verifies against the portal JWKS with the configured issuer + audience', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { aud: 'ci-server', sub: 's1', email: 'liam@ci.computer' } });
    claimsTheAppliance({ id: 'u1' });

    await service.verifyAndProvision(TOKEN);

    expect(mockJwtVerify).toHaveBeenCalledWith(TOKEN, 'JWKS', {
      issuer: 'https://hub.test',
      // PORTAL_OIDC_AUDIENCE only. The Portal's own URL is not a client and no longer an audience.
      audience: ['ci-server', 'ci-import-tools', 'ci-even'],
    });
  });

  it('resolves an established (iss,sub) binding without touching email', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { aud: 'ci-server', iss: 'https://hub.test', sub: 's1', email: 'liam@ci.computer' },
    });
    federatedIdentityService.findUserId.mockResolvedValue('u-bound');
    userService.findById.mockResolvedValue({ id: 'u-bound' });

    expect(await service.verifyAndProvision(TOKEN)).toMatchObject({ user: { id: 'u-bound' } });
    expect(federatedIdentityService.findUserId).toHaveBeenCalledWith('https://hub.test', 's1');
    expect(userService.findAccountByEmail).not.toHaveBeenCalled();
    expect(userService.create).not.toHaveBeenCalled();
  });

  it('SECURITY: never creates an account, not even the first one on an empty appliance', async () => {
    // A bearer token used to claim an empty appliance: whoever held any valid Portal token and
    // reached the box first became its owner and administrator. The first account belongs to a
    // sign-in (browser, app, Hub) or a signup by whoever sets the Memory up.
    mockJwtVerify.mockResolvedValue({
      payload: {
        aud: 'ci-server',
        iss: 'https://hub.test',
        sub: 's1',
        email: 'liam@ci.computer',
        name: 'Liam',
      },
    });
    userService.findAccountByEmail.mockResolvedValue(null);
    claimsTheAppliance({ id: 'u-new' });

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(userService.createFirstAccount).not.toHaveBeenCalled();
    expect(userService.create).not.toHaveBeenCalled();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
  });

  it('SECURITY: a CLAIMED appliance refuses a Portal identity nobody here has bound', async () => {
    // The appliance already has its owner. A valid Portal login — anyone can
    // register one — must not become a fresh local account on it: this was the
    // path by which any Portal user could sign up to any reachable appliance.
    mockJwtVerify.mockResolvedValue({
      payload: {
        aud: 'ci-server',
        iss: 'https://hub.test',
        sub: 'stranger-sub',
        email: 'stranger@example.com',
        name: 'S',
      },
    });
    userService.findAccountByEmail.mockResolvedValue(null);
    userService.createFirstAccount.mockResolvedValue(null);

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no account here is bound/));
  });

  it('links a pre-existing account by VERIFIED email exactly once', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        aud: 'ci-server',
        iss: 'https://hub.test',
        sub: 's1',
        email: 'liam@ci.computer',
        email_verified: true,
      },
    });
    userService.findAccountByEmail.mockResolvedValue({ id: 'u-existing' });

    expect(await service.verifyAndProvision(TOKEN)).toMatchObject({ user: { id: 'u-existing' } });
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
        aud: 'ci-server',
        iss: 'https://hub.test',
        sub: 'second-sub',
        email: 'liam@ci.computer',
        email_verified: true,
      },
    });
    userService.findAccountByEmail.mockResolvedValue({ id: 'u-existing' });
    federatedIdentityService.listForUser.mockResolvedValue([
      { id: 'fed-1', userId: 'u-existing', issuer: 'https://hub.test', subject: 'first-sub' },
    ]);

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    // Only OIDC identities count as "linked elsewhere": a Hub person's own binding must not refuse them.
    expect(federatedIdentityService.listForUser).toHaveBeenCalledWith('u-existing', { oidcOnly: true });
  });

  it('SECURITY: a verified email never adopts an account whose OWN address is unproven', async () => {
    // The address was typed into signup or an email change, possibly by someone else expecting
    // this person's first sign-in. The issuer vouches for its account's address, not this one's.
    mockJwtVerify.mockResolvedValue({
      payload: {
        iss: 'https://hub.test',
        sub: 'friend-sub',
        email: 'friend@example.com',
        email_verified: true,
      },
    });
    userService.findAccountByEmail.mockResolvedValue({ id: 'u-planted' });
    userService.isEmailProven.mockReturnValue(false);

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    expect(userService.createFirstAccount).not.toHaveBeenCalled();
  });

  it('SECURITY: a verified email adopts nothing when several accounts match it once case is ignored', async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { iss: 'https://hub.test', sub: 's9', email: 'owner@example.com', email_verified: true },
    });
    userService.findAccountByEmail.mockResolvedValue('ambiguous');

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    expect(userService.createFirstAccount).not.toHaveBeenCalled();
  });

  it('SECURITY: an unverified email never adopts an existing account', async () => {
    // The takeover shape: an attacker controls an unverified address at a
    // trusted issuer that collides with a local user. It must not inherit the
    // victim's account — and on a claimed appliance (the victim's account IS
    // the claim) it gets nothing at all, not even a fresh account.
    mockJwtVerify.mockResolvedValue({
      payload: { aud: 'ci-server', iss: 'https://hub.test', sub: 'attacker-sub', email: 'liam@ci.computer' },
    });
    userService.findAccountByEmail.mockResolvedValue({ id: 'u-victim' });

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
  });

  it('returns null for an invalid token (bad signature / issuer / audience / expiry)', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));

    expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    expect(userService.create).not.toHaveBeenCalled();
    expect(userService.createFirstAccount).not.toHaveBeenCalled();
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
    mockJwtVerify.mockResolvedValue({
      payload: { aud: 'ci-server', iss: 'https://hub.test', sub: 'peer-sub' },
    });

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

  /**
   * Every Memory trusts the same Portal and signs its users in as the same client, so a token's
   * client id alone never said which Memory it was for: one Memory could replay a token it received
   * at another, as the same person, with full authority. Now the authority follows the audience.
   */
  describe('which Memory a token is for, and what it may do here', () => {
    const OWNER = { id: 'u-owner', role: 'admin' };
    const signedInAs = (payload: Record<string, unknown>) => {
      mockJwtVerify.mockResolvedValue({ payload: { iss: 'https://hub.test', sub: 's1', ...payload } });
      federatedIdentityService.findUserId.mockResolvedValue('u-owner');
      userService.findById.mockResolvedValue(OWNER);
    };

    const FULL = { user: OWNER, limits: null, credentialRoutes: true, admin: true };
    const CAPTURE = {
      user: OWNER,
      limits: { scopes: ['capture'], capability: 'write' },
      credentialRoutes: false,
      admin: false,
    };

    it('gives a token addressed to this appliance the full authority of its user', async () => {
      signedInAs({ aud: ['ci-server', 'urn:ci:device:this-box'], azp: 'ci-server', ci_appliance_binding: 1 });

      expect(await service.verifyAndProvision(TOKEN)).toEqual(FULL);
    });

    it('refuses a token addressed to a different appliance, without looking anyone up', async () => {
      signedInAs({
        aud: ['ci-server', 'urn:ci:device:other-box'],
        azp: 'ci-server',
        ci_appliance_binding: 1,
      });

      expect(await service.verifyAndProvision(TOKEN)).toBeNull();
      expect(federatedIdentityService.findUserId).not.toHaveBeenCalled();
    });

    it('refuses every addressed token when this appliance has no audience of its own', async () => {
      portalConfig.applianceAudience = '';
      signedInAs({ aud: ['ci-server', 'urn:ci:device:this-box'], azp: 'ci-server', ci_appliance_binding: 1 });

      expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    });

    it('refuses a stamped ci-server token addressed to no appliance, without looking anyone up', async () => {
      // The id_token a Memory receives when someone signs in to it with Companion, or the one a
      // phone app from before addressed pairing sends. Here it is no credential: not for keys, not
      // for capture, not for anything. The answer says what to do instead.
      signedInAs({ aud: 'ci-server', azp: 'ci-server', ci_appliance_binding: 1 });

      const refused = service.verifyAndProvision(TOKEN);

      await expect(refused).rejects.toThrow(UnauthorizedException);
      await expect(refused).rejects.toThrow(MEMORY_SIGN_IN_REFUSED_MESSAGE);
      expect(federatedIdentityService.findUserId).not.toHaveBeenCalled();
      expect(userService.findAccountByEmail).not.toHaveBeenCalled();
    });

    it('refuses it the same way when only aud names the client', async () => {
      signedInAs({ aud: 'ci-server', ci_appliance_binding: 1 });

      await expect(service.verifyAndProvision(TOKEN)).rejects.toThrow(UnauthorizedException);
    });

    it('words the refusal so an older phone app shows it, rather than asking for a new sign-in', () => {
      // That app reads any message containing "unauthorized" as "sign in again".
      expect(MEMORY_SIGN_IN_REFUSED_MESSAGE).not.toMatch(/unauthorized/i);
      expect(MEMORY_SIGN_IN_REFUSED_MESSAGE).toMatch(/up-to-date app/);
    });

    it("confines another client's stamped token addressed to no appliance to the capture scope", async () => {
      portalConfig.audience = 'ci-server,ci-hub,ci-import-tools,ci-even';
      signedInAs({ aud: 'ci-hub', azp: 'ci-hub', ci_appliance_binding: 1 });

      expect(await service.verifyAndProvision(TOKEN)).toEqual(CAPTURE);
    });

    it('keeps an unaddressed token from an older Portal working for pairing, but not for admin routes', async () => {
      // Before the Portal addresses tokens, nothing could have addressed this one: phone pairing
      // mints its key with it, so it keeps credential routes. Admin routes it loses.
      signedInAs({ aud: 'ci-server' });

      expect(await service.verifyAndProvision(TOKEN)).toEqual({ ...FULL, admin: false });
    });

    it.each([
      ['addressed here', { aud: ['ci-import-tools', 'urn:ci:device:this-box'], azp: 'ci-import-tools' }],
      ['unaddressed, stamped', { aud: 'ci-import-tools', ci_appliance_binding: 1 }],
      ['unaddressed, older Portal', { aud: 'ci-import-tools' }],
    ])(
      'confines a capture client to the capture scope however it was issued (%s)',
      async (_label, claims) => {
        signedInAs(claims);

        expect(await service.verifyAndProvision(TOKEN)).toEqual(CAPTURE);
      },
    );

    it('refuses a token whose client cannot be told: two accepted clients and no azp', async () => {
      signedInAs({ aud: ['ci-server', 'ci-even'] });

      expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    });

    it('refuses a token whose azp names a client this Memory does not accept', async () => {
      signedInAs({
        aud: ['ci-server', 'urn:ci:device:this-box'],
        azp: 'ci-planning',
        ci_appliance_binding: 1,
      });

      expect(await service.verifyAndProvision(TOKEN)).toBeNull();
    });

    describe('service accounts', () => {
      beforeEach(() => {
        portalConfig.serviceClients = 'hbpe-sidecar';
        userService.findById.mockResolvedValue({ id: 'u-owner', role: 'admin' });
      });

      // The service list is parsed when the service is built.
      const rebuilt = () =>
        new PortalTokenService(userService as never, federatedIdentityService as never, logger as never);

      it('confines an addressed service token to the api-key scopes its scope claim names', async () => {
        mockJwtVerify.mockResolvedValue({
          payload: {
            aud: ['ci-server', 'urn:ci:device:this-box'],
            sub: 'u-owner',
            azp: 'hbpe-sidecar',
            scope: 'memory openid not-a-scope',
          },
        });

        expect(await rebuilt().verifyAndProvision(TOKEN)).toEqual({
          user: { id: 'u-owner', role: 'admin' },
          limits: { scopes: ['memory'], capability: 'write' },
          credentialRoutes: false,
          admin: false,
        });
      });

      it('refuses a service token not addressed to this appliance', async () => {
        mockJwtVerify.mockResolvedValue({
          payload: { aud: 'ci-server', sub: 'u-owner', azp: 'hbpe-sidecar', scope: 'memory' },
        });

        expect(await rebuilt().verifyAndProvision(TOKEN)).toBeNull();
        expect(userService.findById).not.toHaveBeenCalled();
      });

      it('refuses a service token that names no api-key scope', async () => {
        mockJwtVerify.mockResolvedValue({
          payload: { aud: ['ci-server', 'urn:ci:device:this-box'], sub: 'u-owner', azp: 'hbpe-sidecar' },
        });

        expect(await rebuilt().verifyAndProvision(TOKEN)).toBeNull();
      });
    });
  });

  describe('verifyClaims', () => {
    it('returns claims WITHOUT provisioning a local user (peer path)', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { aud: 'ci-server', iss: 'https://hub.test', sub: 'peer-sub' },
      });

      expect(await service.verifyClaims(TOKEN)).toEqual({
        issuer: 'https://hub.test',
        subject: 'peer-sub',
      });
      // The whole point: a peer must never mint a shadow account here.
      expect(userService.create).not.toHaveBeenCalled();
      expect(userService.createFirstAccount).not.toHaveBeenCalled();
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

  it('ships the capture agents as capture clients, and no service account', () => {
    const raw = readFileSync(resolvePath(__dirname, '../../../../config/default.json'), 'utf8');
    const { portal } = (
      JSON.parse(raw) as { auth: { portal: { captureClients: string; serviceClients: string } } }
    ).auth;

    expect(portal.captureClients.split(',').sort()).toEqual(
      ['ci-applet', 'ci-browser-extension', 'ci-even', 'ci-import-tools'].sort(),
    );
    // Nothing presents a service token: the sidecars authenticate with SIDECAR_AUTH_SECRET.
    expect(portal.serviceClients).toBe('');
  });
});

// PortalTokenService.test.ts mocks `jose` wholesale, which is right for the
// provisioning rules but cannot see the failure this file is about: jose's REAL
// remote key set holds ONE shared in-flight JWKS fetch (`#pendingFetch`), and
// `reload()` is `pendingFetch ||= fetchJwks(...)`. If that single fetch never
// settles, every later verification joins it and awaits it forever.
//
// Seen live (2026-09-28): ~3.5h into a run, every request carrying a well-formed
// Bearer hung with no response while api-key, cookie and unauthenticated routes
// stayed fast. The guard verifies the bearer against the Portal BEFORE the local
// strategies, so one wedged fetch took the whole authenticated API down.
//
// Here jose is real and only the network is faked — a `fetch` that ignores its
// AbortSignal and never resolves, which is what a stalled socket looks like from
// jose's side.

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
          audience: 'ci-server',
        },
      },
    },
  };
});

import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

import {
  PORTAL_JWKS_FETCH_TIMEOUT_MS,
  PORTAL_VERIFY_TIMEOUT_MS,
  PortalTokenService,
} from '../services/PortalTokenService';

// A generous upper bound on "bounded". The real cap is asserted separately below;
// advancing past it here keeps a regression a fast assertion failure rather than
// a jest timeout.
const WELL_PAST_THE_CAP_MS = 10_000;

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const neverSettles = () => new Promise<Response>(() => undefined);

describe('PortalTokenService — a wedged JWKS fetch must not hang bearer auth', () => {
  let privateKey: SigningKey;
  let jwks: { keys: JWK[] };
  let portalToken: string;
  let localSessionToken: string;

  let fetchMock: jest.SpyInstance;
  let userService: {
    findById: jest.Mock;
    createFirstAccount: jest.Mock;
    findByEmail: jest.Mock;
    create: jest.Mock;
  };
  let federatedIdentityService: { findUserId: jest.Mock; bind: jest.Mock; listForUser: jest.Mock };
  let logger: { setContext: jest.Mock; debug: jest.Mock; warn: jest.Mock };
  let service: PortalTokenService;

  const portalJwt = (key: SigningKey) =>
    new SignJWT({ email: 'liam@ci.computer' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'portal-key-1' })
      .setIssuer('https://hub.test')
      .setAudience('ci-server')
      .setSubject('portal-sub-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);

  // jose only ever touches `status` and `json()` on the response.
  const respondWithJwks = () =>
    fetchMock.mockImplementation(() => Promise.resolve({ status: 200, json: async () => jwks } as Response));

  // Resolves to true once `promise` has settled, without awaiting it — so a hang
  // is observable as `false` instead of blocking the test.
  const track = (promise: Promise<unknown>) => {
    const state = { settled: false };
    void promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );

    return state;
  };

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateKey = pair.privateKey;
    jwks = {
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'portal-key-1', alg: 'EdDSA', use: 'sig' }],
    };

    portalToken = await portalJwt(privateKey);
    // What the web app actually sends: an HS256 session JWT signed with the
    // local secret. It can never be a Portal token.
    localSessionToken = await new SignJWT({ sub: 'local-user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('local-session-secret-local-session-secret'));
  });

  beforeEach(() => {
    // Leave nextTick/queueMicrotask/setImmediate real: only the timers under test
    // (the hard cap) need to be driven by hand.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });

    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(neverSettles);

    userService = {
      findById: jest.fn().mockResolvedValue({ id: 'u-bound' }),
      createFirstAccount: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn(),
      create: jest.fn(),
    };
    federatedIdentityService = {
      findUserId: jest.fn().mockResolvedValue('u-bound'),
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

  afterEach(() => {
    fetchMock.mockRestore();
    jest.useRealTimers();
  });

  it('verifyAndProvision falls through (null) within the cap instead of hanging', async () => {
    const outcome = service.verifyAndProvision(portalToken);
    const state = track(outcome);

    // Just under the cap: still waiting on the Portal.
    await jest.advanceTimersByTimeAsync(PORTAL_VERIFY_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);

    await jest.advanceTimersByTimeAsync(WELL_PAST_THE_CAP_MS);
    expect(state.settled).toBe(true);
    await expect(outcome).resolves.toBeNull();

    // Never got as far as resolving a user.
    expect(userService.findById).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/timed out/i),
      expect.objectContaining({ timeoutMs: PORTAL_VERIFY_TIMEOUT_MS }),
    );
    // The token itself must never reach the logs.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(portalToken);
  });

  it('drops the wedged JWKS set after a timeout, so the next request recovers', async () => {
    // First request: the fetch never settles.
    const first = service.verifyAndProvision(portalToken);
    await jest.advanceTimersByTimeAsync(WELL_PAST_THE_CAP_MS);
    await expect(first).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The Portal is reachable again. Had the cached set survived, this request
    // would join the first fetch's never-settling promise and hang the same way.
    respondWithJwks();
    const second = service.verifyAndProvision(portalToken);
    const state = track(second);
    await jest.advanceTimersByTimeAsync(0);

    // Real timers would be needed to let real crypto finish; the verify itself
    // needs no timer, so a plain await drives it to completion.
    await expect(second).resolves.toMatchObject({ user: { id: 'u-bound' } });
    expect(state.settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('verifyClaims is bounded the same way (peer-ask surface shares the JWKS)', async () => {
    const outcome = service.verifyClaims(portalToken);
    const state = track(outcome);

    await jest.advanceTimersByTimeAsync(WELL_PAST_THE_CAP_MS);
    expect(state.settled).toBe(true);
    await expect(outcome).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/timed out/i), expect.anything());
  });

  it('a local HS256 session token never triggers a JWKS fetch', async () => {
    // Every logged-in web request carries one of these. It is decided from the
    // header alone: a symmetric alg cannot verify against a public-key set, so
    // there is nothing to ask the Portal.
    await expect(service.verifyAndProvision(localSessionToken)).resolves.toBeNull();
    await expect(service.verifyClaims(localSessionToken)).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(userService.findById).not.toHaveBeenCalled();
  });

  it('does not let a wedged Portal delay a local session token', async () => {
    // The outage scenario end to end: Portal unreachable, and the request that
    // hung was a local token. It must fall through immediately, no timers needed.
    const outcome = service.verifyAndProvision(localSessionToken);
    const state = track(outcome);
    await jest.advanceTimersByTimeAsync(0);

    expect(state.settled).toBe(true);
    await expect(outcome).resolves.toBeNull();
  });

  it.each([
    ['an unsigned (alg=none) token', `${b64({ alg: 'none' })}.${b64({ sub: 'x' })}.`],
    ['a non-JWT bearer', 'not-a-jwt'],
    ['an empty-header token', '..'],
  ])('rejects %s without a JWKS fetch', async (_name, token) => {
    await expect(service.verifyAndProvision(token)).resolves.toBeNull();
    await expect(service.verifyClaims(token)).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still verifies a real EdDSA Portal token against the JWKS (behaviour unchanged)', async () => {
    respondWithJwks();

    await expect(service.verifyAndProvision(portalToken)).resolves.toMatchObject({ user: { id: 'u-bound' } });
    expect(federatedIdentityService.findUserId).toHaveBeenCalledWith('https://hub.test', 'portal-sub-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://hub.test/api/auth/jwks');

    await expect(service.verifyClaims(portalToken)).resolves.toEqual({
      issuer: 'https://hub.test',
      subject: 'portal-sub-1',
    });
    // Second verification is served from the cached set.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the hard cap above the JWKS fetch timeout and inside the 3-5s budget', () => {
    // jose's own timeout (a specific ERR_JWKS_TIMEOUT) should normally fire
    // first; the hard cap is the backstop for a fetch that ignores its signal.
    expect(PORTAL_JWKS_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PORTAL_VERIFY_TIMEOUT_MS).toBeGreaterThan(PORTAL_JWKS_FETCH_TIMEOUT_MS);
    expect(PORTAL_VERIFY_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

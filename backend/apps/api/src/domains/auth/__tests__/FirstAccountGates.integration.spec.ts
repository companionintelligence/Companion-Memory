// The Portal bearer path verifies a JWT against a remote JWKS. Only the verification is replaced —
// the payload is decoded, not checked — because what these cases race is what happens AFTER a
// token is accepted. The protected header is still read for real, so the tokens are JWT-shaped.
jest.mock('jose', () => ({
  __esModule: true,
  decodeProtectedHeader: jest.requireActual('jose').decodeProtectedHeader,
  jwtVerify: jest.fn(async (token: string) => ({
    payload: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')),
  })),
  createRemoteJWKSet: jest.fn(() => 'JWKS'),
}));

// `undici`'s fetch is how OidcController.callback reaches the identity provider (token exchange,
// then userinfo). Answered per authorization code, so two callbacks racing each get their own
// identity whatever order their requests interleave in.
const mockFetch = jest.fn();

jest.mock('undici', () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
  Agent: jest.fn().mockImplementation(() => ({})),
}));

import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource, type DataSourceOptions, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';
import { UserEntity, UserService } from '@ci/domains/user';

import { syntheticTestUserEmail } from '../../__tests__/support/applianceUser';
import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { OidcController } from '../controllers/OidcController';
import { SignupController } from '../controllers/SignupController';
import { FederatedIdentityEntity } from '../entities/FederatedIdentityEntity';
import { SignupCodeEntity } from '../entities/SignupCodeEntity';
import { AuthService } from '../services/AuthService';
import { FederatedIdentityService } from '../services/FederatedIdentityService';
import { PortalTokenService } from '../services/PortalTokenService';
import { SignupCodeService } from '../services/SignupCodeService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The doors that admit an account nobody invited, raced against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three entry points let an account in WITHOUT an invitation, and only while the appliance has no
 * account at all — that being the one moment there is nobody to invite anyone:
 *
 *  - `PortalTokenService.provisionUser`, path 3: a Portal bearer token no account here is bound to;
 *  - `SignupController.signup`: with `require.signup.codes` on, the first account needs no code;
 *  - `OidcController.callback`: a native sign-in, and — with codes required — a web one, whose
 *    account is created a page later by `confirmAccount`.
 *
 * Each used to ask `UserService.hasNoUsers()` and then, as a SEPARATE step, create the account. Two
 * requests arriving together on an empty appliance both saw it empty and both got in, so whichever
 * lost the race for admin became a permanent member without an invitation. For the web path the
 * gap was not a race window but the life of the signup-intent cookie: the callback decided
 * "unclaimed", and the confirm step created the account up to ten minutes later without asking again.
 *
 * Each race below forces the interleaving rather than hoping for it ({@link forceRace}): every racer
 * waits at its first "is this appliance empty?" answer until all of them have one, so they have all
 * seen an empty appliance before any of them writes; and again inside the transaction that decides,
 * where each case records whether the others were in there too or queued on the lock. Only a
 * decision serialized with the INSERT can separate them — and each case proves that is what did.
 *
 * ── Why a database of its own ─────────────────────────────────────────────
 *
 * "Empty" means NO row in `ci.users`, soft-deleted ones included. A database shared with other
 * suites cannot promise that for a single test, let alone for a run: dozens of them insert fixture
 * users, in parallel. So this suite replays every migration into a scratch database it creates and
 * drops (see `scratchDatabase.ts`), and SKIPS when there is no administrative connection to make
 * one with — which is every `ci.yml` run, by a deliberate cost decision that workflow documents.
 * Run it with `DATABASE_ADMIN_PASSWORD` (or `PIPELINE_TEST_ADMIN_DATABASE_URL`) set.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.
  console.warn(`[auth/FirstAccountGates.integration] SKIPPED — ${availability.reason}`);
}

// Replaying every migration takes a while; the cases themselves are quick.

/** The app's half of a native sign-in: an S256 challenge and a state value of its own. */
const APP_CHALLENGE = 'c'.repeat(43);
const APP_STATE = 's'.repeat(32);

jest.setTimeout(180_000);

const ISSUER = 'https://portal.first-account.test';
const SYSTEM = { userId: SYSTEM_USER } as const;
const SIGNUP_CODES = 'require.signup.codes';
const INTENT_COOKIE = 'oidc_signup_intent';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A Portal bearer token for `subject`. Only its payload is read (see the `jose` mock). It names an
 * accepted client in `aud`, so the service gets past "which client is this for" and the cases below
 * test what happens to an unbound identity, not a token refused for having no audience.
 */
const portalToken = (subject: string, email: string) =>
  `${b64url({ alg: 'EdDSA', kid: 'k1' })}.${b64url({ iss: ISSUER, aud: 'ci-server', sub: subject, email, name: subject })}.sig`;

/** What the identity provider says about the person behind each authorization code. */
const identityForCode = new Map<string, { sub: string; iss: string; email: string; name: string }>();

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

mockFetch.mockImplementation(
  async (url: URL | string, init?: { body?: URLSearchParams; headers?: Record<string, string> }) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith('/oauth2/token')) {
      const code = init?.body?.get('code') ?? '';

      return jsonResponse({ access_token: `access:${code}`, token_type: 'bearer' });
    }

    if (path.endsWith('/oauth2/userinfo')) {
      const code = (init?.headers?.Authorization ?? '').replace('Bearer access:', '');

      return jsonResponse(identityForCode.get(code));
    }

    throw new Error(`unexpected fetch ${String(url)}`);
  },
);

/** A fake Express response that records what the controller did with it. */
const fakeResponse = () => ({ cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn() });

type FakeResponse = ReturnType<typeof fakeResponse>;

/** Where a controller that answers by redirecting sent the caller (the last argument of its one redirect). */
const redirectedTo = (res: FakeResponse): string => {
  expect(res.redirect).toHaveBeenCalledTimes(1);

  return res.redirect.mock.calls[0].at(-1) as string;
};

/** Where {@link forceRace} found the racers at each of its two rendezvous. */
interface RaceLineUp {
  unlockedCheck: 'waiting' | 'all answered' | 'gave up';
  lockedCheck: 'waiting' | 'all inside at once' | 'the others queued on the claim lock' | 'gave up';
}

/** The private check `UserService` asks "has this appliance ever had an account?" through. */
interface ClaimCheck {
  anyAccountExists(manager: EntityManager): Promise<boolean>;
}

const quietLogger = () => ({
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
});

describeWithDatabase(`first-account gates, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;

  let userService: UserService;
  let federatedIdentityService: FederatedIdentityService;
  let portalTokenService: PortalTokenService;
  let signupController: SignupController;
  let oidcController: OidcController;

  /** Feature flags switched on for the current case. */
  const flags = new Set<string>();

  /** Spies a case installs on the service under test, removed after it. */
  const spies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    config.auth.portal.enabled = true;
    config.auth.portal.issuer = ISSUER;
    config.auth.portal.jwksUri = `${ISSUER}/api/auth/jwks`;
    // Unset by default, and callback() refuses to run without it.
    config.auth.oidc.issuerUrl = 'http://localhost:8506';

    scratch = await ScratchDatabase.create({ createdBy: 'auth/FirstAccountGates.integration.spec' });

    await scratch.assertOwn();

    // The scratch handle maps no entities; the services under test go through repositories.
    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      entities: [UserEntity, FederatedIdentityEntity, SignupCodeEntity],
    } as DataSourceOptions);
    await dataSource.initialize();

    // Nothing observing UserCreated is under test, and no listener may run against this database.
    const eventService = { send: async () => [] };

    userService = new UserService(dataSource.getRepository(UserEntity), eventService as never);
    federatedIdentityService = new FederatedIdentityService(
      dataSource.getRepository(FederatedIdentityEntity),
      quietLogger() as never,
    );
    const signupCodeService = new SignupCodeService(dataSource.getRepository(SignupCodeEntity));
    const featureService = { isFeatureEnabled: async (name: string) => flags.has(name) };

    // The signup intent is a real signed token, so what the confirm step reads back is exactly what
    // the callback wrote. Sessions are not under test.
    const intents = new AuthService(new JwtService(), undefined as never);
    const authService = {
      issueSignupIntentToken: intents.issueSignupIntentToken.bind(intents),
      verifySignupIntentToken: intents.verifySignupIntentToken.bind(intents),
      issueSessionToken: async (userId: string) => ({
        sessionToken: `session:${userId}`,
        sessionId: `sid:${userId}`,
      }),
      issueAccessToken: (userId: string) => `access:${userId}`,
      getSessionMetadata: () => ({ ip: '127.0.0.1', userAgent: 'jest' }),
      resolveCsrfScope: () => null,
    };
    const csrfService = { generateToken: () => 'csrf', validateToken: () => undefined };

    portalTokenService = new PortalTokenService(
      userService,
      federatedIdentityService,
      quietLogger() as never,
    );
    signupController = new SignupController(
      userService,
      authService as never,
      signupCodeService,
      featureService as never,
      csrfService as never,
    );
    oidcController = new OidcController(
      userService,
      authService as never,
      csrfService as never,
      featureService as never,
      { issue: (userId: string) => `one-time-${userId}`, redeem: () => null } as never,
      signupCodeService,
      federatedIdentityService,
      { verifyUsername: () => null } as never,
      quietLogger() as never,
    );
  });

  afterEach(async () => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    flags.clear();
    identityForCode.clear();

    // Every case starts on an appliance nobody has ever claimed. The guard first: this empties
    // ci.users, which is only ever acceptable in a database this run made.
    await scratch.assertOwn();
    await dataSource.query('DELETE FROM ci.federated_identities');
    await dataSource.query('DELETE FROM ci.signup_code');
    await dataSource.query('DELETE FROM ci.users');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await scratch?.drop();
  });

  // ── Fixtures and probes ─────────────────────────────────────────────────

  /** How long a racer waits at a rendezvous before giving up on the others. */
  const RENDEZVOUS_BOUND_MS = 10_000;

  /** Transactions in this (scratch) database queued on an advisory lock — the claim lock. */
  const queuedOnClaimLock = async (): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS queued
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    )) as Array<{ queued: number }>;

    return row.queued;
  };

  /**
   * Line `racers` concurrent first-account attempts up at BOTH places a check-then-act race hides,
   * instead of trusting bcrypt's timing to overlap them:
   *
   *  1. The unlocked "is this appliance empty?" (`hasNoUsers`). Every racer gets its answer before
   *     any goes on, so all of them have seen an empty appliance — the interleaving that let two
   *     first sign-ins through while that answer was the one acted on.
   *  2. The same question asked again inside the claiming transaction. A racer that has asked it
   *     waits until every other racer has asked it too, or is QUEUED ON THE CLAIM LOCK. Unserialized,
   *     they would all be in there at once, all see an empty table and all insert; serialized, the
   *     others can only be queued. {@link RaceLineUp.lockedCheck} records which it was, so a pass
   *     means "serialized" and not "happened not to overlap" — without this second rendezvous most of
   *     these cases passed with the lock deleted.
   *
   * Both are bounded, so a path that never reaches one fails its assertion instead of hanging.
   */
  const forceRace = (racers: number) => {
    const lineUp: RaceLineUp = { unlockedCheck: 'waiting', lockedCheck: 'waiting' };

    // ── 1. the unlocked check ──
    const answerUnlocked = userService.hasNoUsers.bind(userService);
    let atUnlockedCheck = 0;
    let releaseUnlocked!: () => void;
    const unlockedReleased = new Promise<void>((resolve) => {
      releaseUnlocked = resolve;
    });
    const giveUp = setTimeout(() => {
      lineUp.unlockedCheck = 'gave up';
      releaseUnlocked();
    }, RENDEZVOUS_BOUND_MS);

    giveUp.unref();

    spies.push(
      jest.spyOn(userService, 'hasNoUsers').mockImplementation(async () => {
        const unclaimed = await answerUnlocked();

        if (atUnlockedCheck < racers) {
          atUnlockedCheck += 1;

          if (atUnlockedCheck === racers) {
            clearTimeout(giveUp);
            lineUp.unlockedCheck = 'all answered';
            releaseUnlocked();
          }

          await unlockedReleased;
        }

        return unclaimed;
      }),
    );

    // ── 2. the check inside the claiming transaction ──
    // `anyAccountExists` is private; it is where both questions are asked, and only the one inside
    // a transaction (a manager with a query runner) is held here.
    const service = userService as unknown as ClaimCheck;
    const answerLocked = service.anyAccountExists.bind(userService);
    let insideTransaction = 0;

    spies.push(
      jest.spyOn(service, 'anyAccountExists').mockImplementation(async (manager) => {
        const exists = await answerLocked(manager);

        if (manager.queryRunner == null || lineUp.lockedCheck !== 'waiting') {
          return exists;
        }

        insideTransaction += 1;

        const deadline = Date.now() + RENDEZVOUS_BOUND_MS;

        while (lineUp.lockedCheck === 'waiting') {
          const queued = await queuedOnClaimLock();

          // Counted AFTER the query, and only acted on if no other racer settled it meanwhile: a
          // racer can come inside while the query runs, and "0 queued of 0 still outside" is not
          // serialization.
          const stillOutside = racers - insideTransaction;

          if (lineUp.lockedCheck !== 'waiting') {
            break;
          }

          if (stillOutside <= 0) {
            lineUp.lockedCheck = 'all inside at once';
          } else if (queued >= stillOutside) {
            lineUp.lockedCheck = 'the others queued on the claim lock';
          } else if (Date.now() > deadline) {
            lineUp.lockedCheck = 'gave up';
          } else {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        return exists;
      }),
    );

    return lineUp;
  };

  /** What a serialized race looks like to {@link forceRace}. */
  const SERIALIZED: RaceLineUp = {
    unlockedCheck: 'all answered',
    lockedCheck: 'the others queued on the claim lock',
  };

  const accounts = async () =>
    (await dataSource.query(
      `SELECT id, email, role, deleted_at FROM ci.users ORDER BY created_at, id`,
    )) as Array<{ id: string; email: string; role: string; deleted_at: Date | null }>;

  const bindings = async () =>
    (await dataSource.query(
      `SELECT user_id, issuer, subject FROM ci.federated_identities ORDER BY created_at`,
    )) as Array<{ user_id: string; issuer: string; subject: string }>;

  /** An account through the ordinary `create()` — how any other door (an invitation, open signup) adds one. */
  const createAccount = (label: string) => {
    const id = uuidv7();

    return userService.create(SYSTEM, {
      id,
      name: `First-account spec ${label}`,
      email: syntheticTestUserEmail(`first-account-${label}`, id),
      password: `first-account-${id}`,
    });
  };

  const signup = (label: string, signupCode?: string) =>
    signupController.signup({ secure: false, headers: {}, cookies: {} } as never, fakeResponse() as never, {
      name: `Signup ${label}`,
      email: syntheticTestUserEmail(`first-account-signup-${label}`, uuidv7()),
      password: `signup-${label}-password`,
      signup_code: signupCode,
    });

  /** Run the OIDC callback for `subject`, as the native app (deep link) or the browser. */
  const oidcCallback = async (subject: string, client: 'native' | 'web') => {
    const code = `code-${subject}`;

    identityForCode.set(code, {
      sub: subject,
      iss: ISSUER,
      email: syntheticTestUserEmail(`first-account-oidc-${subject}`, subject),
      name: subject,
    });

    const res = fakeResponse();
    const cookies: Record<string, string> = { oidc_state: 'state', oidc_pkce: 'verifier' };

    if (client === 'native') {
      cookies.oidc_client = 'native';
      // The app's binding, parked by `initiate` (see OidcController.initiate.test.ts).
      cookies.oidc_native_challenge = APP_CHALLENGE;
      cookies.oidc_native_state = APP_STATE;
    }

    await oidcController.callback(
      code,
      'state',
      undefined,
      { cookies, secure: false, headers: {} } as never,
      res as never,
    );

    return res;
  };

  /** Submit the "create account?" confirmation carrying the intent the web callback minted. */
  const confirmAccount = async (callbackResponse: FakeResponse) => {
    const intent = callbackResponse.cookie.mock.calls.find(([name]) => name === INTENT_COOKIE)?.[1] as string;

    expect(intent).toBeDefined();

    const res = fakeResponse();

    await oidcController.confirmAccount(
      { csrf: 'csrf' },
      { cookies: { [INTENT_COOKIE]: intent }, secure: false, headers: {} } as never,
      res as never,
    );

    return res;
  };

  // ── The decision the three doors share ─────────────────────────────────

  describe('UserService.createFirstAccount', () => {
    const firstAccount = (label: string) => {
      const id = uuidv7();

      return {
        id,
        name: `First-account spec ${label}`,
        email: syntheticTestUserEmail(`first-account-${label}`, id),
        password: `first-account-${id}`,
      };
    };

    it('asks again as it creates: an appliance claimed after the unlocked check is not claimed twice', async () => {
      // The exact interleaving the doors used to lose: "empty?" says yes, then another account is
      // created and committed, THEN this one would have been inserted.
      const answer = userService.hasNoUsers.bind(userService);
      let otherAccountCommitted!: () => void;
      const committed = new Promise<void>((resolve) => {
        otherAccountCommitted = resolve;
      });

      spies.push(
        jest.spyOn(userService, 'hasNoUsers').mockImplementation(async () => {
          const unclaimed = await answer();

          await committed;

          return unclaimed;
        }),
      );

      const claiming = userService.createFirstAccount(SYSTEM, firstAccount('late'));
      const other = await createAccount('invited');

      otherAccountCommitted();

      expect(await claiming).toBeNull();
      expect(await accounts()).toEqual([expect.objectContaining({ id: other.id, role: 'admin' })]);
    });

    it('rolls the account back with the work written alongside it', async () => {
      // A claim whose binding fails must leave nothing: an owner account with no binding is one its
      // own identity can no longer reach through the bearer path.
      await expect(
        userService.createFirstAccount(SYSTEM, firstAccount('unbound'), async (manager, user) => {
          await federatedIdentityService.bind(
            { userId: user.id, issuer: ISSUER, subject: 'unbound' },
            manager,
          );

          throw new Error('the rest of the claim failed');
        }),
      ).rejects.toThrow('the rest of the claim failed');

      expect(await accounts()).toEqual([]);
      expect(await bindings()).toEqual([]);

      // And the appliance is still there to be claimed.
      expect(await userService.createFirstAccount(SYSTEM, firstAccount('retry'))).toEqual(
        expect.objectContaining({ role: 'admin' }),
      );
    });

    it('returns the role it wrote: the first account admin, the next one not', async () => {
      // The promotion is read through a CTE; a bare UPDATE ... RETURNING resolves to the pair
      // [rows, rowCount], whose length read as "promoted" for every account.
      const owner = await userService.createFirstAccount(SYSTEM, firstAccount('owner'));
      const member = await createAccount('member');

      expect(owner?.role).toBe('admin');
      expect(member.role).toBe('user');
      expect(await accounts()).toEqual([
        expect.objectContaining({ id: owner!.id, role: 'admin' }),
        expect.objectContaining({ id: member.id, role: 'user' }),
      ]);
    });
  });

  // ── Portal bearer ───────────────────────────────────────────────────────

  describe('a Portal identity nobody here has bound (bearer)', () => {
    it('never claims an empty appliance, however many tokens arrive', async () => {
      // A bearer token used to create the first account, so whoever held any Portal token and
      // reached the box first became its owner. It creates nothing now.
      const results = await Promise.all([
        portalTokenService.verifyAndProvision(portalToken('racer-a', 'racer-a@example.invalid')),
        portalTokenService.verifyAndProvision(portalToken('racer-b', 'racer-b@example.invalid')),
      ]);

      expect(results).toEqual([null, null]);
      expect(await accounts()).toEqual([]);
      expect(await bindings()).toEqual([]);
    });
  });

  // ── Signup codes ────────────────────────────────────────────────────────

  describe('the first-account exemption from signup codes', () => {
    it('exempts exactly one of two first signups racing on an empty appliance', async () => {
      flags.add(SIGNUP_CODES);
      const race = forceRace(2);

      const settled = await Promise.allSettled([signup('alice'), signup('bob')]);

      const rejected = settled.filter((outcome) => outcome.status === 'rejected') as PromiseRejectedResult[];

      expect(race).toEqual(SERIALIZED);
      expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser is told what anyone arriving a moment later would be told.
      expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
      expect((rejected[0].reason as Error).message).toBe('Must provide a valid signup code');
      expect(await accounts()).toEqual([expect.objectContaining({ role: 'admin' })]);
    });
  });

  // ── OIDC sign-in ────────────────────────────────────────────────────────

  describe('a first-time OIDC sign-in', () => {
    it.each([
      ['off', 'signup_required'],
      ['on', 'signup_code_required'],
    ])(
      'native, signup codes %s: admits exactly one of two identities racing on an empty appliance',
      async (codes, refusal) => {
        if (codes === 'on') {
          flags.add(SIGNUP_CODES);
        }

        const race = forceRace(2);

        const responses = await Promise.all([
          oidcCallback('native-a', 'native'),
          oidcCallback('native-b', 'native'),
        ]);
        const destinations = responses.map(redirectedTo);
        const [owner] = await accounts();

        expect(race).toEqual(SERIALIZED);
        expect(destinations.filter((url) => url.includes('?code='))).toEqual([
          `companion://oidc/callback?code=one-time-${owner.id}&state=${APP_STATE}`,
        ]);
        // The same answer an unknown identity gets on a claimed appliance.
        expect(
          destinations.filter((url) => url.endsWith(`?error=${refusal}&state=${APP_STATE}`)),
        ).toHaveLength(1);
        expect(await accounts()).toEqual([expect.objectContaining({ role: 'admin' })]);
        expect(await bindings()).toEqual([expect.objectContaining({ user_id: owner.id })]);
      },
    );

    it('web, signup codes on: the confirm step refuses once someone else has claimed the appliance', async () => {
      // The callback's "unclaimed" is ten minutes old by the time the confirm page is submitted —
      // the life of the intent cookie. The confirm step has to decide again, when it creates.
      flags.add(SIGNUP_CODES);

      const callback = await oidcCallback('late-web', 'web');

      expect(redirectedTo(callback)).toBe('/api/authenticate/oidc/confirm-account');

      const owner = await createAccount('owner');
      const confirmed = await confirmAccount(callback);

      expect(redirectedTo(confirmed)).toBe('/login?error=signup_code_required');
      expect(await accounts()).toEqual([expect.objectContaining({ id: owner.id, role: 'admin' })]);
      expect(await bindings()).toEqual([]);
    });

    it('web, signup codes on: an empty appliance is still claimed through the confirm step', async () => {
      flags.add(SIGNUP_CODES);

      const callback = await oidcCallback('owner-web', 'web');
      const confirmed = await confirmAccount(callback);

      const [owner] = await accounts();

      expect(redirectedTo(confirmed)).toBe('/');
      expect(owner).toEqual(expect.objectContaining({ role: 'admin' }));
      expect(await bindings()).toEqual([
        expect.objectContaining({ user_id: owner.id, subject: 'owner-web' }),
      ]);
    });

    it('web, signup codes off: nothing was waived, so a claimed appliance still admits the confirm step', async () => {
      // With codes off the browser flow admits any Portal identity. Only the waiver an EMPTY
      // appliance grants is re-decided at confirm time; this must not start refusing everyone else.
      const callback = await oidcCallback('open-web', 'web');

      await createAccount('owner');

      const confirmed = await confirmAccount(callback);

      expect(redirectedTo(confirmed)).toBe('/');
      expect(await accounts()).toEqual([
        expect.objectContaining({ role: 'admin' }),
        expect.objectContaining({ role: 'user' }),
      ]);
    });
  });

  // ── Soft-deleted accounts ──────────────────────────────────────────────

  describe('an owner who deleted their account (soft-deleted, awaiting the purge)', () => {
    const softDeleteEveryone = () => dataSource.query(`UPDATE ci.users SET deleted_at = now()`);

    it('still counts: none of the doors reopens to an uninvited identity', async () => {
      // A soft-deleted account means someone claimed this box, and its data is still on disk until
      // the purge. Reopening uninvited signup would be a way back in; the gates stay shut.
      await createAccount('former-owner');
      await softDeleteEveryone();
      flags.add(SIGNUP_CODES);

      expect(
        await portalTokenService.verifyAndProvision(portalToken('stranger', 'stranger@example.invalid')),
      ).toBeNull();
      await expect(signup('stranger')).rejects.toThrow('Must provide a valid signup code');
      expect(redirectedTo(await oidcCallback('stranger-native', 'native'))).toMatch(
        /\?error=signup_code_required&state=s+$/,
      );
      expect((await accounts()).filter((account) => account.deleted_at == null)).toEqual([]);
    });

    it('does not let the next account created re-claim admin', async () => {
      // It used to: no LIVE admin read as "unowned", so whoever was admitted next became admin.
      // With members still on the box that let a member mint an invitation and sign up their own
      // administrator. The claim now asks what createFirstAccount asks, so a box whose owner is
      // awaiting the purge gets no new admin until an operator names one.
      await createAccount('former-owner');
      await softDeleteEveryone();

      const heir = await createAccount('heir');

      expect(heir.role).toBe('user');
      expect((await accounts()).find((account) => account.id === heir.id)?.role).toBe('user');
    });
  });
});

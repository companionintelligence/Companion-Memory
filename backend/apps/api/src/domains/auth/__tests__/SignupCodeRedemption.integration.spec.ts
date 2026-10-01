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
import { SignupCodeService } from '../services/SignupCodeService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One invitation, one person — raced against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A signup code used to be redeemed in three steps: look it up (`findOne`), create the account,
 * then mark the code used (`update`, itself a look-up followed by a write). Every request
 * presenting the same code between the first step and the last found it unused, so one invitation
 * admitted as many people as arrived together — through `SignupController.signup`, and through
 * `OidcController.callback` from the native app and the browser alike. Two neighbouring defects
 * went with it: the native path spent the code BEFORE creating the account, so a sign-in whose
 * account could not be created cost the owner an invitation and admitted nobody; and a
 * Hub-admitted sign-in that presented no code "burned" `undefined`, which TypeORM drops from a
 * `where` — spending whichever outstanding invitation the table returned first.
 *
 * Now the code is redeemed by one statement (`SignupCodeService.consume`), in the transaction that
 * creates the account it admits — or, for a browser sign-in, before the confirmation page.
 *
 * Each race forces the interleaving rather than hoping for it ({@link forceRace}): every racer
 * waits at the look-up until all have seen the code unused, and again at the redemption. Inside an
 * account's transaction the first racer there waits until every other one is seen QUEUED ON A LOCK
 * behind it — every account creation takes the claim lock — so a pass means the redemption was
 * serialized with the account it pays for, not that the racers merely happened to run one after the
 * other. The browser flow redeems outside any transaction; there every racer reaches the redemption
 * and they go on together, so the one statement alone decides. The row lock that statement takes is
 * exercised directly, with two transactions held open by hand.
 *
 * ── Why a database of its own ─────────────────────────────────────────────
 *
 * Signup codes are appliance-wide, and so is what decides whether one is needed at all: whether
 * the appliance has any account. Every case here empties `ci.signup_code` and `ci.users`, which on
 * a shared database would destroy the operator's real invitations and accounts. So this suite
 * replays every migration into a scratch database it creates and drops (see `scratchDatabase.ts`),
 * and SKIPS when there is no administrative connection to make one with — which is every `ci.yml`
 * run, by the cost decision that workflow documents. Run it with `DATABASE_ADMIN_PASSWORD` (or
 * `PIPELINE_TEST_ADMIN_DATABASE_URL`) set.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.
  console.warn(`[auth/SignupCodeRedemption.integration] SKIPPED — ${availability.reason}`);
}

// Replaying every migration takes a while; the cases themselves are quick.
jest.setTimeout(180_000);

const ISSUER = 'https://portal.signup-code.test';
const SYSTEM = { userId: SYSTEM_USER } as const;
const SIGNUP_CODES = 'require.signup.codes';
const INTENT_COOKIE = 'oidc_signup_intent';
const CONFIRM_PAGE = '/api/authenticate/oidc/confirm-account';
/** The request header the fake Hub bridge reads a verified forward-auth username from. */
const HUB_USER_HEADER = 'x-spec-hub-user';

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

const mintedIntent = (res: FakeResponse) => res.cookie.mock.calls.some(([name]) => name === INTENT_COOKIE);

/** Where {@link forceRace} found the racers. */
interface RaceLineUp {
  /** The look-up (`findOne`): had every racer seen the code unused before any went on? */
  codeCheck: 'waiting' | 'all answered' | 'gave up';
  /**
   * The redemption (`consume`), as the first racer there found the rest: there too — only possible
   * where nothing serializes them — or queued on a lock behind it.
   */
  redemption: 'waiting' | 'all arrived' | 'the others queued on a lock' | 'gave up';
}

/** A race serialized with the transactions creating the accounts. */
const SERIALIZED: RaceLineUp = { codeCheck: 'all answered', redemption: 'the others queued on a lock' };

const quietLogger = () => ({
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
});

describeWithDatabase(`signup-code redemption, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;

  let userService: UserService;
  let signupCodeService: SignupCodeService;
  let signupController: SignupController;
  let oidcController: OidcController;

  /** Feature flags switched on for the current case. */
  const flags = new Set<string>();

  /** Spies a case installs on the services under test, removed after it. */
  const spies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    // Unset by default, and callback() refuses to run without it.
    config.auth.oidc.issuerUrl = 'http://localhost:8506';

    scratch = await ScratchDatabase.create({ createdBy: 'auth/SignupCodeRedemption.integration.spec' });

    await scratch.assertOwn();

    // The scratch handle maps no entities; the services under test go through repositories.
    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      entities: [UserEntity, FederatedIdentityEntity, SignupCodeEntity],
    } as DataSourceOptions);
    await dataSource.initialize();

    // Nothing observing UserCreated is under test, and no listener may run against this database.
    userService = new UserService(dataSource.getRepository(UserEntity), { send: async () => [] } as never);
    signupCodeService = new SignupCodeService(dataSource.getRepository(SignupCodeEntity));

    const federatedIdentityService = new FederatedIdentityService(
      dataSource.getRepository(FederatedIdentityEntity),
      quietLogger() as never,
    );
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
    const hubBridge = {
      verifyUsername: (req: { headers: Record<string, string | undefined> }) =>
        req.headers[HUB_USER_HEADER] ?? null,
    };

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
      hubBridge as never,
      quietLogger() as never,
    );
  });

  afterEach(async () => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    flags.clear();
    identityForCode.clear();

    // The guard first: this empties appliance-wide tables, which is only ever acceptable in a
    // database this run made.
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

  /**
   * Sessions in this (scratch) database waiting on a lock another transaction holds — of the given
   * kinds (`pg_stat_activity.wait_event`), or of any kind. A row lock is waited on as `transactionid`
   * (the holder's transaction) or, queued behind another waiter, `tuple`; the claim lock as
   * `advisory`.
   */
  const waitingOnLocks = async (kinds: string[] | null = null): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS waiting
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND ($1::text[] IS NULL OR wait_event = ANY ($1::text[]))`,
      [kinds],
    )) as Array<{ waiting: number }>;

    return row.waiting;
  };

  const waitingOnRowLocks = () => waitingOnLocks(['transactionid', 'tuple']);

  /** Resolve once `condition` holds; fail the case if it never does. */
  const eventually = async (condition: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + RENDEZVOUS_BOUND_MS;

    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(`gave up waiting for ${what}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Hold the first `count` arrivals until the last of them arrives, or the bound runs out. */
  const rendezvous = (count: number, onAllArrived: () => void, onGiveUp: () => void) => {
    let arrived = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const giveUp = setTimeout(() => {
      onGiveUp();
      release();
    }, RENDEZVOUS_BOUND_MS);

    giveUp.unref();

    return async (): Promise<void> => {
      if (arrived >= count) {
        return;
      }

      arrived += 1;

      if (arrived === count) {
        clearTimeout(giveUp);
        onAllArrived();
        release();
      }

      await released;
    };
  };

  /**
   * Line `racers` requests presenting the same code up at BOTH places a check-then-act race hides,
   * instead of trusting bcrypt's timing to overlap them:
   *
   *  1. The look-up (`findOne`). Every racer gets its answer before any goes on, so all of them have
   *     seen the code unused — the interleaving that let one invitation admit two people while that
   *     answer was the one acted on.
   *  2. The redemption (`consume`). The first racer there waits until every other one is there too,
   *     or QUEUED ON A LOCK — inside an account's transaction, the claim lock every account creation
   *     takes, which holds the rest back until this racer's account and redemption have committed or
   *     rolled back. {@link RaceLineUp.redemption} records which, so a pass means "serialized" and
   *     not "happened not to overlap".
   *
   * Both are bounded, so a path that never reaches one fails its assertion instead of hanging.
   */
  const forceRace = (racers: number) => {
    const lineUp: RaceLineUp = { codeCheck: 'waiting', redemption: 'waiting' };

    // ── 1. the look-up ──
    const lookUp = signupCodeService.findOne.bind(signupCodeService);
    const atLookUp = rendezvous(
      racers,
      () => (lineUp.codeCheck = 'all answered'),
      () => (lineUp.codeCheck = 'gave up'),
    );

    spies.push(
      jest.spyOn(signupCodeService, 'findOne').mockImplementation(async (code) => {
        const found = await lookUp(code);

        await atLookUp();

        return found;
      }),
    );

    // ── 2. the redemption ──
    const redeem = signupCodeService.consume.bind(signupCodeService);
    let atRedemption = 0;

    spies.push(
      jest.spyOn(signupCodeService, 'consume').mockImplementation(async (code, manager?: EntityManager) => {
        if (lineUp.redemption === 'waiting') {
          atRedemption += 1;

          const deadline = Date.now() + RENDEZVOUS_BOUND_MS;

          while (lineUp.redemption === 'waiting') {
            const queued = await waitingOnLocks();

            // Counted AFTER the query, and only acted on if no other racer settled it meanwhile: a
            // racer can arrive while the query runs, and "0 queued of 0 still elsewhere" is not
            // serialization.
            const elsewhere = racers - atRedemption;

            if (lineUp.redemption !== 'waiting') {
              break;
            }

            if (elsewhere <= 0) {
              lineUp.redemption = 'all arrived';
            } else if (queued >= elsewhere) {
              lineUp.redemption = 'the others queued on a lock';
            } else if (Date.now() > deadline) {
              lineUp.redemption = 'gave up';
            } else {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
        }

        return redeem(code, manager);
      }),
    );

    return lineUp;
  };

  const accounts = async () =>
    (await dataSource.query(`SELECT id, email FROM ci.users ORDER BY created_at, id`)) as Array<{
      id: string;
      email: string;
    }>;

  const codes = async () =>
    (await dataSource.query(
      `SELECT signup_code, used FROM ci.signup_code ORDER BY created_at, id`,
    )) as Array<{
      signup_code: string;
      used: boolean;
    }>;

  const newAccount = (label: string, email?: string) => {
    const id = uuidv7();

    return {
      id,
      name: `Signup-code spec ${label}`,
      email: email ?? syntheticTestUserEmail(`signup-code-${label}`, id),
      password: `signup-code-${id}`,
    };
  };

  /** An account through the ordinary `create()`, as any door that needs no code adds one. */
  const createAccount = (label: string, email?: string) =>
    userService.create(SYSTEM, newAccount(label, email));

  /** An appliance someone has claimed, where a new account needs an invitation. Returns its owner. */
  const claimedWithCodesRequired = async () => {
    const owner = await createAccount('owner');

    flags.add(SIGNUP_CODES);

    return owner;
  };

  /** Accounts other than the owner's. */
  const admitted = async (owner: { id: string }) =>
    (await accounts()).filter((account) => account.id !== owner.id);

  const signup = (label: string, signupCode?: string, email?: string) =>
    signupController.signup({ secure: false, headers: {}, cookies: {} } as never, fakeResponse() as never, {
      name: `Signup ${label}`,
      email: email ?? syntheticTestUserEmail(`signup-code-signup-${label}`, uuidv7()),
      password: `signup-${label}-password`,
      signup_code: signupCode,
    });

  /** Run the OIDC callback for `subject`, as the native app (deep link) or the browser. */
  const oidcCallback = async (
    subject: string,
    client: 'native' | 'web',
    { signupCode, hubUser }: { signupCode?: string; hubUser?: string } = {},
  ) => {
    const code = `code-${subject}`;

    identityForCode.set(code, {
      sub: subject,
      iss: ISSUER,
      email: syntheticTestUserEmail(`signup-code-oidc-${subject}`, subject),
      name: subject,
    });

    const res = fakeResponse();
    const cookies: Record<string, string> = { oidc_state: 'state', oidc_pkce: 'verifier' };

    if (client === 'native') {
      cookies.oidc_client = 'native';
    }

    // Parked by `initiate`, from an invite link.
    if (signupCode != null) {
      cookies.oidc_signup_code = signupCode;
    }

    await oidcController.callback(
      code,
      'state',
      undefined,
      { cookies, secure: false, headers: hubUser == null ? {} : { [HUB_USER_HEADER]: hubUser } } as never,
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

  // ── The redemption every door shares ───────────────────────────────────

  describe('SignupCodeService.consume', () => {
    it('redeems a code once: the first call gets it, every later one does not', async () => {
      // Read through a CTE: a bare UPDATE ... RETURNING resolves to the pair [rows, rowCount], whose
      // length would tell every caller it had redeemed the code.
      const { signup_code: code } = await signupCodeService.create();

      expect(await signupCodeService.consume(code)).toBe(true);
      expect(await signupCodeService.consume(code)).toBe(false);
      expect(await codes()).toEqual([{ signup_code: code, used: true }]);
    });

    it('redeems nothing for a code that is not an invitation, and spends no other', async () => {
      const { signup_code: outstanding } = await signupCodeService.create();

      expect(await signupCodeService.consume('not-an-invitation')).toBe(false);
      expect(await codes()).toEqual([{ signup_code: outstanding, used: false }]);
    });

    it.each([
      ['commits', false],
      ['rolls back', true],
    ])(
      'makes a concurrent redemption wait for this one; when this one %s, the other gets the code: %s',
      async (outcome, otherRedeems) => {
        const { signup_code: code } = await signupCodeService.create();
        const first = dataSource.createQueryRunner();
        const second = dataSource.createQueryRunner();

        try {
          await first.startTransaction();
          await second.startTransaction();

          expect(await signupCodeService.consume(code, first.manager)).toBe(true);

          const secondRedemption = signupCodeService.consume(code, second.manager);

          await eventually(async () => (await waitingOnRowLocks()) === 1, 'the second redemption to queue');

          if (outcome === 'commits') {
            await first.commitTransaction();
          } else {
            await first.rollbackTransaction();
          }

          expect(await secondRedemption).toBe(otherRedeems);

          await second.commitTransaction();
        } finally {
          // A case that failed part-way must not hand the pool a connection mid-transaction. First
          // before second: rolling the first back is what releases a second still queued behind it.
          for (const runner of [first, second]) {
            if (runner.isTransactionActive) {
              await runner.rollbackTransaction();
            }

            await runner.release();
          }
        }

        expect(await codes()).toEqual([{ signup_code: code, used: true }]);
      },
    );

    it('is undone with the account it was redeemed for', async () => {
      const { signup_code: code } = await signupCodeService.create();

      await expect(
        userService.create(SYSTEM, newAccount('rolled-back'), async (manager) => {
          expect(await signupCodeService.consume(code, manager)).toBe(true);

          throw new Error('the rest of the signup failed');
        }),
      ).rejects.toThrow('the rest of the signup failed');

      expect(await accounts()).toEqual([]);
      expect(await codes()).toEqual([{ signup_code: code, used: false }]);
      // Still an invitation, for the next try.
      expect(await signupCodeService.consume(code)).toBe(true);
    });
  });

  // ── Password signup ─────────────────────────────────────────────────────

  describe('SignupController.signup, with codes required', () => {
    it('admits exactly one of three signups presenting the same code', async () => {
      const owner = await claimedWithCodesRequired();
      const { signup_code: code } = await signupCodeService.create();
      const race = forceRace(3);

      const settled = await Promise.allSettled([
        signup('alice', code),
        signup('bob', code),
        signup('carol', code),
      ]);
      const refused = settled.filter((outcome) => outcome.status === 'rejected') as PromiseRejectedResult[];

      expect(race).toEqual(SERIALIZED);
      expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      // Told what anyone presenting a used code is told.
      expect(refused.map((outcome) => outcome.reason)).toEqual([
        expect.any(BadRequestException),
        expect.any(BadRequestException),
      ]);
      expect(refused.map((outcome) => (outcome.reason as Error).message)).toEqual([
        'Must provide a valid signup code',
        'Must provide a valid signup code',
      ]);
      // The refused signups' account rows, written before they lost, are rolled back.
      expect(await admitted(owner)).toHaveLength(1);
      expect(await codes()).toEqual([{ signup_code: code, used: true }]);
    });

    it('leaves the code unspent when the account cannot be created, for the next signup to use', async () => {
      const owner = await claimedWithCodesRequired();
      const { signup_code: code } = await signupCodeService.create();
      const email = syntheticTestUserEmail('signup-code-taken', uuidv7());
      const isTaken = userService.checkEmailAvailability.bind(userService);

      // Somebody else takes the address between this signup's check and its INSERT.
      spies.push(
        jest.spyOn(userService, 'checkEmailAvailability').mockImplementationOnce(async (address) => {
          const taken = await isTaken(address);

          await createAccount('same-address', address);

          return taken;
        }),
      );

      await expect(signup('late', code, email)).rejects.toThrow(/duplicate key/);

      expect(await codes()).toEqual([{ signup_code: code, used: false }]);

      await signup('next', code);

      expect((await admitted(owner)).map((account) => account.email)).toEqual([
        email,
        expect.stringMatching(/^signup-code-signup-next-/),
      ]);
      expect(await codes()).toEqual([{ signup_code: code, used: true }]);
    });
  });

  // ── OIDC sign-in ────────────────────────────────────────────────────────

  describe('OidcController.callback, with codes required', () => {
    it('native: admits exactly one of two sign-ins presenting the same code', async () => {
      const owner = await claimedWithCodesRequired();
      const { signup_code: code } = await signupCodeService.create();
      const race = forceRace(2);

      const responses = await Promise.all([
        oidcCallback('native-a', 'native', { signupCode: code }),
        oidcCallback('native-b', 'native', { signupCode: code }),
      ]);
      const destinations = responses.map(redirectedTo);
      const [invited] = await admitted(owner);

      expect(race).toEqual(SERIALIZED);
      expect(destinations.filter((url) => url.includes('?code='))).toEqual([
        `companion://oidc/callback?code=one-time-${invited.id}`,
      ]);
      // What a sign-in presenting a used code is told.
      expect(destinations.filter((url) => url.endsWith('?error=signup_code_required'))).toHaveLength(1);
      expect(await admitted(owner)).toHaveLength(1);
      expect(await codes()).toEqual([{ signup_code: code, used: true }]);
    });

    it('web: sends exactly one of two sign-ins presenting the same code on to the confirmation', async () => {
      // The browser flow redeems at the callback, before the confirmation page — outside any account
      // transaction, so nothing holds the racers apart there: they arrive together, and the one
      // statement decides.
      const owner = await claimedWithCodesRequired();
      const { signup_code: code } = await signupCodeService.create();
      const race = forceRace(2);

      const responses = await Promise.all([
        oidcCallback('web-a', 'web', { signupCode: code }),
        oidcCallback('web-b', 'web', { signupCode: code }),
      ]);
      const winner = responses.find((res) => redirectedTo(res) === CONFIRM_PAGE);
      const loser = responses.find((res) => res !== winner);

      expect(race).toEqual({ codeCheck: 'all answered', redemption: 'all arrived' });
      expect(winner).toBeDefined();
      expect(redirectedTo(loser!)).toBe('/login?error=signup_code_required');
      expect(mintedIntent(loser!)).toBe(false);
      expect(await codes()).toEqual([{ signup_code: code, used: true }]);

      expect(redirectedTo(await confirmAccount(winner!))).toBe('/');
      expect(await admitted(owner)).toHaveLength(1);
    });

    it('native: leaves the code unspent when the account cannot be created', async () => {
      // Spending it first — as this path did — cost the owner an invitation and admitted nobody.
      await claimedWithCodesRequired();
      const { signup_code: code } = await signupCodeService.create();
      const findByEmail = userService.findByEmail.bind(userService);

      // Somebody else takes the address between this sign-in's look-up and its INSERT.
      spies.push(
        jest.spyOn(userService, 'findByEmail').mockImplementationOnce(async (address) => {
          const existing = await findByEmail(address);

          await createAccount('same-address', address);

          return existing;
        }),
      );

      const res = await oidcCallback('native-late', 'native', { signupCode: code });

      expect(redirectedTo(res)).toBe('companion://oidc/callback?error=oidc_failed');
      expect(await codes()).toEqual([{ signup_code: code, used: false }]);
    });

    it('a Hub-admitted sign-in spends no invitation: neither an outstanding one nor one it presents', async () => {
      // The Hub is what admits this person. Presenting no code used to "burn" `undefined`, which
      // TypeORM drops from a `where`, spending whichever outstanding invitation came back first.
      const owner = await claimedWithCodesRequired();
      const { signup_code: outstanding } = await signupCodeService.create();

      expect(redirectedTo(await oidcCallback('hub-member', 'web', { hubUser: 'hub-member' }))).toBe('/');
      expect(await codes()).toEqual([{ signup_code: outstanding, used: false }]);

      // Nothing rests on a code the Hub makes unnecessary, so it is left for whoever it was meant for
      // — as a password signup leaves a code it did not need.
      expect(
        redirectedTo(
          await oidcCallback('hub-member-2', 'native', { hubUser: 'hub-member-2', signupCode: outstanding }),
        ),
      ).toMatch(/^companion:\/\/oidc\/callback\?code=/);
      expect(await codes()).toEqual([{ signup_code: outstanding, used: false }]);
      expect(await admitted(owner)).toHaveLength(2);
    });
  });
});

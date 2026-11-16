import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import { UserEntity, UserService } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { SessionEntity } from '../entities/SessionEntity';
import { AuthService } from '../services/AuthService';

/**
 * Session refresh against real Postgres: two refreshes that arrive together and a refresh whose
 * answer never reached the browser.
 *
 * Every refresh replaces the session token. Two refreshes of one session at the same moment both
 * used to replace it, so one of the two new cookies matched nothing at once. And a browser that
 * never read a refresh's answer kept the replaced token, which got no new cookie inside the grace
 * window and 401 after it, signing the browser out at its next refresh a few minutes later.
 *
 * Run it with `make test-db ARGS=src/domains/auth/__tests__/SessionRotation.integration.spec.ts`
 * (or with `PIPELINE_TEST_ADMIN_DATABASE_URL` set); it makes, migrates and drops its own database.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.
  console.warn(`[auth/SessionRotation.integration] SKIPPED — ${availability.reason}`);
}

// Creating the scratch database applies every migration, which takes minutes on a loaded machine.
jest.setTimeout(600_000);

const BROWSER = { ip: '127.0.0.1', userAgent: 'Chrome/146' };
const MINUTE = 60_000;

/** Wait until just after the next second starts: a session signed twice inside one second gets the same token. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1050 - (Date.now() % 1000)));

/** Wait until `msBefore` before the next second starts, so two signings land on both sides of it. */
const justBeforeNextSecond = (msBefore: number) =>
  new Promise((resolve) => setTimeout(resolve, (2000 - msBefore - (Date.now() % 1000)) % 1000));

/** Run `fn` with the wall clock `msAgo` in the past. Only `Date` is faked; timers and Postgres run as usual. */
async function asIf<T>(msAgo: number, fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({
    now: Date.now() - msAgo,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });

  try {
    return await fn();
  } finally {
    jest.useRealTimers();
  }
}

describeWithDatabase(`Session refresh, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let authService: AuthService;
  let userId: string;
  let otherUserId: string;

  const refresh = (token: string, meta = BROWSER, user = userId) =>
    authService.rotateSessionToken(user, token, meta);

  /** What a refresh ended in: the cookie it set (null for none), or 401. */
  const outcome = async (token: string, meta = BROWSER, user = userId): Promise<string | null | 401> => {
    try {
      return (await refresh(token, meta, user)).sessionToken;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        return 401;
      }

      throw error;
    }
  };

  /** Sign in, wait for the next second, refresh once: the session now holds a current and a previous token. */
  const signInAndRefresh = async (signInMsAgo = 0, refreshMsAgo = 0) => {
    const issued = await asIf(signInMsAgo, () => authService.issueSessionToken(userId, BROWSER));
    await nextSecond();
    const rotated = await asIf(refreshMsAgo, () => refresh(issued.sessionToken));

    expect(rotated.sessionToken).not.toBeNull();
    expect(rotated.sessionToken).not.toBe(issued.sessionToken);

    return { sessionId: issued.sessionId, previous: issued.sessionToken, current: rotated.sessionToken! };
  };

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'auth/SessionRotation.integration.spec' });
    await scratch.assertOwn();

    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      entities: [UserEntity, SessionEntity],
    } as DataSourceOptions);
    await dataSource.initialize();

    authService = new AuthService(new JwtService({}), dataSource.getRepository(SessionEntity));

    // Nothing observing UserCreated is under test. No listener may run against this database.
    const userService = new UserService(dataSource.getRepository(UserEntity), {
      send: async () => [],
    } as never);
    userId = (
      await userService.create(
        { userId: SYSTEM_USER },
        { name: 'owner', email: 'owner@example.com', password: 'irrelevant-1' },
      )
    ).id;
    otherUserId = (
      await userService.create(
        { userId: SYSTEM_USER },
        { name: 'member', email: 'member@example.com', password: 'irrelevant-2' },
      )
    ).id;
  });

  afterEach(async () => {
    jest.useRealTimers();
    // The guard first: this empties ci.sessions, only ever acceptable in a database this run made.
    await scratch.assertOwn();
    await dataSource.query('DELETE FROM ci.sessions');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await scratch?.drop();
  });

  describe('a refresh with the current token', () => {
    it('replaces it with a new token that is the one to refresh next', async () => {
      const { previous, current } = await signInAndRefresh();
      await nextSecond();

      const next = await outcome(current);

      expect(typeof next).toBe('string');
      expect(next).not.toBe(current);
      // Two rotations on, the sign-in token matches nothing.
      expect(await outcome(previous)).toBe(401);
    });

    it('is refused from another address or browser', async () => {
      const { current } = await signInAndRefresh();

      expect(await outcome(current, { ip: '10.0.0.7', userAgent: 'Chrome/146' })).toBe(401);
      expect(await outcome(current, { ip: '127.0.0.1', userAgent: 'Chrome/147' })).toBe(401);
    });
  });

  describe('a refresh with the previous token (the answer to the last refresh never arrived)', () => {
    it('answers with the current token, byte for byte, without replacing it', async () => {
      const { previous, current } = await signInAndRefresh();

      expect(await outcome(previous)).toBe(current);
      // Still the current token: the re-sent cookie refreshes as usual.
      await nextSecond();
      expect(typeof (await outcome(current))).toBe('string');
    });

    it('still answers with it 90 seconds later, past the app request deadline and a few retries', async () => {
      const { previous, current } = await signInAndRefresh(1.5 * MINUTE + 5_000, 1.5 * MINUTE);

      expect(await outcome(previous)).toBe(current);
    });

    it('is refused once the grace window has passed', async () => {
      const { previous, current } = await signInAndRefresh(2.5 * MINUTE + 5_000, 2.5 * MINUTE);

      expect(await outcome(previous)).toBe(401);
      // Whoever holds the current token is unaffected.
      expect(typeof (await outcome(current))).toBe('string');
    });

    it('is refused once the current token has been used, however soon', async () => {
      const { previous, current } = await signInAndRefresh();
      await nextSecond();
      const next = await outcome(current);
      expect(typeof next).toBe('string');

      expect(await outcome(previous)).toBe(401);
      // The token just replaced is now the previous one. It gets the newest token back.
      expect(await outcome(current)).toBe(next);
    });

    it('is refused from another address or browser', async () => {
      const { previous } = await signInAndRefresh();

      expect(await outcome(previous, { ip: '10.0.0.7', userAgent: 'Chrome/146' })).toBe(401);
      expect(await outcome(previous, { ip: '127.0.0.1', userAgent: 'Chrome/147' })).toBe(401);
    });

    it('gets no cookie when the current token cannot be signed again exactly', async () => {
      // A session rotated before rotation recorded the signing second (or under another secret):
      // the token rebuilt from rotated_at does not hash to the stored one, so nothing is sent rather
      // than a token the server does not hold.
      const { sessionId, previous } = await signInAndRefresh();
      await dataSource.query(
        `UPDATE ci.sessions SET rotated_at = rotated_at - interval '2 seconds' WHERE id = $1`,
        [sessionId],
      );

      expect(await outcome(previous)).toBeNull();
    });
  });

  describe('tokens that must stay dead', () => {
    it("refuses another person's token", async () => {
      const mine = await signInAndRefresh();
      const theirs = await authService.issueSessionToken(otherUserId, BROWSER);

      expect(await outcome(theirs.sessionToken, BROWSER, userId)).toBe(401);
      expect(await outcome(mine.current, BROWSER, otherUserId)).toBe(401);
      expect(await outcome(mine.previous, BROWSER, otherUserId)).toBe(401);
    });

    it('refuses both tokens of a signed-out session', async () => {
      const { sessionId, previous, current } = await signInAndRefresh();
      // What sign-out does to the row.
      await dataSource.query('DELETE FROM ci.sessions WHERE id = $1', [sessionId]);

      expect(await outcome(current)).toBe(401);
      expect(await outcome(previous)).toBe(401);
    });

    it('refuses both tokens of a session another device signed out with a password change', async () => {
      const { previous, current } = await signInAndRefresh();
      const changedPasswordIn = await authService.issueSessionToken(userId, BROWSER);
      await authService.invalidateOtherSessions(userId, changedPasswordIn.sessionToken);

      expect(await outcome(current)).toBe(401);
      expect(await outcome(previous)).toBe(401);
    });

    it('refuses the previous token of the session that changed the password, inside the window', async () => {
      // A copy of the cookie from before this browser's last refresh would otherwise get the
      // current token back and outlive the password change or "Sign out everywhere".
      const { sessionId, previous, current } = await signInAndRefresh();
      await authService.invalidateOtherSessions(userId, current);

      expect(await outcome(previous)).toBe(401);
      // The browser that made the change stays signed in with the token it holds.
      await nextSecond();
      expect(typeof (await outcome(current))).toBe('string');
      expect(
        await dataSource.query<Array<{ id: string }>>('SELECT id FROM ci.sessions WHERE id = $1', [
          sessionId,
        ]),
      ).toHaveLength(1);
    });

    it('does not bring back a session that a sign-out racing the refresh ended', async () => {
      // An unconditional save of the row the refresh read inserts it again when a sign-out deleted it
      // in between. The conditional update finds no row and the refresh is refused instead.
      for (let trial = 0; trial < 20; trial++) {
        const { sessionId, current } = await signInAndRefresh();
        await nextSecond();

        const [refreshed] = await Promise.allSettled([
          refresh(current),
          dataSource.query('DELETE FROM ci.sessions WHERE id = $1', [sessionId]),
        ]);

        const rows = await dataSource.query<Array<{ id: string }>>(
          'SELECT id FROM ci.sessions WHERE id = $1',
          [sessionId],
        );
        expect(rows).toEqual([]);

        if (refreshed.status === 'fulfilled' && refreshed.value.sessionToken) {
          expect(await outcome(refreshed.value.sessionToken)).toBe(401);
        }
      }
    });
  });

  describe('two refreshes of one session at the same moment', () => {
    it('both answer with the current token, the same one', async () => {
      const trials = 40;
      const different: number[] = [];

      for (let trial = 0; trial < trials; trial++) {
        // Signed in seconds ago, so neither rotation can sign the sign-in token again.
        const issued = await asIf(5_000, () => authService.issueSessionToken(userId, BROWSER));
        // Aimed at a second boundary, a few milliseconds earlier each time to cover the session lookup
        // before the signing: two rotations that sign on both sides of it sign different tokens.
        await justBeforeNextSecond(trial % 10);

        const [a, b] = await Promise.all([refresh(issued.sessionToken), refresh(issued.sessionToken)]);

        if (a.sessionToken !== b.sessionToken) {
          different.push(trial);
        }

        // The cookie both answers set is the current token: it refreshes rather than getting a 401.
        const next = await outcome(a.sessionToken ?? b.sessionToken!);
        expect(typeof next).toBe('string');

        await scratch.assertOwn();
        await dataSource.query('DELETE FROM ci.sessions');
      }

      expect(different).toEqual([]);
    });

    it('also with three at once', async () => {
      for (let trial = 0; trial < 10; trial++) {
        const issued = await asIf(5_000, () => authService.issueSessionToken(userId, BROWSER));
        await justBeforeNextSecond(trial % 10);

        const results = await Promise.all([1, 2, 3].map(() => refresh(issued.sessionToken)));
        const tokens = new Set(results.map((r) => r.sessionToken));

        expect(tokens.size).toBe(1);
        expect([...tokens][0]).not.toBeNull();

        await scratch.assertOwn();
        await dataSource.query('DELETE FROM ci.sessions');
      }
    });
  });
});

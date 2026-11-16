import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import { UserEntity, UserService } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { SessionEntity } from '../entities/SessionEntity';
import { AuthService } from '../services/AuthService';

/**
 * Sign-out against real Postgres: which sessions a sign-out ends and which it must leave alone.
 *
 * A session is bound to the address and user agent it was signed in from. Refresh still checks
 * both. Sign-out used to check them too, so a browser that updated, or a laptop that moved to another
 * network, got 401 "Invalid session" and the session stayed refreshable for the rest of its week.
 * Sign-out now ends the session its cookie belongs to from anywhere. It ends only that one.
 *
 * Run it with `make test-db ARGS=src/domains/auth/__tests__/SessionSignOut.integration.spec.ts`
 * (or with `PIPELINE_TEST_ADMIN_DATABASE_URL` set); it makes, migrates and drops its own database.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.
  console.warn(`[auth/SessionSignOut.integration] SKIPPED: ${availability.reason}`);
}

// Creating the scratch database applies every migration, which takes minutes on a loaded machine.
jest.setTimeout(600_000);

const SIGNED_IN = { ip: '127.0.0.1', userAgent: 'Chrome/146' };
const UPDATED_BROWSER = { ip: '127.0.0.1', userAgent: 'Chrome/147' };
const OTHER_ADDRESS = { ip: '10.0.0.7', userAgent: 'Chrome/146' };

/** A second has to pass between two signings of one session, or the second token is the first, byte for byte. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100 - (Date.now() % 1000)));

describeWithDatabase(`Sign-out, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let authService: AuthService;
  let userId: string;
  let otherUserId: string;

  const sessionIds = async (): Promise<string[]> =>
    (await dataSource.query<Array<{ id: string }>>('SELECT id FROM ci.sessions ORDER BY id')).map(
      (r) => r.id,
    );

  /** Sign in, then refresh once, so the session holds a current token and a previous one. */
  const signInAndRotate = async () => {
    const issued = await authService.issueSessionToken(userId, SIGNED_IN);
    await nextSecond();
    const rotated = await authService.rotateSessionToken(userId, issued.sessionToken, SIGNED_IN);

    return { sessionId: issued.sessionId, previous: issued.sessionToken, current: rotated.sessionToken! };
  };

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'auth/SessionSignOut.integration.spec' });
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

  it('ends the session for its current token, with no address or browser to match', async () => {
    const { sessionId, current } = await signInAndRotate();

    // Sign-out takes no request metadata at all: what the browser looks like now cannot stop it.
    await expect(authService.invalidateSession(userId, current)).resolves.toBe(true);

    expect(await sessionIds()).not.toContain(sessionId);
    // The cookie the browser held at sign-out no longer refreshes, from where it was signed in either.
    await expect(authService.rotateSessionToken(userId, current, SIGNED_IN)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('ends the session for its previous token inside the rotation grace window', async () => {
    // The answer to the last refresh never arrived, so the browser signs out with the token it replaced.
    const { sessionId, previous, current } = await signInAndRotate();

    await expect(authService.invalidateSession(userId, previous)).resolves.toBe(true);

    expect(await sessionIds()).not.toContain(sessionId);
    await expect(authService.rotateSessionToken(userId, current, SIGNED_IN)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('leaves the session alone for a previous token whose grace window has passed', async () => {
    const { sessionId, previous, current } = await signInAndRotate();
    await dataSource.query(`UPDATE ci.sessions SET rotated_at = now() - interval '1 day' WHERE id = $1`, [
      sessionId,
    ]);

    await expect(authService.invalidateSession(userId, previous)).resolves.toBe(false);

    // Whoever holds the current token is still signed in: a stale cookie cannot end the session.
    expect(await sessionIds()).toEqual([sessionId]);
    await expect(authService.rotateSessionToken(userId, current, SIGNED_IN)).resolves.toMatchObject({
      sessionId,
    });
  });

  it("does not end another person's session", async () => {
    const theirs = await authService.issueSessionToken(otherUserId, SIGNED_IN);
    const mine = await authService.issueSessionToken(userId, SIGNED_IN);

    // Their token, under my user id (a token names its user, so this is a hash that matches their row only).
    await expect(authService.invalidateSession(userId, theirs.sessionToken)).resolves.toBe(false);
    // My token, under their user id.
    await expect(authService.invalidateSession(otherUserId, mine.sessionToken)).resolves.toBe(false);

    expect(await sessionIds()).toEqual([mine.sessionId, theirs.sessionId].sort());
  });

  it('ends only the session the token belongs to, not the same person in another browser', async () => {
    const here = await authService.issueSessionToken(userId, SIGNED_IN);
    const elsewhere = await authService.issueSessionToken(userId, OTHER_ADDRESS);

    await expect(authService.invalidateSession(userId, here.sessionToken)).resolves.toBe(true);

    expect(await sessionIds()).toEqual([elsewhere.sessionId]);
  });

  it('finds nothing to end for a session that is already gone', async () => {
    const signedOut = await authService.issueSessionToken(userId, SIGNED_IN);
    await authService.invalidateSession(userId, signedOut.sessionToken);
    // Signed out on every other device by a password change made in another session.
    const revoked = await authService.issueSessionToken(userId, SIGNED_IN);
    const changedPasswordIn = await authService.issueSessionToken(userId, OTHER_ADDRESS);
    await authService.invalidateOtherSessions(userId, changedPasswordIn.sessionToken);
    // Expired.
    const expired = await authService.issueSessionToken(userId, SIGNED_IN);
    await dataSource.query(`UPDATE ci.sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      expired.sessionId,
    ]);

    await expect(authService.invalidateSession(userId, signedOut.sessionToken)).resolves.toBe(false);
    await expect(authService.invalidateSession(userId, revoked.sessionToken)).resolves.toBe(false);
    await expect(authService.invalidateSession(userId, expired.sessionToken)).resolves.toBe(false);

    expect(await sessionIds()).toEqual([changedPasswordIn.sessionId, expired.sessionId].sort());
  });

  it('still refuses a refresh from another address or browser', async () => {
    const { current } = await signInAndRotate();

    for (const meta of [UPDATED_BROWSER, OTHER_ADDRESS]) {
      await expect(authService.rotateSessionToken(userId, current, meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });
});

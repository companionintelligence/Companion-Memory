import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource, type DataSourceOptions, TypeORMError } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import { UserEntity, UserService } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { SessionEntity } from '../entities/SessionEntity';
import { AuthService } from '../services/AuthService';

/**
 * A session's client binding, against real Postgres.
 *
 * Refresh and logout find a session by its token AND the hashed address and user agent it was issued
 * for. A request can arrive without one of those (no User-Agent header, say), and TypeORM 1.x refuses
 * an undefined where-value outright, so `findSession` asks for IS NULL instead: such a request matches
 * only a session issued without the value. What the unit tests cannot show is that the SQL TypeORM
 * builds for that finds the row such a session really stores, and that nothing on the way throws.
 *
 * Run it with `make test-db ARGS=src/domains/auth/__tests__/SessionMetadataBinding.integration.spec.ts`
 * (or with `PIPELINE_TEST_ADMIN_DATABASE_URL` set); it makes, migrates and drops its own database.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.
  console.warn(`[auth/SessionMetadataBinding.integration] SKIPPED — ${availability.reason}`);
}

// Creating the scratch database applies every migration, which takes minutes on a loaded machine.
jest.setTimeout(600_000);

const IP = '127.0.0.1';

/** What a call ended in: its error, or undefined when it succeeded. */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;

    return undefined;
  } catch (error) {
    return error;
  }
}

describeWithDatabase(`Session client binding, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let authService: AuthService;
  let userId: string;

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'auth/SessionMetadataBinding.integration.spec' });
    await scratch.assertOwn();

    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      entities: [UserEntity, SessionEntity],
    } as DataSourceOptions);
    await dataSource.initialize();

    authService = new AuthService(new JwtService({}), dataSource.getRepository(SessionEntity));

    // Nothing observing UserCreated is under test, and no listener may run against this database.
    const userService = new UserService(dataSource.getRepository(UserEntity), {
      send: async () => [],
    } as never);
    const user = await userService.create(
      { userId: SYSTEM_USER },
      { name: 'owner', email: 'owner@example.com', password: 'irrelevant-1' },
    );
    userId = user.id;
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

  it('rotates a session issued without a user agent for a refresh that sends none', async () => {
    const issued = await authService.issueSessionToken(userId, { ip: IP, userAgent: undefined });

    const [row] = await dataSource.query<Array<{ user_agent: string | null }>>(
      'SELECT user_agent FROM ci.sessions WHERE id = $1',
      [issued.sessionId],
    );
    expect(row.user_agent).toBeNull();

    // Resolving at all is the point: on TypeORM 1.x an undefined where-value throws a TypeORMError.
    const rotated = await authService.rotateSessionToken(userId, issued.sessionToken, {
      ip: IP,
      userAgent: undefined,
    });

    expect(rotated.sessionId).toBe(issued.sessionId);
    expect(rotated.sessionToken).not.toBeNull();
  });

  it('refuses a refresh without a user agent for a session issued with one, with a 401 and not a TypeORMError', async () => {
    const issued = await authService.issueSessionToken(userId, { ip: IP, userAgent: 'jest' });

    const failure = await failureOf(
      authService.rotateSessionToken(userId, issued.sessionToken, { ip: IP, userAgent: undefined }),
    );

    expect(failure).toBeInstanceOf(UnauthorizedException);
    expect(failure).not.toBeInstanceOf(TypeORMError);
  });
});

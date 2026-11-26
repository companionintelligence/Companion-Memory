import { randomUUID } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { SessionEntity } from '../entities/SessionEntity';
import { AccountRecoveryService, recoveryCodeDigest } from '../services/AccountRecoveryService';
import { AuthService } from '../services/AuthService';

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[auth/AccountRecovery.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(180_000);

/** Every destructive statement runs in a database created and guarded by this suite. */
describeWithDatabase('account recovery against real PostgreSQL', () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let recovery: AccountRecoveryService;
  let userId: string;
  let email: string;
  const oldPassword = 'original-password';
  const newPassword = 'replacement-password';
  const applicationName = `account-recovery-${randomUUID()}`;

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'auth/AccountRecovery.integration.spec' });
    await scratch.assertOwn();
    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      extra: { max: 8, application_name: applicationName },
      entities: [UserEntity, SessionEntity],
    } as DataSourceOptions);
    await dataSource.initialize();
    recovery = new AccountRecoveryService(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    if (scratch) {
      await scratch.drop();
    }
  });

  beforeEach(async () => {
    userId = randomUUID();
    email = `recovery-${userId}@example.test`;
    await dataSource.query(
      `INSERT INTO ci.users(id, name, email, password, password_set_at)
      VALUES ($1, 'Recovery fixture', $2, $3, now())`,
      [userId, email, await bcrypt.hash(oldPassword, 4)],
    );
  });

  const account = async () =>
    (
      await dataSource.query(
        'SELECT password, password_set_at, credentials_reset_at FROM ci.users WHERE id = $1',
        [userId],
      )
    )[0];

  async function createCredentials() {
    await dataSource.query(
      `INSERT INTO ci.sessions(id, user_id, token, expires_at)
      VALUES ($1, $2, 'fixture-session', now() + interval '1 day')`,
      [randomUUID(), userId],
    );
    for (const managedBy of ['sign_in', 'connect', null]) {
      await dataSource.query(
        `INSERT INTO ci.api_keys(id, user_id, name, prefix, hashed_key, managed_by)
        VALUES ($1, $2, 'fixture', 'fixture', $3, $4)`,
        [randomUUID(), userId, randomUUID(), managedBy],
      );
    }
  }

  it('stores only digests, accepts formatted codes, and consumes each code once', async () => {
    const codes = await recovery.generate(userId);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    const stored = await dataSource.query(
      'SELECT code_digest FROM ci.account_recovery_codes WHERE user_id = $1',
      [userId],
    );
    expect(stored.map((row: { code_digest: string }) => row.code_digest).sort()).toEqual(
      codes.map(recoveryCodeDigest).sort(),
    );
    expect(stored.every((row: { code_digest: string }) => /^[a-f0-9]{64}$/.test(row.code_digest))).toBe(true);

    await recovery.recover(
      `  ${email.toUpperCase()}  `,
      codes[0].toLowerCase().replaceAll('-', ' '),
      newPassword,
    );
    const updated = await account();
    expect(await bcrypt.compare(newPassword, updated.password)).toBe(true);
    expect(updated.credentials_reset_at).toBeInstanceOf(Date);
    expect(updated.password_set_at).toEqual(updated.credentials_reset_at);
    await expect(recovery.recover(email, codes[0], 'other-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(await bcrypt.compare(newPassword, (await account()).password)).toBe(true);
    expect(
      (
        await dataSource.query(
          'SELECT count(*)::int AS n FROM ci.account_recovery_codes WHERE user_id = $1 AND consumed_at IS NULL',
          [userId],
        )
      )[0].n,
    ).toBe(7);
  });

  it('rotates the entire list and rejects old codes without changing the password', async () => {
    const oldCodes = await recovery.generate(userId);
    const newCodes = await recovery.generate(userId);
    await expect(recovery.recover(email, oldCodes[0], newPassword)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(await bcrypt.compare(oldPassword, (await account()).password)).toBe(true);
    await recovery.recover(email, newCodes[0], newPassword);
  });

  it('rejects a code owned by a different account and a deleted owner', async () => {
    const codes = await recovery.generate(userId);
    await expect(recovery.recover('someone-else@example.test', codes[0], newPassword)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await dataSource.query('UPDATE ci.users SET deleted_at = now() WHERE id = $1', [userId]);
    await expect(recovery.recover(email, codes[0], newPassword)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(recovery.generate(userId)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(
      (
        await dataSource.query('SELECT consumed_at FROM ci.account_recovery_codes WHERE code_digest = $1', [
          recoveryCodeDigest(codes[0]),
        ])
      )[0].consumed_at,
    ).toBeNull();
  });

  it('revokes every browser session and sign-in key, retaining explicit tool and Hub grants', async () => {
    const [code] = await recovery.generate(userId);
    await createCredentials();
    await recovery.recover(email, code, newPassword);
    expect(await dataSource.query('SELECT id FROM ci.sessions WHERE user_id = $1', [userId])).toEqual([]);
    const remaining = await dataSource.query('SELECT managed_by FROM ci.api_keys WHERE user_id = $1', [
      userId,
    ]);
    expect(remaining).toEqual(expect.arrayContaining([{ managed_by: 'connect' }, { managed_by: null }]));
    expect(remaining).toHaveLength(2);
  });

  it('rolls back password, code consumption, sessions, and keys if revocation fails, then permits retry', async () => {
    const [code] = await recovery.generate(userId);
    await createCredentials();
    await dataSource.query(`CREATE FUNCTION public.reject_recovery_key_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated key revocation failure'; END $$`);
    await dataSource.query(`CREATE TRIGGER reject_recovery_key_delete BEFORE DELETE ON ci.api_keys
      FOR EACH ROW WHEN (OLD.managed_by = 'sign_in') EXECUTE FUNCTION public.reject_recovery_key_delete()`);
    try {
      await expect(recovery.recover(email, code, newPassword)).rejects.toThrow(
        'simulated key revocation failure',
      );
      expect(await bcrypt.compare(oldPassword, (await account()).password)).toBe(true);
      expect((await account()).credentials_reset_at).toBeNull();
      expect(
        (
          await dataSource.query('SELECT consumed_at FROM ci.account_recovery_codes WHERE code_digest = $1', [
            recoveryCodeDigest(code),
          ])
        )[0].consumed_at,
      ).toBeNull();
      expect(await dataSource.query('SELECT id FROM ci.sessions WHERE user_id = $1', [userId])).toHaveLength(
        1,
      );
      expect(await dataSource.query('SELECT id FROM ci.api_keys WHERE user_id = $1', [userId])).toHaveLength(
        3,
      );
    } finally {
      await dataSource.query('DROP TRIGGER reject_recovery_key_delete ON ci.api_keys');
      await dataSource.query('DROP FUNCTION public.reject_recovery_key_delete()');
    }

    await recovery.recover(email, code, newPassword);
    expect(await bcrypt.compare(newPassword, (await account()).password)).toBe(true);
  });

  it('allows exactly one concurrent redemption, with both callers queued on the owner lock', async () => {
    const [code] = await recovery.generate(userId);
    const blocker = dataSource.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query('SELECT id FROM ci.users WHERE id = $1 FOR UPDATE', [userId]);
    // Attach rejection handlers immediately; neither task can settle before the lock is released.
    const results = Promise.allSettled([
      recovery.recover(email, code, newPassword),
      recovery.recover(email, code, 'racing-password'),
    ]);
    try {
      const deadline = Date.now() + 15_000;
      let waiting = 0;
      do {
        waiting = Number(
          (
            await scratch.dataSource.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM ci.users%'`,
              [applicationName],
            )
          )[0].n,
        );
        if (waiting < 2) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } while (waiting < 2 && Date.now() < deadline);

      expect(waiting).toBe(2);
    } finally {
      await blocker.commitTransaction();
      await blocker.release();
    }

    const outcomes = await results;
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(UnauthorizedException);
    expect(
      (
        await dataSource.query('SELECT consumed_at FROM ci.account_recovery_codes WHERE code_digest = $1', [
          recoveryCodeDigest(code),
        ])
      )[0].consumed_at,
    ).toBeInstanceOf(Date);
  });

  it('refuses stale local-password admission and code rotation after recovery', async () => {
    const auth = new AuthService(new JwtService(), dataSource.getRepository(SessionEntity));
    const [code] = await recovery.generate(userId);
    // Null is the stamp read alongside the old password before recovery won the lock.
    const oldStamp = (await account()).credentials_reset_at;
    await recovery.recover(email, code, newPassword);
    await expect(auth.issueSessionToken(userId, {}, oldStamp)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(recovery.generate(userId, oldStamp)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await dataSource.query('SELECT id FROM ci.sessions WHERE user_id = $1', [userId])).toEqual([]);
    // A fresh password validation sees the new stamp and can establish a session.
    const newStamp = (await account()).credentials_reset_at;
    const session = await auth.issueSessionToken(userId, {}, newStamp);
    expect(session.sessionId).toBeTruthy();
    expect(await recovery.generate(userId, newStamp)).toHaveLength(8);
  });

  it('does not resurrect a session when recovery commits after refresh lookup', async () => {
    const repository = dataSource.getRepository(SessionEntity);
    const auth = new AuthService(new JwtService(), repository);
    const meta = { ip: '192.0.2.1', userAgent: 'recovery-race-test' };
    const { sessionToken } = await auth.issueSessionToken(userId, meta, null);
    // A token rotated in the second it was issued is that same token, and rotateSessionToken
    // returns it without writing. Wait that second out so the rotation takes the
    // compare-and-swap update this test is about.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const [code] = await recovery.generate(userId);
    const find = repository.findOne.bind(repository);
    const findSpy = jest.spyOn(repository, 'findOne').mockImplementationOnce(async (...args) => {
      const result = await find(...args);
      expect(result).not.toBeNull();
      await recovery.recover(email, code, newPassword);

      return result;
    });
    try {
      await expect(auth.rotateSessionToken(userId, sessionToken, meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(await dataSource.query('SELECT id FROM ci.sessions WHERE user_id = $1', [userId])).toEqual([]);
    } finally {
      findSpy.mockRestore();
    }
  });
});

import { UnauthorizedException } from '@nestjs/common';
import bcryptModule from 'bcrypt';
import { getMetadataArgsStorage } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';

import { UserEntity } from '../../entities/UserEntity';
import { UserRemovedEvent, UserUpdatedEvent } from '../../events';
import { LastAdminDeletionRefused, UserService } from '../UserService';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));

const bcrypt = bcryptModule as unknown as { compare: jest.Mock };

const PURGE_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the deletion transaction finds on the appliance. */
interface Appliance {
  /** The account being deleted, as the locked read sees it; null once it is already gone. */
  target: { id: string; role: string } | null;
  /** Another live admin stays. */
  otherAdmins: boolean;
  /** Another live account stays. */
  otherAccounts: boolean;
  /** Live accounts (other than the target) whose address matches the named successor. */
  successors: Array<{ id: string }>;
}

function makeService(appliance: Partial<Appliance> = {}) {
  const {
    target = { id: 'user-1', role: 'user' },
    otherAdmins = false,
    otherAccounts = false,
    successors = [],
  } = appliance;

  // Every statement the deletion transaction ran, in order, as a short label.
  const journal: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const transactionManager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      queries.push({ sql, params });

      if (sql.includes('pg_advisory_xact_lock')) {
        journal.push('lock');

        return Promise.resolve([]);
      }

      if (/SELECT id, role FROM ci\.users WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) {
        journal.push('read-target');

        return Promise.resolve(target ? [target] : []);
      }

      if (sql.includes('AS admins')) {
        journal.push('count-others');

        return Promise.resolve([{ admins: otherAdmins, accounts: otherAccounts }]);
      }

      if (sql.includes('lower(email) = $2')) {
        journal.push('find-successor');

        return Promise.resolve(successors);
      }

      if (sql.includes("SET role = 'admin'")) {
        journal.push('promote-successor');

        return Promise.resolve([[], 1]);
      }

      if (sql.includes('DELETE FROM ci.signup_code')) {
        journal.push('drop-invitations');

        return Promise.resolve([[], 0]);
      }

      return Promise.reject(new Error(`unexpected statement in the deletion transaction: ${sql}`));
    }),
    update: jest.fn((_entity: unknown, _id: string, _patch: Record<string, unknown>) => {
      journal.push('soft-delete');

      return Promise.resolve({ affected: 1 });
    }),
  };

  const userRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    manager: {
      transaction: jest.fn(async (run: (m: unknown) => Promise<unknown>) => {
        const result = await run(transactionManager);

        journal.push('commit');

        return result;
      }),
    },
  };
  const eventService = { send: jest.fn() };

  const service = new UserService(userRepository as never, eventService as never);

  return { service, userRepository, transactionManager, eventService, journal, queries };
}

// `makeService()` hands out fresh repository mocks per test, but the bcrypt module mock
// is shared across the file — without this its call history leaks between tests.
beforeEach(() => {
  jest.clearAllMocks();
});

const OWN = { userId: 'user-1' } as never;
const OTHER = { userId: 'user-2' } as never;
const SYSTEM = { userId: SYSTEM_USER } as never;

const storedUser = { id: 'user-1', email: 'jsmith@example.com', password: 'hashed' };

describe('UserService — account deletion', () => {
  /**
   * The whole access gate rests on this decorator: TypeORM excludes soft-deleted rows
   * from every read on the repository BECAUSE the entity declares a delete-date
   * column. Delete the decorator and deletion silently stops revoking access while
   * every other test here still passes — so pin the mechanism itself.
   */
  it('declares deleted_at as the entity delete-date column (the access gate)', () => {
    const deleteDateColumn = getMetadataArgsStorage().columns.find(
      (column) => column.target === UserEntity && column.mode === 'deleteDate',
    );

    expect(deleteDateColumn).toBeDefined();
    expect(deleteDateColumn?.options.name).toBe('deleted_at');
  });

  it('never exposes deletion state on the egress type', () => {
    const egress = UserEntity.toEgressType({
      ...storedUser,
      name: 'J',
      onboarded: true,
      timezone: 'UTC',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
      purgeAfter: new Date(),
    } as UserEntity);

    expect(egress).not.toHaveProperty('deletedAt');
    expect(egress).not.toHaveProperty('purgeAfter');
    expect(egress).not.toHaveProperty('password');
  });

  describe('requestDeletion', () => {
    it('soft-deletes and stamps the purge deadline in a SINGLE write', async () => {
      const { service, transactionManager, eventService } = makeService();

      const before = Date.now();
      const result = await service.requestDeletion(OWN, 'user-1');

      expect(result).toBe(true);
      // One write: the access gate and the retention promise must never exist apart.
      expect(transactionManager.update).toHaveBeenCalledTimes(1);

      const [entity, id, patch] = transactionManager.update.mock.calls[0];
      expect(entity).toBe(UserEntity);
      expect(id).toBe('user-1');
      expect(patch.deletedAt).toBeInstanceOf(Date);
      expect(patch.purgeAfter).toBeInstanceOf(Date);

      // The deadline is pinned at request time (~30d), so later config changes cannot
      // move a promise already made to someone who has left.
      const expected = before + PURGE_GRACE_DAYS * DAY_MS;
      expect(Math.abs((patch.purgeAfter as Date).getTime() - expected)).toBeLessThan(60_000);

      expect(eventService.send).toHaveBeenCalledWith(UserRemovedEvent, { userId: 'user-1' });
    });

    it('decides under the lock every account creation takes, and announces only after the commit', async () => {
      const { service, journal } = makeService();

      await service.requestDeletion(OWN, 'user-1');

      expect(journal).toEqual(['lock', 'read-target', 'soft-delete', 'drop-invitations', 'commit']);
    });

    it("drops the account's unused invitations in the same transaction", async () => {
      // An invitation is its issuer's decision to let someone in; an issuer who has left can no
      // longer stand behind it.
      const { service, queries } = makeService();

      await service.requestDeletion(OWN, 'user-1');

      const drop = queries.find((q) => q.sql.includes('DELETE FROM ci.signup_code'));
      expect(drop?.sql).toMatch(/WHERE issued_by = \$1 AND used = false/);
      expect(drop?.params).toEqual(['user-1']);
    });

    it('lets a user delete their own account', async () => {
      const { service } = makeService();

      await expect(service.requestDeletion(OWN, 'user-1')).resolves.toBe(true);
    });

    it('refuses to delete someone else’s account', async () => {
      const { service, userRepository } = makeService();

      await expect(service.requestDeletion(OTHER, 'user-1')).rejects.toThrow(UnauthorizedException);
      expect(userRepository.manager.transaction).not.toHaveBeenCalled();
    });

    it('allows the system user (for the future purge job)', async () => {
      const { service } = makeService();

      await expect(service.requestDeletion(SYSTEM, 'user-1')).resolves.toBe(true);
    });

    it('is idempotent: a second request finds nothing and does not rewrite the deadline', async () => {
      // The first request hid the row, so the locked read no longer finds it.
      const { service, transactionManager, eventService } = makeService({ target: null });

      await expect(service.requestDeletion(OWN, 'user-1')).resolves.toBe(false);
      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(eventService.send).not.toHaveBeenCalled();
    });

    describe('the last administrator', () => {
      const ADMIN = { id: 'user-1', role: 'admin' };

      it('is refused while other people still have accounts and nobody is named to take over', async () => {
        // Deleting the owner used to leave members on a box with no live admin, where the admin
        // guard admitted all of them and any of them could mint the invitation that made the
        // next admin.
        const { service, transactionManager, eventService } = makeService({
          target: ADMIN,
          otherAdmins: false,
          otherAccounts: true,
        });

        const failure = await service.requestDeletion(OWN, 'user-1').catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(LastAdminDeletionRefused);
        expect((failure as LastAdminDeletionRefused).reason).toBe('successor_required');
        expect(transactionManager.update).not.toHaveBeenCalled();
        expect(eventService.send).not.toHaveBeenCalled();
      });

      it('is refused when the named successor is not another live account here', async () => {
        const { service, transactionManager } = makeService({
          target: ADMIN,
          otherAccounts: true,
          successors: [],
        });

        const failure = await service
          .requestDeletion(OWN, 'user-1', { successorEmail: 'nobody@example.com' })
          .catch((error: unknown) => error);

        expect((failure as LastAdminDeletionRefused).reason).toBe('successor_not_found');
        expect(transactionManager.update).not.toHaveBeenCalled();
      });

      it('refuses an address that matches more than one account rather than guess', async () => {
        // Only rows that collided by case before addresses were normalized can do this.
        const { service, transactionManager } = makeService({
          target: ADMIN,
          otherAccounts: true,
          successors: [{ id: 'user-2' }, { id: 'user-3' }],
        });

        const failure = await service
          .requestDeletion(OWN, 'user-1', { successorEmail: 'twin@example.com' })
          .catch((error: unknown) => error);

        expect((failure as LastAdminDeletionRefused).reason).toBe('successor_not_found');
        expect(transactionManager.update).not.toHaveBeenCalled();
      });

      it('hands the role to the named successor in the same transaction, then leaves', async () => {
        const { service, journal, queries, eventService } = makeService({
          target: ADMIN,
          otherAccounts: true,
          successors: [{ id: 'user-2' }],
        });

        await expect(
          service.requestDeletion(OWN, 'user-1', { successorEmail: '  Member@Example.com ' }),
        ).resolves.toBe(true);

        // Looked up by the address it signs in with, normalized, and never the leaver itself.
        const lookup = queries.find((q) => q.sql.includes('lower(email) = $2'));
        expect(lookup?.sql).toMatch(/deleted_at IS NULL/);
        expect(lookup?.params).toEqual(['user-1', 'member@example.com']);

        const promote = queries.find((q) => q.sql.includes("SET role = 'admin'"));
        expect(promote?.params).toEqual(['user-2']);
        expect(journal.indexOf('promote-successor')).toBeLessThan(journal.indexOf('soft-delete'));
        expect(journal.indexOf('soft-delete')).toBeLessThan(journal.indexOf('commit'));

        expect(eventService.send).toHaveBeenCalledWith(UserUpdatedEvent, { userId: 'user-2' });
        expect(eventService.send).toHaveBeenCalledWith(UserRemovedEvent, { userId: 'user-1' });
      });

      it('needs no successor while another live admin stays', async () => {
        const { service, journal } = makeService({ target: ADMIN, otherAdmins: true, otherAccounts: true });

        await expect(service.requestDeletion(OWN, 'user-1')).resolves.toBe(true);
        expect(journal).not.toContain('promote-successor');
      });

      it('needs no successor when nobody else is left (the appliance empties out)', async () => {
        const { service, journal } = makeService({ target: ADMIN, otherAdmins: false, otherAccounts: false });

        await expect(service.requestDeletion(OWN, 'user-1')).resolves.toBe(true);
        expect(journal).not.toContain('promote-successor');
      });

      it('never asks a member for a successor', async () => {
        const { service, journal } = makeService({
          target: { id: 'user-1', role: 'user' },
          otherAccounts: true,
        });

        await expect(service.requestDeletion(OWN, 'user-1')).resolves.toBe(true);
        expect(journal).not.toContain('count-others');
      });
    });
  });

  /**
   * The same rule for the privacy route's immediate hard delete (`POST /users/me/delete`), which
   * does not go through `requestDeletion`. It only hands the role over; the route deletes.
   */
  describe('handOverAdministration', () => {
    const ADMIN = { id: 'user-1', role: 'admin' };

    it('refuses the last administrator while others have accounts and nobody is named', async () => {
      const { service, journal, eventService } = makeService({ target: ADMIN, otherAccounts: true });

      const failure = await service.handOverAdministration(OWN, 'user-1').catch((error: unknown) => error);

      expect((failure as LastAdminDeletionRefused).reason).toBe('successor_required');
      expect(journal).toEqual(['lock', 'read-target', 'count-others']);
      expect(eventService.send).not.toHaveBeenCalled();
    });

    it('promotes the named successor under the lock, and touches nothing else', async () => {
      const { service, journal, queries, transactionManager, eventService } = makeService({
        target: ADMIN,
        otherAccounts: true,
        successors: [{ id: 'user-2' }],
      });

      await expect(
        service.handOverAdministration(OWN, 'user-1', { successorEmail: 'Member@Example.com' }),
      ).resolves.toBeUndefined();

      expect(journal).toEqual([
        'lock',
        'read-target',
        'count-others',
        'find-successor',
        'promote-successor',
        'commit',
      ]);
      expect(queries.find((q) => q.sql.includes("SET role = 'admin'"))?.params).toEqual(['user-2']);
      // The account itself is the route's to delete.
      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(eventService.send).toHaveBeenCalledWith(UserUpdatedEvent, { userId: 'user-2' });
      expect(eventService.send).not.toHaveBeenCalledWith(UserRemovedEvent, expect.anything());
    });

    it('lets a member through without asking', async () => {
      const { service, journal } = makeService({
        target: { id: 'user-1', role: 'user' },
        otherAccounts: true,
      });

      await expect(service.handOverAdministration(OWN, 'user-1')).resolves.toBeUndefined();
      expect(journal).not.toContain('count-others');
    });

    it('refuses to act for someone else', async () => {
      const { service, userRepository } = makeService({ target: ADMIN });

      await expect(service.handOverAdministration(OWN, 'user-2')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(userRepository.manager.transaction).not.toHaveBeenCalled();
    });
  });

  /**
   * `remove()` is the FK-unsafe hard delete — not the account-deletion path, and
   * currently called by nothing. It is still worth pinning because the background purge
   * job will be written against it, and it shipped with a missing `await` that made its
   * own existence guard dead code (a Promise is always truthy), so it always reached
   * the DELETE and emitted a spurious UserRemovedEvent for ids that do not exist.
   */
  describe('remove (hard delete)', () => {
    it('does not delete or emit for a user that does not exist', async () => {
      const { service, userRepository, eventService } = makeService();
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.remove(OWN, 'user-1')).resolves.toBe(false);
      expect(userRepository.delete).not.toHaveBeenCalled();
      expect(eventService.send).not.toHaveBeenCalled();
    });

    it('deletes and emits exactly once for a user that does exist', async () => {
      const { service, userRepository, eventService } = makeService();
      userRepository.findOne.mockResolvedValue(storedUser);

      await expect(service.remove(OWN, 'user-1')).resolves.toBe(true);
      expect(userRepository.delete).toHaveBeenCalledWith('user-1');
      expect(eventService.send).toHaveBeenCalledWith(UserRemovedEvent, { userId: 'user-1' });
    });

    it('refuses to hard-delete someone else’s account', async () => {
      const { service, userRepository } = makeService();

      await expect(service.remove(OTHER, 'user-1')).rejects.toThrow(UnauthorizedException);
      expect(userRepository.delete).not.toHaveBeenCalled();
    });
  });

  /**
   * The one read that must opt INTO deleted rows. A soft-deleted user keeps their
   * address and `ci.users.email` is UNIQUE across deleted rows, so reading through the
   * default filter would report a departed user's address as free and signup would hit
   * a raw constraint violation instead of a clean "already registered".
   */
  describe('checkEmailAvailability', () => {
    it('sees soft-deleted rows, so a departed address is still reported as taken', async () => {
      const { service, userRepository } = makeService();
      userRepository.findOne.mockResolvedValue(storedUser);

      await expect(service.checkEmailAvailability('jsmith@example.com')).resolves.toBe(true);
      expect(userRepository.findOne).toHaveBeenCalledWith(expect.objectContaining({ withDeleted: true }));
    });

    it('compares whatever the case, since the unique index on lower(email) would', async () => {
      const { service, userRepository } = makeService();
      userRepository.findOne.mockResolvedValue(null);

      await service.checkEmailAvailability('  JSmith@Example.COM ');

      const where = userRepository.findOne.mock.calls[0][0].where.email;
      expect(where.getSql('email')).toBe('LOWER(email) = :email');
      expect(where.objectLiteralParameters).toEqual({ email: 'jsmith@example.com' });
    });
  });

  /**
   * Auth resolves users through exactly these three methods. If any of them ever opts
   * out of the soft-delete filter with `withDeleted: true`, a deleted account starts
   * authenticating again — the one failure this feature exists to prevent.
   */
  describe('the auth entry points keep the soft-delete filter', () => {
    it('findById (JWT + API key) does not opt out', async () => {
      const { service, userRepository } = makeService();
      userRepository.findOne.mockResolvedValue(storedUser);

      await service.findById(OWN, 'user-1');

      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: 'user-1' } });
      expect(userRepository.findOne.mock.calls[0][0]).not.toHaveProperty('withDeleted');
    });

    it('findByEmail (OIDC) does not opt out', async () => {
      const { service, userRepository } = makeService();
      userRepository.findOne.mockResolvedValue(storedUser);

      await service.findByEmail('jsmith@example.com');

      expect(userRepository.findOne.mock.calls[0][0]).not.toHaveProperty('withDeleted');
    });

    it('validatePassword (login) does not opt out', async () => {
      const { service, userRepository } = makeService();
      userRepository.findOne.mockResolvedValue(storedUser);
      bcrypt.compare.mockResolvedValue(true);

      await service.validatePassword('jsmith@example.com', 'pw');

      expect(userRepository.findOne.mock.calls[0][0]).not.toHaveProperty('withDeleted');
    });

    it('a deleted account authenticates nowhere (the repository hides the row)', async () => {
      const { service, userRepository } = makeService();
      // What the filtered repository returns once the row is soft-deleted.
      userRepository.findOne.mockResolvedValue(null);
      bcrypt.compare.mockResolvedValue(true);

      await expect(service.findById(OWN, 'user-1')).resolves.toBeNull();
      await expect(service.findByEmail('jsmith@example.com')).resolves.toBeNull();
      // Even a comparison that "matches" admits nobody: it is against a dummy hash, not a row.
      await expect(service.validatePassword('jsmith@example.com', 'pw')).resolves.toBeNull();
      expect(userRepository.find.mock.calls.every(([options]) => !('withDeleted' in options))).toBe(true);
    });
  });
});

describe('UserService — password login', () => {
  it('compares an unknown address against a dummy hash too, so the response time says nothing', async () => {
    // Skipping bcrypt for unknown names made every made-up name cheap to try and told anyone
    // timing the response whether an account exists.
    const { service, userRepository } = makeService();
    const hash = (bcryptModule as unknown as { hash: jest.Mock }).hash;
    hash.mockResolvedValue('$2b$10$dummy');
    userRepository.findOne.mockResolvedValue(null);
    bcrypt.compare.mockResolvedValue(false);

    await expect(service.authenticatePassword('nobody@example.com', 'guess')).resolves.toEqual({
      user: null,
      accountExists: false,
    });
    expect(bcrypt.compare).toHaveBeenCalledWith('guess', '$2b$10$dummy');
  });

  it('reports that the account exists when only the password was wrong', async () => {
    const { service, userRepository } = makeService();
    userRepository.findOne.mockResolvedValue(storedUser);
    bcrypt.compare.mockResolvedValue(false);

    await expect(service.authenticatePassword('jsmith@example.com', 'wrong')).resolves.toEqual({
      user: null,
      accountExists: true,
    });
    expect(bcrypt.compare).toHaveBeenCalledWith('wrong', 'hashed');
  });

  it('signs in by the address whatever its case, once the exact spelling finds nothing', async () => {
    const { service, userRepository } = makeService();
    userRepository.findOne.mockResolvedValue(null);
    userRepository.find.mockResolvedValue([storedUser]);
    bcrypt.compare.mockResolvedValue(true);

    const { user } = await service.authenticatePassword('JSmith@Example.com', 'pw');

    expect(user?.id).toBe('user-1');
  });

  it('admits nobody when several accounts share the address once case is ignored', async () => {
    // Rows that collided by case before addresses were normalized: each still signs in with its
    // exact address, and a folded one is a guess this refuses to make.
    const { service, userRepository } = makeService();
    userRepository.findOne.mockResolvedValue(null);
    userRepository.find.mockResolvedValue([storedUser, { ...storedUser, id: 'user-2' }]);
    bcrypt.compare.mockResolvedValue(true);

    await expect(service.authenticatePassword('JSMITH@example.com', 'pw')).resolves.toEqual({
      user: null,
      accountExists: true,
    });
    await expect(service.findAccountByEmail('JSMITH@example.com')).resolves.toBe('ambiguous');
  });
});

describe('UserService — email change', () => {
  it('stores the new address normalized and no longer proven', async () => {
    // Nothing showed the new address is this person's, so neither the Portal email link nor
    // the Hub bridge may link anyone into the account by it.
    const { service, userRepository } = makeService();
    userRepository.findOne.mockResolvedValue(storedUser);

    await service.changeEmail(OWN, 'user-1', '  New@Example.com ');

    expect(userRepository.update).toHaveBeenCalledWith('user-1', {
      email: 'new@example.com',
      emailProvenAt: null,
    });
  });

  it('holds an address arriving through update() to the same rule', async () => {
    const { service, userRepository } = makeService();
    userRepository.findOne.mockResolvedValue(storedUser);

    await service.update(OWN, 'user-1', { email: 'Other@Example.com' });

    expect(userRepository.update).toHaveBeenCalledWith('user-1', {
      email: 'other@example.com',
      emailProvenAt: null,
    });
  });
});

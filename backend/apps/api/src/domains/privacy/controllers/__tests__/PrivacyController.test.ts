import 'reflect-metadata';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import { FULL_CAPABILITY, REQUIRE_CAPABILITY_KEY } from '@ci/common/decorators';
import { LastAdminDeletionRefused, SUCCESSOR_NOT_FOUND, SUCCESSOR_REQUIRED } from '@ci/domains/user';

import type { AccountDeletionResult } from '../../services/DataDeletionService';
import { PrivacyController } from '../PrivacyController';

function makeController(result: AccountDeletionResult, email = 'owner@example.com') {
  const deleteAccount = jest.fn(async (_context: unknown, _options?: unknown) => result);
  const dataDeletionService = { deleteAccount };
  const userService = { findById: jest.fn(async () => ({ id: 'user-1', email })) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const controller = new PrivacyController(
    dataDeletionService as never,
    userService as never,
    logger as never,
  );

  return { controller, deleteAccount };
}

const RESULT: AccountDeletionResult = {
  userId: 'user-1',
  status: 'deleted',
  revocations: [
    { connectionId: 'c1', providerId: 'google', tokenRevoked: true },
    { connectionId: 'c2', providerId: 'google', tokenRevoked: false },
  ],
  deletedCounts: { 'ci.communications': 3, 'ci.users': 1 },
  detachedCounts: { 'ci.ask_audit': 1 },
  totalDeleted: 4,
  deletedObjects: 2,
  userDeleted: true,
  auditId: 'audit-1',
};

const OWNER_REQUEST = {} as never;

describe('PrivacyController.deleteMyAccount', () => {
  it('deletes the AUTHENTICATED user (context userId), never a body/param id', async () => {
    const { controller, deleteAccount } = makeController(RESULT);

    // The context carries the authenticated user id (set by the auth guard).
    const context = { userId: 'user-1' } as never;
    const response = await controller.deleteMyAccount(context, OWNER_REQUEST, {
      confirmEmail: 'owner@example.com',
    });

    // Delegated with the caller's own context — owner-scoped by construction.
    expect(deleteAccount).toHaveBeenCalledWith({ userId: 'user-1' }, expect.anything());

    expect(response).toEqual({
      status: 'deleted',
      userDeleted: true,
      totalDeleted: 4,
      deletedCounts: { 'ci.communications': 3, 'ci.users': 1 },
      detachedCounts: { 'ci.ask_audit': 1 },
      deletedObjects: 2,
      connectionsRevoked: 1, // only c1 was actually revoked
      connectionsProcessed: 2,
      auditId: 'audit-1',
    });
  });

  it('passes the successor the caller named to the delete', async () => {
    const { controller, deleteAccount } = makeController(RESULT);

    await controller.deleteMyAccount({ userId: 'user-1' } as never, OWNER_REQUEST, {
      confirmEmail: 'owner@example.com',
      successorEmail: 'member@example.com',
    });

    expect(deleteAccount).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { successorEmail: 'member@example.com' },
    );
  });

  it('says deleting, not deleted, while the purge of an ended account is still running', async () => {
    const { controller } = makeController({
      ...RESULT,
      status: 'deleting',
      deletedCounts: {},
      detachedCounts: {},
      totalDeleted: 0,
      deletedObjects: 0,
      userDeleted: false,
    });

    const response = await controller.deleteMyAccount({ userId: 'user-1' } as never, OWNER_REQUEST, {
      confirmEmail: 'owner@example.com',
    });

    expect(response).toMatchObject({ status: 'deleting', userDeleted: false, auditId: 'audit-1' });
  });

  it('passes a failed delete through untouched', async () => {
    const { controller, deleteAccount } = makeController(RESULT);
    const failure = new Error('could not end the account');
    deleteAccount.mockRejectedValue(failure);

    await expect(
      controller.deleteMyAccount({ userId: 'user-1' } as never, OWNER_REQUEST, {
        confirmEmail: 'owner@example.com',
        successorEmail: 'member@example.com',
      }),
    ).rejects.toBe(failure);
  });

  it.each([
    ['successor_required', SUCCESSOR_REQUIRED],
    ['successor_not_found', SUCCESSOR_NOT_FOUND],
  ] as const)(
    'answers 409 %s when the last administrator names nobody who can take over',
    async (reason, message) => {
      const { controller, deleteAccount } = makeController(RESULT);
      deleteAccount.mockRejectedValue(new LastAdminDeletionRefused(reason));

      const failure = await controller
        .deleteMyAccount({ userId: 'user-1' } as never, OWNER_REQUEST, { confirmEmail: 'owner@example.com' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toMatchObject({ message });
    },
  );

  it('accepts the email retyped with different case and surrounding spaces', async () => {
    const { controller, deleteAccount } = makeController(RESULT);

    await controller.deleteMyAccount({ userId: 'user-1' } as never, OWNER_REQUEST, {
      confirmEmail: '  Owner@Example.COM ',
    });

    expect(deleteAccount).toHaveBeenCalledTimes(1);
  });

  it('refuses when the confirmation email is not the account email, and deletes nothing', async () => {
    const { controller, deleteAccount } = makeController(RESULT);

    await expect(
      controller.deleteMyAccount({ userId: 'user-1' } as never, OWNER_REQUEST, {
        confirmEmail: 'someone-else@example.com',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses an installed app's key even when it holds full, and deletes nothing", async () => {
    const { controller, deleteAccount } = makeController(RESULT);

    await expect(
      controller.deleteMyAccount(
        { userId: 'user-1' } as never,
        { apiKeyScopes: [], apiKeyCapability: 'full', apiKeyManagedBy: 'connect' } as never,
        { confirmEmail: 'owner@example.com' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('requires full from an api key, not the write a POST gets by shape', () => {
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, PrivacyController.prototype.deleteMyAccount)).toBe(
      FULL_CAPABILITY,
    );
  });
});

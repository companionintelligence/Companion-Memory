import { ConflictException } from '@nestjs/common';

import { LastAdminDeletionRefused, SUCCESSOR_NOT_FOUND, SUCCESSOR_REQUIRED } from '@ci/domains/user';

import type { AccountDeletionResult } from '../../services/DataDeletionService';
import { PrivacyController } from '../PrivacyController';

function makeController(result: AccountDeletionResult) {
  const deleteAccount = jest.fn(async () => result);
  const dataDeletionService = { deleteAccount };
  const handOverAdministration = jest.fn(async () => undefined);
  const userService = { handOverAdministration };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const controller = new PrivacyController(
    dataDeletionService as never,
    userService as never,
    logger as never,
  );

  return { controller, deleteAccount, handOverAdministration };
}

const RESULT: AccountDeletionResult = {
  userId: 'user-1',
  revocations: [
    { connectionId: 'c1', providerId: 'google', tokenRevoked: true },
    { connectionId: 'c2', providerId: 'google', tokenRevoked: false },
  ],
  deletedCounts: { 'ci.communications': 3, 'ci.users': 1 },
  totalDeleted: 4,
  userDeleted: true,
  auditId: 'audit-1',
};

describe('PrivacyController.deleteMyAccount', () => {
  it('deletes the AUTHENTICATED user (context userId), never a body/param id', async () => {
    const { controller, deleteAccount } = makeController(RESULT);

    // The context carries the authenticated user id (set by the auth guard).
    const context = { userId: 'user-1' } as never;
    const response = await controller.deleteMyAccount(context, { confirm: true });

    // Delegated with the caller's own context — owner-scoped by construction.
    expect(deleteAccount).toHaveBeenCalledWith({ userId: 'user-1' });

    expect(response).toEqual({
      status: 'deleted',
      userDeleted: true,
      totalDeleted: 4,
      deletedCounts: { 'ci.communications': 3, 'ci.users': 1 },
      connectionsRevoked: 1, // only c1 was actually revoked
      connectionsProcessed: 2,
      auditId: 'audit-1',
    });
  });

  it('hands administration over before it deletes anything, with the successor the caller named', async () => {
    const { controller, deleteAccount, handOverAdministration } = makeController(RESULT);

    await controller.deleteMyAccount({ userId: 'user-1' } as never, {
      confirm: true,
      successorEmail: 'member@example.com',
    });

    expect(handOverAdministration).toHaveBeenCalledWith({ userId: 'user-1' }, 'user-1', {
      successorEmail: 'member@example.com',
    });
    expect(handOverAdministration.mock.invocationCallOrder[0]).toBeLessThan(
      deleteAccount.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['successor_required', SUCCESSOR_REQUIRED],
    ['successor_not_found', SUCCESSOR_NOT_FOUND],
  ] as const)(
    'answers 409 %s and deletes nothing when the last administrator names nobody who can take over',
    async (reason, message) => {
      const { controller, deleteAccount, handOverAdministration } = makeController(RESULT);
      handOverAdministration.mockRejectedValue(new LastAdminDeletionRefused(reason));

      const failure = await controller
        .deleteMyAccount({ userId: 'user-1' } as never, { confirm: true })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toMatchObject({ message });
      expect(deleteAccount).not.toHaveBeenCalled();
    },
  );
});

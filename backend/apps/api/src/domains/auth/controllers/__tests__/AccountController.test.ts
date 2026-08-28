import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import config from '@ci/configuration';

import { AccountController } from '../AccountController';

/**
 * `DELETE /account` is the in-app account deletion both stores require (Apple
 * 5.1.1(v), Google Play Data Deletion). It is irreversible from the user's side, so
 * these tests pin the two things that matter: a matching confirmation deletes, and
 * ANYTHING else deletes nothing.
 *
 * `PATCH /account/email` and `PATCH /account/password` pin the OIDC-aware
 * re-authentication rule: a non-federated account must prove its current
 * password, a federated one (a random 32-byte password it has never seen)
 * must not be asked for one it cannot possibly supply.
 */
function makeController(
  user: { id: string; email: string } | null = { id: 'u1', email: 'jsmith@example.com' },
  {
    hasFederatedIdentity = false,
    validPassword = true,
    emailTaken = false,
  }: { hasFederatedIdentity?: boolean; validPassword?: boolean; emailTaken?: boolean } = {},
) {
  const userService = {
    findById: jest.fn().mockResolvedValue(user),
    requestDeletion: jest.fn().mockResolvedValue(true),
    checkEmailAvailability: jest.fn().mockResolvedValue(emailTaken),
    changeEmail: jest
      .fn()
      .mockImplementation((_ctx: unknown, _id: string, newEmail: string) =>
        Promise.resolve(user ? { ...user, email: newEmail } : null),
      ),
    changePassword: jest.fn().mockResolvedValue(undefined),
    validatePassword: jest.fn().mockResolvedValue(validPassword ? user : null),
  };

  const authService = {
    invalidateOtherSessions: jest.fn().mockResolvedValue(undefined),
  };

  const federatedIdentityService = {
    listForUser: jest.fn().mockResolvedValue(hasFederatedIdentity ? [{ id: 'fed1' }] : []),
  };

  const controller = new AccountController(
    userService as never,
    authService as never,
    federatedIdentityService as never,
  );

  return { controller, userService, authService, federatedIdentityService };
}

// A fresh object per test: toServiceContext caches on the RequestContext identity.
const requestContext = () => ({ userId: 'u1' });

function mockRequest(sessionToken = 'current-session-token'): Request {
  return { cookies: { [config.auth.cookies.sessionTokenName]: sessionToken } } as unknown as Request;
}

describe('AccountController — delete account', () => {
  it('requests deletion when the confirmation email matches the account', async () => {
    const { controller, userService } = makeController();

    await controller.remove(requestContext(), { confirmEmail: 'jsmith@example.com' });

    expect(userService.requestDeletion).toHaveBeenCalledWith({ userId: 'u1' }, 'u1');
  });

  it('accepts a confirmation that differs only by case or surrounding space', async () => {
    const { controller, userService } = makeController();

    // The user is retyping to prove intent, not reproducing a stored string byte-for-byte.
    await controller.remove(requestContext(), { confirmEmail: '  JSmith@Example.COM  ' });

    expect(userService.requestDeletion).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched confirmation and deletes NOTHING', async () => {
    const { controller, userService } = makeController();

    await expect(controller.remove(requestContext(), { confirmEmail: 'someone@else.com' })).rejects.toThrow(
      BadRequestException,
    );

    expect(userService.requestDeletion).not.toHaveBeenCalled();
  });

  it('rejects when the account no longer resolves (replayed request after deletion)', async () => {
    // Soft-deleted users stop resolving through findById, so a replay lands here.
    const { controller, userService } = makeController(null);

    await expect(controller.remove(requestContext(), { confirmEmail: 'jsmith@example.com' })).rejects.toThrow(
      UnauthorizedException,
    );

    expect(userService.requestDeletion).not.toHaveBeenCalled();
  });
});

describe('AccountController — get', () => {
  it('reports the account email and that it is not federated by default', async () => {
    const { controller } = makeController();

    await expect(controller.get(requestContext())).resolves.toEqual({
      email: 'jsmith@example.com',
      hasFederatedIdentity: false,
    });
  });

  it('reports hasFederatedIdentity when an OIDC identity is bound', async () => {
    const { controller } = makeController(undefined, { hasFederatedIdentity: true });

    await expect(controller.get(requestContext())).resolves.toEqual({
      email: 'jsmith@example.com',
      hasFederatedIdentity: true,
    });
  });
});

describe('AccountController — change email', () => {
  it('changes the email when the current password is correct', async () => {
    const { controller, userService } = makeController();

    const result = await controller.changeEmail(requestContext(), {
      newEmail: 'new@example.com',
      currentPassword: 'correct-password',
    });

    expect(userService.validatePassword).toHaveBeenCalledWith('jsmith@example.com', 'correct-password');
    expect(userService.changeEmail).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new@example.com');
    expect(result).toEqual({ email: 'new@example.com' });
  });

  it('rejects with no current password on a non-federated account', async () => {
    const { controller, userService } = makeController();

    await expect(controller.changeEmail(requestContext(), { newEmail: 'new@example.com' })).rejects.toThrow(
      BadRequestException,
    );
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password', async () => {
    const { controller, userService } = makeController(undefined, { validPassword: false });

    await expect(
      controller.changeEmail(requestContext(), { newEmail: 'new@example.com', currentPassword: 'wrong' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('skips the current-password requirement for an OIDC-linked account', async () => {
    const { controller, userService } = makeController(undefined, { hasFederatedIdentity: true });

    await controller.changeEmail(requestContext(), { newEmail: 'new@example.com' });

    expect(userService.changeEmail).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new@example.com');
  });

  it('rejects an email already in use and changes NOTHING', async () => {
    const { controller, userService } = makeController(undefined, { emailTaken: true });

    await expect(
      controller.changeEmail(requestContext(), { newEmail: 'taken@example.com', currentPassword: 'correct-password' }),
    ).rejects.toThrow(BadRequestException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('rejects changing to the same email already on the account', async () => {
    const { controller, userService } = makeController();

    await expect(
      controller.changeEmail(requestContext(), {
        newEmail: 'jsmith@example.com',
        currentPassword: 'correct-password',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });
});

describe('AccountController — change password', () => {
  it('changes the password and invalidates every OTHER session', async () => {
    const { controller, userService, authService } = makeController();

    await controller.changePassword(requestContext(), mockRequest('current-session-token'), {
      newPassword: 'new-password-1',
      currentPassword: 'correct-password',
    });

    expect(userService.changePassword).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new-password-1');
    expect(authService.invalidateOtherSessions).toHaveBeenCalledWith('u1', 'current-session-token');
  });

  it('rejects with no current password on a non-federated account', async () => {
    const { controller, userService } = makeController();

    await expect(
      controller.changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-1' }),
    ).rejects.toThrow(BadRequestException);
    expect(userService.changePassword).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password and invalidates NOTHING', async () => {
    const { controller, userService, authService } = makeController(undefined, { validPassword: false });

    await expect(
      controller.changePassword(requestContext(), mockRequest(), {
        newPassword: 'new-password-1',
        currentPassword: 'wrong',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(userService.changePassword).not.toHaveBeenCalled();
    expect(authService.invalidateOtherSessions).not.toHaveBeenCalled();
  });

  it('allows setting a password with no current-password check for an OIDC-linked account', async () => {
    const { controller, userService } = makeController(undefined, { hasFederatedIdentity: true });

    await controller.changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-1' });

    expect(userService.changePassword).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new-password-1');
  });
});

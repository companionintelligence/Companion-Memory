import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import type { ApiKeyScopedRequest } from '@ci/common/guards';
import config from '@ci/configuration';

import { CONNECT_PROVENANCE } from '../../types';
import { AccountController, EMAIL_MANAGED_BY_HUB } from '../AccountController';

/**
 * `DELETE /account` is the in-app account deletion both stores require (Apple
 * 5.1.1(v), Google Play Data Deletion). It is irreversible from the user's side, so
 * these tests pin the two things that matter: a matching confirmation deletes, and
 * ANYTHING else deletes nothing.
 *
 * `PATCH /account/email` and `PATCH /account/password` pin the re-authentication
 * rule: an account with a password the user chose (`passwordSetAt`) must prove it,
 * and one provisioned with a random 32-byte password it has never seen — by
 * Portal/OIDC sign-in or by the Hub forward-auth bridge — must not be asked for one
 * it cannot possibly supply, whether or not a federated identity is bound.
 */
function makeController(
  user: { id: string; email: string; passwordSetAt?: Date | null } | null = {
    id: 'u1',
    email: 'jsmith@example.com',
    passwordSetAt: new Date(),
  },
  {
    hasFederatedIdentity = false,
    validPassword = true,
    emailTaken = false,
    // When the current session was established; `null` = the cookie names no live session.
    sessionAgeMs = 0 as number | null,
    // Whether the request arrives through the Hub, signed in as this account.
    hubNamesAccount = false,
  }: {
    hasFederatedIdentity?: boolean;
    validPassword?: boolean;
    emailTaken?: boolean;
    sessionAgeMs?: number | null;
    hubNamesAccount?: boolean;
  } = {},
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
    sessionEstablishedAt: jest
      .fn()
      .mockResolvedValue(sessionAgeMs === null ? null : new Date(Date.now() - sessionAgeMs)),
  };

  const federatedIdentityService = {
    listForUser: jest.fn().mockResolvedValue(hasFederatedIdentity ? [{ id: 'fed1' }] : []),
  };

  const hubBridge = {
    namesAccount: jest.fn().mockReturnValue(hubNamesAccount),
  };

  const controller = new AccountController(
    userService as never,
    authService as never,
    federatedIdentityService as never,
    hubBridge as never,
  );

  return { controller, userService, authService, federatedIdentityService, hubBridge };
}

/** An OIDC-provisioned account: a random password it has never seen, unless it has since set one. */
const federatedUser = (passwordSetAt: Date | null = null) => ({
  id: 'u1',
  email: 'jsmith@example.com',
  passwordSetAt,
});

/**
 * An account the Hub forward-auth bridge JIT-created: a random password it has never
 * seen and — unlike the OIDC paths — NO federated identity. Pair it with the default
 * `hasFederatedIdentity: false`.
 */
const hubProvisionedUser = () => ({
  id: 'u1',
  email: 'jsmith@example.com',
  passwordSetAt: null,
});

// A fresh object per test: toServiceContext caches on the RequestContext identity.
const requestContext = () => ({ userId: 'u1' });

function mockRequest(sessionToken = 'current-session-token'): Request {
  return { cookies: { [config.auth.cookies.sessionTokenName]: sessionToken } } as unknown as Request;
}

describe('AccountController — delete account', () => {
  it('requests deletion when the confirmation email matches the account', async () => {
    const { controller, userService } = makeController();

    await controller.remove(requestContext(), mockRequest(), { confirmEmail: 'jsmith@example.com' });

    expect(userService.requestDeletion).toHaveBeenCalledWith({ userId: 'u1' }, 'u1');
  });

  it('accepts a confirmation that differs only by case or surrounding space', async () => {
    const { controller, userService } = makeController();

    // The user is retyping to prove intent, not reproducing a stored string byte-for-byte.
    await controller.remove(requestContext(), mockRequest(), { confirmEmail: '  JSmith@Example.COM  ' });

    expect(userService.requestDeletion).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched confirmation and deletes NOTHING', async () => {
    const { controller, userService } = makeController();

    await expect(
      controller.remove(requestContext(), mockRequest(), { confirmEmail: 'someone@else.com' }),
    ).rejects.toThrow(BadRequestException);

    expect(userService.requestDeletion).not.toHaveBeenCalled();
  });

  it('rejects when the account no longer resolves (replayed request after deletion)', async () => {
    // Soft-deleted users stop resolving through findById, so a replay lands here.
    const { controller, userService } = makeController(null);

    await expect(
      controller.remove(requestContext(), mockRequest(), { confirmEmail: 'jsmith@example.com' }),
    ).rejects.toThrow(UnauthorizedException);

    expect(userService.requestDeletion).not.toHaveBeenCalled();
  });

  it('refuses an installed app (a CI-Hub connect key) even with the right confirmation, and deletes NOTHING', async () => {
    // Which keys reach the handler at all is the guard's business, pinned in
    // AccountController.guards.test.ts; this is the part the handler decides.
    const { controller, userService } = makeController();
    const appRequest = { apiKeyManagedBy: CONNECT_PROVENANCE } as unknown as ApiKeyScopedRequest;

    await expect(
      controller.remove(requestContext(), appRequest, { confirmEmail: 'jsmith@example.com' }),
    ).rejects.toThrow(ForbiddenException);

    expect(userService.requestDeletion).not.toHaveBeenCalled();
  });
});

describe('AccountController — get', () => {
  it('reports the account email and that it is not federated by default', async () => {
    const { controller } = makeController();

    await expect(controller.get(requestContext(), mockRequest())).resolves.toEqual({
      email: 'jsmith@example.com',
      hasFederatedIdentity: false,
      hasOwnPassword: true,
      emailManagedByHub: false,
    });
  });

  it('reports hasFederatedIdentity when an OIDC identity is bound, and no own password for a provisioned account', async () => {
    const { controller } = makeController(federatedUser(), { hasFederatedIdentity: true });

    await expect(controller.get(requestContext(), mockRequest())).resolves.toEqual({
      email: 'jsmith@example.com',
      hasFederatedIdentity: true,
      hasOwnPassword: false,
      emailManagedByHub: false,
    });
  });

  it('reports hasOwnPassword once a federated account has set one, so the page asks for it', async () => {
    const { controller } = makeController(federatedUser(new Date()), { hasFederatedIdentity: true });

    await expect(controller.get(requestContext(), mockRequest())).resolves.toMatchObject({
      hasFederatedIdentity: true,
      hasOwnPassword: true,
    });
  });

  it('reports a Hub-provisioned account as having no password of its own, federated identity or not', async () => {
    const { controller } = makeController(hubProvisionedUser());

    await expect(controller.get(requestContext(), mockRequest())).resolves.toMatchObject({
      hasFederatedIdentity: false,
      hasOwnPassword: false,
    });
  });

  it('reports emailManagedByHub while the Hub signs the request in as this account', async () => {
    const { controller, hubBridge } = makeController(hubProvisionedUser(), { hubNamesAccount: true });
    const req = mockRequest();

    await expect(controller.get(requestContext(), req)).resolves.toMatchObject({ emailManagedByHub: true });
    expect(hubBridge.namesAccount).toHaveBeenCalledWith(req, 'jsmith@example.com');
  });
});

describe('AccountController — change email', () => {
  it('changes the email when the current password is correct', async () => {
    const { controller, userService } = makeController();

    const result = await controller.changeEmail(requestContext(), mockRequest(), {
      newEmail: 'new@example.com',
      currentPassword: 'correct-password',
    });

    expect(userService.validatePassword).toHaveBeenCalledWith('jsmith@example.com', 'correct-password');
    expect(userService.changeEmail).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new@example.com');
    expect(result).toEqual({ email: 'new@example.com' });
  });

  it('rejects with no current password on a non-federated account', async () => {
    const { controller, userService } = makeController();

    await expect(
      controller.changeEmail(requestContext(), mockRequest(), { newEmail: 'new@example.com' }),
    ).rejects.toThrow(BadRequestException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password', async () => {
    const { controller, userService } = makeController(undefined, { validPassword: false });

    await expect(
      controller.changeEmail(requestContext(), mockRequest(), {
        newEmail: 'new@example.com',
        currentPassword: 'wrong',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('asks a provisioned OIDC-linked account for a recent sign-in instead of a password it never saw', async () => {
    const { controller, userService } = makeController(federatedUser(), {
      hasFederatedIdentity: true,
      sessionAgeMs: 60_000,
    });

    await controller.changeEmail(requestContext(), mockRequest(), { newEmail: 'new@example.com' });

    expect(userService.changeEmail).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new@example.com');
    expect(userService.validatePassword).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a provisioned OIDC-linked account on a session older than the window', async () => {
    // The stolen-session case: a session hijacked yesterday cannot move the email today.
    const { controller, userService } = makeController(federatedUser(), {
      hasFederatedIdentity: true,
      sessionAgeMs: 11 * 60_000,
    });

    const error = await controller
      .changeEmail(requestContext(), mockRequest(), { newEmail: 'new@example.com' })
      .catch((err) => err);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({ message: 'REAUTH_REQUIRED' });
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a provisioned OIDC-linked account with no session cookie at all', async () => {
    const { controller, userService } = makeController(federatedUser(), {
      hasFederatedIdentity: true,
      sessionAgeMs: null,
    });

    const error = await controller
      .changeEmail(requestContext(), { cookies: {} } as unknown as Request, { newEmail: 'new@example.com' })
      .catch((err) => err);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('SECURITY: asks an OIDC-linked account that set its own password for that password, however fresh the session', async () => {
    const { controller, userService } = makeController(federatedUser(new Date()), {
      hasFederatedIdentity: true,
      sessionAgeMs: 0,
    });

    await expect(
      controller.changeEmail(requestContext(), mockRequest(), { newEmail: 'new@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userService.changeEmail).not.toHaveBeenCalled();

    await controller.changeEmail(requestContext(), mockRequest(), {
      newEmail: 'new@example.com',
      currentPassword: 'correct',
    });
    expect(userService.validatePassword).toHaveBeenCalledWith('jsmith@example.com', 'correct');
    expect(userService.changeEmail).toHaveBeenCalled();
  });

  it('asks a Hub-provisioned account (no federated identity) for a recent sign-in, not a password it never saw', async () => {
    const { controller, userService } = makeController(hubProvisionedUser(), { sessionAgeMs: 60_000 });

    await controller.changeEmail(requestContext(), mockRequest(), { newEmail: 'new@example.com' });

    expect(userService.changeEmail).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new@example.com');
    expect(userService.validatePassword).not.toHaveBeenCalled();
  });

  it('refuses while the Hub signs the request in as this account, before asking for any proof', async () => {
    // The bridge finds the account by this address alone: moving it would sign the
    // person into a fresh, empty account on their next page load.
    const { controller, userService, authService } = makeController(hubProvisionedUser(), {
      hubNamesAccount: true,
      sessionAgeMs: 0,
    });

    const error = await controller
      .changeEmail(requestContext(), mockRequest(), { newEmail: 'new@example.com' })
      .catch((err) => err);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(EMAIL_MANAGED_BY_HUB);
    expect(authService.sessionEstablishedAt).not.toHaveBeenCalled();
    expect(userService.validatePassword).not.toHaveBeenCalled();
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('refuses a password account the Hub signs in as too, even with the right password', async () => {
    // A signup account whose address the Hub also uses is linked the same way.
    const { controller, userService } = makeController(undefined, { hubNamesAccount: true });

    await expect(
      controller.changeEmail(requestContext(), mockRequest(), {
        newEmail: 'new@example.com',
        currentPassword: 'correct-password',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('rejects an email already in use and changes NOTHING', async () => {
    const { controller, userService } = makeController(undefined, { emailTaken: true });

    await expect(
      controller.changeEmail(requestContext(), mockRequest(), {
        newEmail: 'taken@example.com',
        currentPassword: 'correct-password',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(userService.changeEmail).not.toHaveBeenCalled();
  });

  it('rejects changing to the same email already on the account', async () => {
    const { controller, userService } = makeController();

    await expect(
      controller.changeEmail(requestContext(), mockRequest(), {
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

  it('lets a provisioned OIDC-linked account set its first password on a recent session', async () => {
    const { controller, userService } = makeController(federatedUser(), {
      hasFederatedIdentity: true,
      sessionAgeMs: 60_000,
    });

    await controller.changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-1' });

    expect(userService.changePassword).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new-password-1');
  });

  it('SECURITY: refuses to set a password for a provisioned OIDC-linked account on a stale session', async () => {
    // A stolen session must not become a password the attacker knows.
    const { controller, userService } = makeController(federatedUser(), {
      hasFederatedIdentity: true,
      sessionAgeMs: 11 * 60_000,
    });

    await expect(
      controller.changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userService.changePassword).not.toHaveBeenCalled();
  });

  it('lets a Hub-provisioned account (no federated identity) set its first password on a recent session', async () => {
    // The lockout this pins shut: the rule used to demand the bridge's random password
    // from every account with no federated identity, and the bridge binds none.
    const { controller, userService, federatedIdentityService } = makeController(hubProvisionedUser(), {
      sessionAgeMs: 60_000,
    });

    await controller.changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-1' });

    expect(userService.changePassword).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new-password-1');
    expect(userService.validatePassword).not.toHaveBeenCalled();
    // Keyed on the stamp alone: a bound federated identity no longer changes the answer.
    expect(federatedIdentityService.listForUser).not.toHaveBeenCalled();
  });

  it("lets it set that password while arriving through the Hub — only the email is the Hub's", async () => {
    const { controller, userService } = makeController(hubProvisionedUser(), {
      hubNamesAccount: true,
      sessionAgeMs: 60_000,
    });

    await controller.changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-1' });

    expect(userService.changePassword).toHaveBeenCalledWith({ userId: 'u1' }, 'u1', 'new-password-1');
  });

  it('SECURITY: refuses a Hub-provisioned account on a stale session', async () => {
    const { controller, userService } = makeController(hubProvisionedUser(), { sessionAgeMs: 11 * 60_000 });

    const error = await controller
      .changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-1' })
      .catch((err) => err);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({ message: 'REAUTH_REQUIRED' });
    expect(userService.changePassword).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a Hub-provisioned account with no session cookie (access token alone)', async () => {
    const { controller, userService } = makeController(hubProvisionedUser(), { sessionAgeMs: null });

    await expect(
      controller.changePassword(requestContext(), { cookies: {} } as unknown as Request, {
        newPassword: 'new-password-1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userService.changePassword).not.toHaveBeenCalled();
  });

  it('SECURITY: asks a Hub-provisioned account that has since set a password for it, however fresh the session', async () => {
    const { controller, userService } = makeController(
      { ...hubProvisionedUser(), passwordSetAt: new Date() },
      { sessionAgeMs: 0 },
    );

    await expect(
      controller.changePassword(requestContext(), mockRequest(), { newPassword: 'new-password-2' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userService.changePassword).not.toHaveBeenCalled();
  });
});

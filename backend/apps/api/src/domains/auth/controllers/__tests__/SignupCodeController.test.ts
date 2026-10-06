import { BadRequestException, NotFoundException } from '@nestjs/common';

import { SignupCodeController } from '../SignupCodeController';

const CREATED = new Date('2026-10-06T08:00:00Z');
const EXPIRES = new Date('2026-10-13T08:00:00Z');

function makeController() {
  const signupCodeService = {
    findUnused: jest.fn().mockResolvedValue([
      { id: '7', signup_code: 'abc123', used: false, issuedBy: 'owner-1', createdAt: CREATED, expiresAt: EXPIRES },
    ]),
    create: jest.fn(async (issuedBy: string | null) => ({
      id: '8',
      signup_code: 'def456',
      used: false,
      issuedBy,
      createdAt: CREATED,
      expiresAt: EXPIRES,
    })),
    revoke: jest.fn().mockResolvedValue(true),
  };

  return { controller: new SignupCodeController(signupCodeService as never), signupCodeService };
}

/**
 * Who may reach these routes is `ApplianceAdminGuard`'s business (its own suite). These pin what
 * the handlers add: an invitation records who issued it, says when it expires, and can be
 * withdrawn before anyone uses it.
 */
describe('SignupCodeController', () => {
  it('records the account minting an invitation as its issuer', async () => {
    const { controller, signupCodeService } = makeController();

    await expect(controller.mint({ userId: 'owner-1' })).resolves.toEqual({
      id: '8',
      signup_code: 'def456',
      created_at: CREATED,
      expires_at: EXPIRES,
    });
    expect(signupCodeService.create).toHaveBeenCalledWith('owner-1');
  });

  it('lists each invitation with the id to withdraw it by and when it expires', async () => {
    const { controller } = makeController();

    await expect(controller.list()).resolves.toEqual([
      { id: '7', signup_code: 'abc123', created_at: CREATED, expires_at: EXPIRES },
    ]);
  });

  it('withdraws an unused invitation', async () => {
    const { controller, signupCodeService } = makeController();

    await expect(controller.revoke('7')).resolves.toBeUndefined();
    expect(signupCodeService.revoke).toHaveBeenCalledWith('7');
  });

  it('404s when there is no unused invitation with that id', async () => {
    const { controller, signupCodeService } = makeController();
    signupCodeService.revoke.mockResolvedValue(false);

    await expect(controller.revoke('9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['abc', '0', '-1', '1.5', '1'.repeat(20)])('refuses %p as an id before touching anything', async (id) => {
    const { controller, signupCodeService } = makeController();

    await expect(controller.revoke(id)).rejects.toBeInstanceOf(BadRequestException);
    expect(signupCodeService.revoke).not.toHaveBeenCalled();
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { READ_CAPABILITY } from '@ci/common/decorators';

import { PendingActionsController } from '../PendingActionsController';

function harness() {
  const pending = { list: jest.fn(async () => []) } as any;
  const confirmations = {
    confirm: jest.fn(async () => ({ action: { id: 'pa-1' }, result: { success: true } })),
    decline: jest.fn(async () => ({ id: 'pa-1', status: 'declined' })),
  } as any;

  return { controller: new PendingActionsController(pending, confirmations), pending, confirmations };
}

// A scope-limited read-only key: `apiKeyCapabilityOf` only reads the capability
// when `apiKeyScopes` is present (an unscoped session is full authority).
const REQ = { apiKeyScopes: ['intents'], apiKeyCapability: READ_CAPABILITY } as any;

describe('PendingActionsController', () => {
  it('lists the caller’s own queue', async () => {
    const { controller, pending } = harness();

    await controller.list({ userId: 'user-1' });

    expect(pending.list).toHaveBeenCalledWith('user-1', undefined);
  });

  it('narrows by a known status', async () => {
    const { controller, pending } = harness();

    await controller.list({ userId: 'user-1' }, 'proposed');

    expect(pending.list).toHaveBeenCalledWith('user-1', 'proposed');
  });

  it('rejects an unknown status rather than silently returning the whole queue', async () => {
    const { controller } = harness();

    await expect(controller.list({ userId: 'user-1' }, 'pending')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an unauthenticated context on every route — there is no default owner', async () => {
    const { controller } = harness();

    await expect(controller.list({})).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.approve('pa-1', {}, REQ)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.decline('pa-1', {}, REQ)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('hands the confirming caller’s OWN capability to the confirm path', async () => {
    const { controller, confirmations } = harness();

    await controller.approve('pa-1', { userId: 'user-1' }, REQ);

    expect(confirmations.confirm).toHaveBeenCalledWith('user-1', 'pa-1', READ_CAPABILITY);
  });

  it('refuses an installed app the owner\u2019s decision, on both verbs', async () => {
    // Both harnesses carry the `intents` scope this controller requires, and
    // approve/decline sit behind READ capability — so without this a harness
    // could list the owner's queue and answer its own card. The card exists
    // BECAUSE the caller was an installed app; letting it answer makes the gate
    // a formality performed on itself.
    const { controller } = harness();
    const managedApp = { ...REQ, apiKeyManagedBy: 'connect' as const };

    await expect(
      controller.approve('pa-1', { userId: 'user-1' }, managedApp),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.decline('pa-1', { userId: 'user-1' }, managedApp),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('declines through the same owner scope', async () => {
    const { controller, confirmations } = harness();

    const response = await controller.decline('pa-1', { userId: 'user-1' }, REQ);

    expect(confirmations.decline).toHaveBeenCalledWith('user-1', 'pa-1');
    expect(response.action).toStrictEqual({ id: 'pa-1', status: 'declined' });
  });
});

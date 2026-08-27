/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

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
    await expect(controller.decline('pa-1', {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('hands the confirming caller’s OWN capability to the confirm path', async () => {
    const { controller, confirmations } = harness();

    await controller.approve('pa-1', { userId: 'user-1' }, REQ);

    expect(confirmations.confirm).toHaveBeenCalledWith('user-1', 'pa-1', READ_CAPABILITY);
  });

  it('declines through the same owner scope', async () => {
    const { controller, confirmations } = harness();

    const response = await controller.decline('pa-1', { userId: 'user-1' });

    expect(confirmations.decline).toHaveBeenCalledWith('user-1', 'pa-1');
    expect(response.action).toStrictEqual({ id: 'pa-1', status: 'declined' });
  });
});

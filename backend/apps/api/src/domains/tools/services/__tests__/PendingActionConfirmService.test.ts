/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { FULL_CAPABILITY, READ_CAPABILITY, WRITE_CAPABILITY } from '@ci/common/decorators';

import type { IntentDefinition } from '../../core/types';
import type { PendingAction } from '../../entities/PendingActionEntity';
import { PendingActionConfirmService } from '../PendingActionConfirmService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

const FORGET_SCHEMA: IntentDefinition = {
  name: 'memory.forget',
  domain: 'memory',
  title: 'Forget',
  description: 'Forget',
  parameters: {},
  localCapable: true,
  privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
};

function row(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 'pa-1',
    userId: 'user-1',
    intent: 'memory.forget',
    tool: 'memory_forget',
    input: { entityId: 'e-1' },
    reason: 'confirmation-required',
    origin: 'appliance',
    // Proposed by a FULL-capability dispatcher. The whole point of the tests
    // below is that this value grants the confirmer nothing.
    actor: FULL_CAPABILITY,
    status: 'proposed',
    createdAt: new Date('2026-08-26T10:00:00.000Z'),
    expiresAt: new Date('2026-08-27T10:00:00.000Z'),
    resolvedAt: null,
    result: null,
    ...overrides,
  } as PendingAction;
}

function harness(pendingRow: PendingAction | null = row()) {
  const pending = {
    findForUser: jest.fn(async () => pendingRow),
    markApproved: jest.fn(async () => ({ ...(pendingRow as PendingAction), status: 'approved' })),
    markExecuted: jest.fn(async () => ({ ...(pendingRow as PendingAction), status: 'executed' })),
    decline: jest.fn(async () => ({ ...(pendingRow as PendingAction), status: 'declined' })),
    expire: jest.fn(async () => ({ ...(pendingRow as PendingAction), status: 'expired' })),
  } as any;

  const executeTool = jest.fn(async () => ({ success: true, data: { removed: 1 } }));
  const registry = { getTool: jest.fn(() => ({ schema: FORGET_SCHEMA })), executeTool } as any;

  return {
    service: new PendingActionConfirmService(pending, registry, makeLogger()),
    pending,
    registry,
    executeTool,
  };
}

const NOW = new Date('2026-08-26T12:00:00.000Z');

describe('PendingActionConfirmService.confirm — the confirming principal is the one that is checked', () => {
  it('runs the intent for a confirmer whose own capability allows it', async () => {
    const { service, executeTool, pending } = harness();

    const outcome = await service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW);

    expect(outcome.result.success).toBe(true);
    expect(pending.markApproved).toHaveBeenCalledWith('user-1', 'pa-1');
    expect(pending.markExecuted).toHaveBeenCalledTimes(1);

    // Re-dispatched with the CONFIRMER's authority and the row id, never with
    // the proposing caller's.
    expect(executeTool).toHaveBeenCalledWith(
      'memory_forget',
      { userId: 'user-1', capability: FULL_CAPABILITY, pendingActionId: 'pa-1' },
      { entityId: 'e-1' },
    );
  });

  it.each([READ_CAPABILITY, WRITE_CAPABILITY])(
    'refuses a %s confirmer a delete proposed by a full-capability dispatcher',
    async (capability) => {
      const { service, executeTool, pending } = harness();

      await expect(service.confirm('user-1', 'pa-1', capability, NOW)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      // The two halves that make this a real guarantee rather than a message:
      // the tool never ran, and the row was never moved out of `proposed`.
      expect(executeTool).not.toHaveBeenCalled();
      expect(pending.markApproved).not.toHaveBeenCalled();
    },
  );

  it('refuses another user’s row without disclosing that it exists', async () => {
    const { service, executeTool } = harness(null);

    await expect(service.confirm('user-2', 'pa-1', FULL_CAPABILITY, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each(['approved', 'executed', 'declined', 'expired'] as const)(
    'refuses to re-confirm a row that is already %s',
    async (status) => {
      const { service, executeTool } = harness(row({ status }));

      await expect(service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(executeTool).not.toHaveBeenCalled();
    },
  );

  it('retires an overdue proposal instead of running it', async () => {
    const { service, executeTool, pending } = harness(
      row({ expiresAt: new Date('2026-08-26T11:59:59.000Z') }),
    );

    await expect(service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(pending.expire).toHaveBeenCalledWith('user-1', 'pa-1');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('refuses when the intent is no longer registered on this appliance', async () => {
    const { service, registry, executeTool } = harness();
    registry.getTool = jest.fn(() => undefined);

    await expect(service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe('PendingActionConfirmService.decline', () => {
  it('declines an open proposal', async () => {
    const { service, pending, executeTool } = harness();

    const declined = await service.decline('user-1', 'pa-1');

    expect(declined.status).toBe('declined');
    expect(pending.decline).toHaveBeenCalledWith('user-1', 'pa-1');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('refuses to decline something already resolved', async () => {
    const { service } = harness(row({ status: 'executed' }));

    await expect(service.decline('user-1', 'pa-1')).rejects.toBeInstanceOf(ConflictException);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { FULL_CAPABILITY, READ_CAPABILITY, WRITE_CAPABILITY } from '@ci/common/decorators';

import type { IntentDefinition } from '../../core/types';
import type { PendingAction } from '../../entities/PendingActionEntity';
import { PendingActionConfirmService } from '../PendingActionConfirmService';
import { PendingActionReplayRegistry } from '../PendingActionReplayRegistry';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
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
    // No app: proposed by the owner's own trust dial. The managed-app cases
    // below override it.
    principalName: null,
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
  const registry = {
    privacyOf: jest.fn(async (): Promise<IntentDefinition['privacy'] | undefined> => FORGET_SCHEMA.privacy),
    executeTool,
  } as any;
  const replays = new PendingActionReplayRegistry();

  return {
    service: new PendingActionConfirmService(pending, registry, makeLogger(), replays),
    replays,
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
      {
        userId: 'user-1',
        capability: FULL_CAPABILITY,
        pendingActionId: 'pa-1',
        principal: 'owner',
        principalName: null,
      },
      { entityId: 'e-1' },
    );
  });

  it("re-dispatches with the ROW's principal, so the ledger still names the app that asked", async () => {
    // Two different questions, and the ledger asks both: `capability` records
    // what authority ran the call (the owner's, always, on this path), and
    // `principal` records who asked for it. Carried from the confirming caller
    // instead, a confirmed OpenClaw send would be recorded as the owner having
    // sent it themselves — the attribution erased at the one moment it matters
    // most, since a confirmed action is by definition one that needed asking
    // about.
    const { service, executeTool } = harness(row({ principalName: 'app:ci-openclaw:ci-marketplace' }));

    await service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW);

    expect(executeTool).toHaveBeenCalledWith(
      'memory_forget',
      {
        userId: 'user-1',
        // Still the CONFIRMER's authority. Only the attribution comes from the row.
        capability: FULL_CAPABILITY,
        pendingActionId: 'pa-1',
        principal: 'managed-app',
        principalName: 'app:ci-openclaw:ci-marketplace',
      },
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
    registry.privacyOf = jest.fn(async () => undefined);

    await expect(service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe('PendingActionConfirmService.confirm — the label is the one the stored call earns', () => {
  it('refuses a write confirmer a call that only its per-call label marks destructive', async () => {
    const rememberRow = row({
      intent: 'memory.remember',
      tool: 'memory_remember',
      input: { operations: [] },
    });
    const { service, registry, pending, executeTool } = harness(rememberRow);
    registry.privacyOf = jest.fn(async () => ({
      access: 'write',
      sensitivity: 'personal',
      destructive: true,
      external: false,
    }));

    await expect(service.confirm('user-1', 'pa-1', WRITE_CAPABILITY, NOW)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(registry.privacyOf).toHaveBeenCalledWith(
      'memory_remember',
      { userId: 'user-1', capability: WRITE_CAPABILITY },
      { operations: [] },
    );
    expect(pending.markApproved).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
});

/**
 * A call from the GraphQL plane of /api/mcp is parked like a native intent, but its tool is not in
 * the registry: the MCP domain registers how to replay it, and replays it as the confirming request.
 */
describe('PendingActionConfirmService.confirm — a GraphQL-plane call', () => {
  const graphqlRow = () =>
    row({ intent: 'mutation_deletePerson', tool: 'mutation_deletePerson', input: { id: 'person-1' } });
  const request = { user: { id: 'user-1' } } as never;

  function withReplayer(pendingRow = graphqlRow()) {
    const h = harness(pendingRow);
    h.registry.privacyOf = jest.fn(async () => undefined);
    const replayer = {
      privacyOf: jest.fn((tool: string) =>
        tool === 'mutation_deletePerson' ? FORGET_SCHEMA.privacy : undefined,
      ),
      assertMayReplay: jest.fn(),
      replay: jest.fn(async () => ({ success: true, data: { success: true } })),
    };
    h.replays.register(replayer);

    return { ...h, replayer };
  }

  it('replays it through its replayer as the confirming request, not through the registry', async () => {
    const { service, replayer, pending, executeTool } = withReplayer();

    const outcome = await service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW, request);

    expect(outcome.result.success).toBe(true);
    expect(replayer.replay).toHaveBeenCalledWith('mutation_deletePerson', { id: 'person-1' }, request, {
      principalName: null,
    });
    expect(pending.markApproved).toHaveBeenCalledWith('user-1', 'pa-1');
    expect(pending.markExecuted).toHaveBeenCalledWith('user-1', 'pa-1', {
      success: true,
      data: { success: true },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('runs the capability check on the replayer label first', async () => {
    const { service, replayer, pending } = withReplayer();

    await expect(service.confirm('user-1', 'pa-1', WRITE_CAPABILITY, NOW, request)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(replayer.replay).not.toHaveBeenCalled();
    expect(pending.markApproved).not.toHaveBeenCalled();
  });

  it('lets the replayer refuse the confirming request before the row is approved', async () => {
    const { service, replayer, pending } = withReplayer();
    replayer.assertMayReplay.mockImplementation(() => {
      throw new ForbiddenException('scope-limited');
    });

    await expect(service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW, request)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(replayer.replay).not.toHaveBeenCalled();
    expect(pending.markApproved).not.toHaveBeenCalled();
  });

  it('still answers "no longer registered" when no replayer claims the tool', async () => {
    const { service, pending } = withReplayer(
      row({ tool: 'mutation_somethingGone', intent: 'mutation_somethingGone' }),
    );

    await expect(service.confirm('user-1', 'pa-1', FULL_CAPABILITY, NOW, request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(pending.markApproved).not.toHaveBeenCalled();
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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { FULL_CAPABILITY, READ_CAPABILITY } from '@ci/common/decorators';
import { PersonalizationService } from '@ci/domains/personalization/services/PersonalizationService';
import type { PersonalizationProfile, TrustMode } from '@ci/domains/personalization/types';

import type { IntentDefinition, ToolInvocationContext } from '../../core/types';
import type { PendingActionEntity } from '../../entities/PendingActionEntity';
import { PendingActionService, DEFAULT_PENDING_ACTION_TTL_HOURS } from '../PendingActionService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function schema(name: string, privacy: Partial<IntentDefinition['privacy']> = {}): IntentDefinition {
  return {
    name,
    domain: 'memory',
    title: name,
    description: name,
    parameters: {},
    localCapable: true,
    privacy: {
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
      ...privacy,
    },
  };
}

const FORGET = schema('memory.forget', { access: 'delete', destructive: true });
const SEND = schema('messaging.send', { access: 'write', external: true });
const RECALL = schema('memory.recall');

/**
 * The real `PersonalizationService.decide` over a real profile — the mapping
 * under test is "trust mode → queue or not", so faking `decideAction` would
 * assert nothing about the binding this feature actually makes.
 */
function personalizationFor(trustMode: TrustMode) {
  const profile: PersonalizationProfile = PersonalizationService.profileForTrustMode(trustMode);

  return {
    decideAction: jest.fn(async (_userId: string, input: any) =>
      PersonalizationService.decide(profile, input),
    ),
  } as any;
}

function makeRepository(rows: Partial<PendingActionEntity>[] = []) {
  const store = rows.map((r) => ({ ...r }) as PendingActionEntity);

  return {
    store,
    create: jest.fn((row: any) => ({ ...row })),
    save: jest.fn(async (row: any) => {
      const existing = store.find((r) => r.id === row.id);
      if (existing) {
        Object.assign(existing, row);

        return existing;
      }

      store.push(row);

      return row;
    }),
    findOne: jest.fn(async ({ where }: any) =>
      store.find((r) => r.id === where.id && (where.userId == null || r.userId === where.userId)) ?? null,
    ),
    find: jest.fn(async () => []),
    delete: jest.fn(async () => ({ affected: 0 })),
  } as any;
}

function features(enabled: boolean) {
  return { isFeatureEnabled: jest.fn(async () => enabled) } as any;
}

function context(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return { userId: 'user-1', capability: FULL_CAPABILITY, ...overrides };
}

describe('PendingActionService.evaluate — feature flag off is today’s behaviour', () => {
  it('executes a destructive intent even under the most cautious dial', async () => {
    const personalization = personalizationFor('cautious');
    const service = new PendingActionService(
      makeRepository(),
      personalization,
      features(false),
      makeLogger(),
    );

    const ruling = await service.evaluate(FORGET, context());

    expect(ruling.decision).toBe('execute');
    // Not merely "the answer was execute": the dial must not even be asked, so
    // turning the flag off cannot cost a Person lookup per tool call.
    expect(personalization.decideAction).not.toHaveBeenCalled();
  });

  it('ignores a `tier=local` caller entirely, so a queue branch this appliance switched off is unreachable', async () => {
    const service = new PendingActionService(
      makeRepository(),
      personalizationFor('cautious'),
      features(false),
      makeLogger(),
    );

    const ruling = await service.evaluate(FORGET, context({ tier: 'local' }));

    expect(ruling.decision).toBe('execute');
  });
});

describe('PendingActionService.evaluate — the trust dial binding', () => {
  it.each([
    ['hands_off', 'execute'],
    ['balanced', 'execute'],
    ['cautious', 'queue'],
  ] as const)('trust mode %s → %s for a destructive intent', async (trustMode, expected) => {
    const service = new PendingActionService(
      makeRepository(),
      personalizationFor(trustMode),
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(FORGET, context())).decision).toBe(expected);
  });

  it.each([
    ['hands_off', 'execute'],
    ['balanced', 'execute'],
    ['cautious', 'queue'],
  ] as const)('trust mode %s → %s for an external intent', async (trustMode, expected) => {
    const service = new PendingActionService(
      makeRepository(),
      personalizationFor(trustMode),
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(SEND, context())).decision).toBe(expected);
  });

  it('never consults the dial for an ordinary read, in any mode', async () => {
    const personalization = personalizationFor('cautious');
    const service = new PendingActionService(
      makeRepository(),
      personalization,
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(RECALL, context())).decision).toBe('execute');
    expect(personalization.decideAction).not.toHaveBeenCalled();
  });

  it('never turns a capability denial into a queue, whatever the dial says', async () => {
    const service = new PendingActionService(
      makeRepository(),
      personalizationFor('cautious'),
      features(true),
      makeLogger(),
    );

    const ruling = await service.evaluate(FORGET, context({ capability: READ_CAPABILITY }));

    expect(ruling.decision).toBe('deny');
  });
});

describe('PendingActionService.evaluate — the confirmation bypass is verified, not trusted', () => {
  const approved = {
    id: 'pa-1',
    userId: 'user-1',
    status: 'approved' as const,
  };

  it('stands aside for a real approved row belonging to the caller', async () => {
    const service = new PendingActionService(
      makeRepository([approved]),
      personalizationFor('cautious'),
      features(true),
      makeLogger(),
    );

    const ruling = await service.evaluate(FORGET, context({ pendingActionId: 'pa-1' }));

    expect(ruling.decision).toBe('execute');
  });

  it('re-gates a made-up id', async () => {
    const service = new PendingActionService(
      makeRepository([approved]),
      personalizationFor('cautious'),
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(FORGET, context({ pendingActionId: 'nope' }))).decision).toBe('queue');
  });

  it('re-gates another user’s approved row', async () => {
    const service = new PendingActionService(
      makeRepository([{ ...approved, userId: 'someone-else' }]),
      personalizationFor('cautious'),
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(FORGET, context({ pendingActionId: 'pa-1' }))).decision).toBe('queue');
  });

  it.each(['proposed', 'declined', 'expired', 'executed'] as const)(
    're-gates a row that is %s rather than approved',
    async (status) => {
      const service = new PendingActionService(
        makeRepository([{ ...approved, status }]),
        personalizationFor('cautious'),
        features(true),
        makeLogger(),
      );

      expect((await service.evaluate(FORGET, context({ pendingActionId: 'pa-1' }))).decision).toBe('queue');
    },
  );
});

describe('PendingActionService.propose', () => {
  it('records the proposing caller’s authority, the origin tier, the reason and a deadline', async () => {
    const repository = makeRepository();
    const service = new PendingActionService(
      repository,
      personalizationFor('cautious'),
      features(true),
      makeLogger(),
    );

    const now = new Date('2026-08-26T12:00:00.000Z');
    const saved = await service.propose(
      FORGET,
      'memory_forget',
      { userId: 'user-1', capability: FULL_CAPABILITY, tier: 'local' },
      { entityId: 'e-1' },
      { decision: 'queue', reason: 'destructive-requires-confirmation', explanation: 'x' },
      now,
    );

    expect(saved.status).toBe('proposed');
    expect(saved.intent).toBe('memory.forget');
    expect(saved.tool).toBe('memory_forget');
    expect(saved.actor).toBe(FULL_CAPABILITY);
    expect(saved.origin).toBe('local');
    expect(saved.reason).toBe('destructive-requires-confirmation');
    expect(saved.input).toStrictEqual({ entityId: 'e-1' });
    expect(saved.expiresAt?.toISOString()).toBe(
      new Date(now.getTime() + DEFAULT_PENDING_ACTION_TTL_HOURS * 3_600_000).toISOString(),
    );
  });
});

describe('PendingActionService.sweep', () => {
  it('expires overdue proposals and prunes long-resolved rows', async () => {
    const overdue = {
      id: 'pa-old',
      userId: 'user-1',
      status: 'proposed' as const,
      expiresAt: new Date('2026-08-25T00:00:00.000Z'),
      resolvedAt: null,
    };
    const repository = makeRepository([overdue]);
    repository.find = jest.fn(async () => [overdue]);
    repository.delete = jest.fn(async () => ({ affected: 3 }));

    const service = new PendingActionService(
      repository,
      personalizationFor('balanced'),
      features(true),
      makeLogger(),
    );

    const outcome = await service.sweep(new Date('2026-08-26T00:00:00.000Z'));

    expect(outcome).toStrictEqual({ expired: 1, pruned: 3 });
    expect(repository.store[0].status).toBe('expired');
    expect(repository.store[0].resolvedAt).toBeInstanceOf(Date);
  });

  it('does not abandon the batch when one row cannot be transitioned', async () => {
    const bad = { id: 'pa-bad', userId: 'u', status: 'executed' as const, expiresAt: new Date(0) };
    const good = { id: 'pa-good', userId: 'u', status: 'proposed' as const, expiresAt: new Date(0) };
    const repository = makeRepository([bad, good]);
    repository.find = jest.fn(async () => [bad, good]);

    const service = new PendingActionService(
      repository,
      personalizationFor('balanced'),
      features(true),
      makeLogger(),
    );

    const outcome = await service.sweep(new Date('2026-08-26T00:00:00.000Z'));

    expect(outcome.expired).toBe(1);
    expect(repository.store.find((r: any) => r.id === 'pa-good').status).toBe('expired');
    expect(repository.store.find((r: any) => r.id === 'pa-bad').status).toBe('executed');
  });
});

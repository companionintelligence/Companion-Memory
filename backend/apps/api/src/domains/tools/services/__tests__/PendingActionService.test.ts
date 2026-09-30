/* eslint-disable @typescript-eslint/no-explicit-any */
import { FULL_CAPABILITY, READ_CAPABILITY } from '@ci/common/decorators';
import { PersonalizationService } from '@ci/domains/personalization/services/PersonalizationService';
import type { PersonalizationProfile, TrustMode } from '@ci/domains/personalization/types';

import type { IntentDefinition, ToolInvocationContext } from '../../core/types';
import type { PendingActionEntity } from '../../entities/PendingActionEntity';
import { PendingActionService, DEFAULT_PENDING_ACTION_TTL_HOURS } from '../PendingActionService';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
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
// The owner's own texts, read off their BlueBubbles server: external, but a read.
const LIST_MESSAGES = schema('messaging.listMessages', { access: 'read', external: true });
// What `McpToolProvider` labels every connected-server tool, whatever it does.
const MCP_TOOL = schema('mcp.notes.search', {
  access: 'write',
  sensitivity: 'sensitive',
  destructive: true,
  external: true,
});
const COMPLETE_TASK = schema('planning.completeTask', { access: 'write', destructive: true });

/**
 * A real profile for the mode, served the way `PersonalizationService.getProfile`
 * serves it. `decideAction` is stubbed to fail loudly: the gate must read the
 * dial directly (see `trustForToolCall`), because routing a confidence-1 tool
 * call through the inference scorer is exactly how `balanced` used to answer
 * `auto` and run deletes unattended.
 */
function personalizationFor(trustMode: TrustMode) {
  const profile: PersonalizationProfile = PersonalizationService.profileForTrustMode(trustMode);

  return {
    getProfile: jest.fn(async () => profile),
    decideAction: jest.fn(async () => {
      throw new Error('a tool call must not be graded as an inference');
    }),
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
    findOne: jest.fn(
      async ({ where }: any) =>
        store.find((r) => r.id === where.id && (where.userId == null || r.userId === where.userId)) ?? null,
    ),
    // Equality on every `where` key — enough for `propose`'s open-card lookup,
    // which filters on plain columns only.
    find: jest.fn(async ({ where }: any = {}) =>
      store.filter((r: any) => Object.entries(where ?? {}).every(([key, value]) => r[key] === value)),
    ),
    delete: jest.fn(async () => ({ affected: 0 })),
  } as any;
}

function features(enabled: boolean) {
  return { isFeatureEnabled: jest.fn(async () => enabled) } as any;
}

function context(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return { userId: 'user-1', capability: FULL_CAPABILITY, ...overrides };
}

describe('PendingActionService.evaluate — feature flag off is the pre-gate behaviour', () => {
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
    // turning the flag off cannot cost a profile lookup per tool call.
    expect(personalization.getProfile).not.toHaveBeenCalled();
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
  // `balanced` is the default dial, so `balanced → queue` is the line that
  // closes the hole: a chat model steered by a planted email into a delete or
  // a send now produces a card, not an outcome. Only the owner explicitly
  // choosing hands-off waives that.
  it.each([
    ['hands_off', 'execute'],
    ['balanced', 'queue'],
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
    ['balanced', 'queue'],
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

  // An external READ changes nothing and sends nothing as the owner. Queuing
  // it under the default dial did not ask first so much as break the feature:
  // the approved run's result never reaches the chat that wanted it.
  it.each([
    ['hands_off', 'execute'],
    ['balanced', 'execute'],
    ['cautious', 'queue'],
  ] as const)('trust mode %s → %s for an external read', async (trustMode, expected) => {
    const service = new PendingActionService(
      makeRepository(),
      personalizationFor(trustMode),
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(LIST_MESSAGES, context())).decision).toBe(expected);
  });

  // `McpToolProvider` cannot know what a connected server's tool does, so it
  // labels every one destructive and external — and an unknown external tool
  // is exactly what a planted email would steer the model toward. Balanced
  // asks, as the Autonomy settings copy says.
  it.each([
    ['hands_off', 'execute'],
    ['balanced', 'queue'],
    ['cautious', 'queue'],
  ] as const)('trust mode %s → %s for a connected MCP server’s tool', async (trustMode, expected) => {
    const service = new PendingActionService(
      makeRepository(),
      personalizationFor(trustMode),
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(MCP_TOOL, context())).decision).toBe(expected);
  });

  it('asks under balanced before completing a task — destructive through its own tool', async () => {
    const service = new PendingActionService(
      makeRepository(),
      personalizationFor('balanced'),
      features(true),
      makeLogger(),
    );

    expect((await service.evaluate(COMPLETE_TASK, context())).decision).toBe('queue');
  });

  it('never consults the dial for an ordinary read, in any mode', async () => {
    const personalization = personalizationFor('cautious');
    const service = new PendingActionService(makeRepository(), personalization, features(true), makeLogger());

    expect((await service.evaluate(RECALL, context())).decision).toBe('execute');
    expect(personalization.getProfile).not.toHaveBeenCalled();
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

describe('PendingActionService.propose — one card per open question', () => {
  const QUEUE = { decision: 'queue', reason: 'confirmation-required', explanation: 'x' } as const;
  const NOW = new Date('2026-08-26T12:00:00.000Z');
  const owner = { userId: 'user-1', capability: FULL_CAPABILITY } as const;

  function service(repository = makeRepository()) {
    return {
      repository,
      service: new PendingActionService(
        repository,
        personalizationFor('balanced'),
        features(true),
        makeLogger(),
      ),
    };
  }

  it('hands back the open card for an identical retry instead of queueing a second', async () => {
    // The chat model reads TOOL_QUEUED as a failure and re-issues the send in
    // its second round. Two identical cards means approving both sends twice.
    const { repository, service: pending } = service();

    const first = await pending.propose(
      SEND,
      'messaging_send',
      owner,
      { to: 'Sam', text: 'late' },
      QUEUE,
      NOW,
    );
    // Same arguments in a different key order: jsonb does not keep the order.
    const second = await pending.propose(
      SEND,
      'messaging_send',
      owner,
      { text: 'late', to: 'Sam' },
      QUEUE,
      NOW,
    );

    expect(second.id).toBe(first.id);
    expect(repository.store).toHaveLength(1);
  });

  it('queues one card for two identical calls in the same round', async () => {
    // A round's tool calls run concurrently, so both would miss the lookup.
    const { repository, service: pending } = service();

    const [a, b] = await Promise.all([
      pending.propose(SEND, 'messaging_send', owner, { to: 'Sam', text: 'late' }, QUEUE, NOW),
      pending.propose(SEND, 'messaging_send', owner, { to: 'Sam', text: 'late' }, QUEUE, NOW),
    ]);

    expect(b.id).toBe(a.id);
    expect(repository.store).toHaveLength(1);
  });

  it('gives a different input its own card', async () => {
    const { repository, service: pending } = service();

    await pending.propose(SEND, 'messaging_send', owner, { to: 'Sam', text: 'late' }, QUEUE, NOW);
    await pending.propose(SEND, 'messaging_send', owner, { to: 'Sam', text: 'very late' }, QUEUE, NOW);

    expect(repository.store).toHaveLength(2);
  });

  it.each(['declined', 'executed', 'expired'] as const)(
    'does not reuse a card that is already %s',
    async (status) => {
      const { repository, service: pending } = service();
      const earlier = await pending.propose(SEND, 'messaging_send', owner, { to: 'Sam' }, QUEUE, NOW);
      repository.store[0].status = status;

      const again = await pending.propose(SEND, 'messaging_send', owner, { to: 'Sam' }, QUEUE, NOW);

      expect(again.id).not.toBe(earlier.id);
      expect(repository.store).toHaveLength(2);
    },
  );

  it('does not reuse a card whose deadline has passed, even before the sweep retires it', async () => {
    const { repository, service: pending } = service();
    const earlier = await pending.propose(SEND, 'messaging_send', owner, { to: 'Sam' }, QUEUE, NOW);

    const later = new Date(NOW.getTime() + (DEFAULT_PENDING_ACTION_TTL_HOURS + 1) * 3_600_000);
    const again = await pending.propose(SEND, 'messaging_send', owner, { to: 'Sam' }, QUEUE, later);

    expect(again.id).not.toBe(earlier.id);
    expect(repository.store).toHaveLength(2);
  });

  it('keeps an installed app’s card apart from the owner’s — approval replays as whoever asked', async () => {
    const { repository, service: pending } = service();
    const app = {
      ...owner,
      principal: 'managed-app',
      principalName: 'app:ci-openclaw:ci-marketplace',
    } as const;

    const mine = await pending.propose(SEND, 'messaging_send', owner, { to: 'Sam' }, QUEUE, NOW);
    const theirs = await pending.propose(SEND, 'messaging_send', app, { to: 'Sam' }, QUEUE, NOW);

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.principalName).toBe('app:ci-openclaw:ci-marketplace');
    expect(repository.store).toHaveLength(2);
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

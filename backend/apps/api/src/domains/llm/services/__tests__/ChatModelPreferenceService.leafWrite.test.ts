import type { UserServiceContext } from '@ci/common/context';
import {
  FakePropertiesRow,
  fakePersonServiceOver,
  flushAsync,
  type FakePersonService,
} from '@ci/domains/__tests__/support/plannerPropertiesRow';

import { ChatModelPreferenceService } from '../ChatModelPreferenceService';

const SELF_ID = 'self-entity-1';
const CONTEXT = { userId: 'user-1' } as UserServiceContext;

/**
 * Every read goes through `PersonService.findById`, which the fake PARKS
 * until a test releases it — this drains whatever parks, as it parks, until
 * `promise` settles. See the identical helper on
 * ImageDescriptionPreferenceService.leafWrite.test.ts for why a fixed
 * single release pass is not enough once a test chains more than one call.
 */
async function drive<T>(person: FakePersonService, promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  while (!settled) {
    await flushAsync();
    person.pendingReads.splice(0).forEach((release) => release());
  }

  return promise;
}

function harness() {
  const row = new FakePropertiesRow({
    first_name: 'Ada',
    planner: { trust_mode: 'balanced', source: 'onboarding' },
  });
  const person = fakePersonServiceOver(row, SELF_ID);
  const userContextService = { getSelfIdentity: async () => ({ entityId: SELF_ID }) };

  return {
    row,
    person,
    service: new ChatModelPreferenceService(person.service as never, userContextService as never),
  };
}

describe('ChatModelPreferenceService defaults', () => {
  it('has no chat model override, and tools/thinking default to enabled, for a user who never touched Settings', async () => {
    const { service, person } = harness();

    await expect(drive(person, service.getChatModel(CONTEXT.userId!))).resolves.toBeNull();
    await expect(drive(person, service.getToolsEnabled(CONTEXT.userId!))).resolves.toBe(true);
    await expect(drive(person, service.getThinkingEnabled(CONTEXT.userId!))).resolves.toBe(true);
  });

  it('treats a self entity that cannot be found the same as "no override" (no parked read to drive)', async () => {
    const row = new FakePropertiesRow();
    const person = fakePersonServiceOver(row, SELF_ID);
    const userContextService = { getSelfIdentity: async () => null };
    const service = new ChatModelPreferenceService(person.service as never, userContextService as never);

    // getSelfIdentity returning null short-circuits before findById is ever
    // called, so these resolve on their own — no parked read to release.
    await expect(service.getChatModel('missing-user')).resolves.toBeNull();
    await expect(service.getToolsEnabled('missing-user')).resolves.toBe(true);
  });
});

describe('ChatModelPreferenceService writes one leaf per setting', () => {
  it('writes `planner.chat_model` without touching tools_enabled/thinking_enabled/trust_mode', async () => {
    const { service, row, person } = harness();

    await service.setChatModel(CONTEXT, 'qwen3.6:27b');

    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      'planner.chat_model',
      'planner.source',
    ]);
    expect(row.planner.chat_model).toBe('qwen3.6:27b');
    expect(row.planner.trust_mode).toBe('balanced');
  });

  it('trims the chat model and stores an empty/blank string as null (no override)', async () => {
    const { service, row } = harness();

    await service.setChatModel(CONTEXT, '  qwen3.6:27b  ');
    expect(row.planner.chat_model).toBe('qwen3.6:27b');

    const cleared = await service.setChatModel(CONTEXT, '   ');
    expect(cleared).toBeNull();
    expect(row.planner.chat_model).toBeNull();
  });

  it('reflects a written chat model back once the cache is invalidated', async () => {
    const { service, person } = harness();

    await service.setChatModel(CONTEXT, 'qwen3.6:27b');

    await expect(drive(person, service.getChatModel(CONTEXT.userId!))).resolves.toBe('qwen3.6:27b');
  });

  it('writes tools_enabled and thinking_enabled independently, as their own leaves', async () => {
    const { service, row, person } = harness();

    await service.setToolsEnabled(CONTEXT, false);
    await service.setThinkingEnabled(CONTEXT, false);

    expect(person.leafCalls[0]![0]!.path).toEqual(['planner', 'tools_enabled']);
    expect(person.leafCalls[1]![0]!.path).toEqual(['planner', 'thinking_enabled']);
    expect(row.planner.tools_enabled).toBe(false);
    expect(row.planner.thinking_enabled).toBe(false);

    await expect(drive(person, service.getToolsEnabled(CONTEXT.userId!))).resolves.toBe(false);
    await expect(drive(person, service.getThinkingEnabled(CONTEXT.userId!))).resolves.toBe(false);
  });
});

describe('ChatModelPreferenceService writes for a user who has no self entity yet', () => {
  // `ci.users.entity_id` stays NULL until something self-anchored is ingested, and
  // an account whose data came from an import never gets one. Picking a model
  // from the composer then threw "Self entity not found" — a 500 the picker
  // answered by reverting to the default, six times in a row on an iOS QA run.
  const NEW_SELF_ID = 'provisioned-self-entity';

  function harnessWithoutSelf(provisioner?: { ensureSelfEntityForOwner: jest.Mock }) {
    const row = new FakePropertiesRow({});
    const person = fakePersonServiceOver(row, NEW_SELF_ID);
    const written: string[] = [];
    const inner = person.service.patchPropertyLeaves as (
      c: unknown,
      id: string,
      l: unknown,
    ) => Promise<unknown>;
    person.service.patchPropertyLeaves = jest.fn(async (context: unknown, id: string, leaves: unknown) => {
      written.push(id);

      return inner(context, id, leaves);
    });
    const userContextService = { getSelfIdentity: jest.fn(async () => null) };
    const moduleRef = provisioner ? { get: jest.fn(() => provisioner) } : undefined;

    return {
      row,
      written,
      userContextService,
      moduleRef,
      service: new ChatModelPreferenceService(
        person.service as never,
        userContextService as never,
        moduleRef as never,
      ),
    };
  }

  it('provisions the self entity and writes the preference onto it', async () => {
    const provisioner = {
      ensureSelfEntityForOwner: jest.fn(async () => ({ id: NEW_SELF_ID, type: 'Person' })),
    };
    const { service, row, written, moduleRef } = harnessWithoutSelf(provisioner);

    await expect(service.setChatModel(CONTEXT, 'qwen3.5:2b-mlx')).resolves.toBe('qwen3.5:2b-mlx');

    expect(moduleRef!.get).toHaveBeenCalledWith('SELF_ENTITY_PROVISIONER', { strict: false });
    expect(provisioner.ensureSelfEntityForOwner).toHaveBeenCalledWith(CONTEXT);
    expect(written).toStrictEqual([NEW_SELF_ID]);
    expect(row.planner.chat_model).toBe('qwen3.5:2b-mlx');
  });

  it('does the same for the tools and thinking toggles, which live on the same entity', async () => {
    const provisioner = {
      ensureSelfEntityForOwner: jest.fn(async () => ({ id: NEW_SELF_ID, type: 'Person' })),
    };
    const { service, row } = harnessWithoutSelf(provisioner);

    await service.setToolsEnabled(CONTEXT, false);
    await service.setThinkingEnabled(CONTEXT, false);

    expect(row.planner.tools_enabled).toBe(false);
    expect(row.planner.thinking_enabled).toBe(false);
  });

  it('does not provision when the user already has a self entity', async () => {
    const provisioner = { ensureSelfEntityForOwner: jest.fn() };
    const { service, userContextService, written } = harnessWithoutSelf(provisioner);
    userContextService.getSelfIdentity.mockResolvedValue({ entityId: SELF_ID } as never);

    await service.setChatModel(CONTEXT, 'qwen3.6:27b');

    expect(provisioner.ensureSelfEntityForOwner).not.toHaveBeenCalled();
    expect(written).toStrictEqual([SELF_ID]);
  });

  it('still fails, naming the real problem, when nothing can provision one', async () => {
    const withoutBinding = harnessWithoutSelf();
    const provisionerDeclines = harnessWithoutSelf({ ensureSelfEntityForOwner: jest.fn(async () => null) });

    await expect(withoutBinding.service.setChatModel(CONTEXT, 'x')).rejects.toThrow('Self entity not found');
    await expect(provisionerDeclines.service.setChatModel(CONTEXT, 'x')).rejects.toThrow(
      'Self entity not found',
    );
  });

  it('treats a missing provider binding like no provisioner rather than crashing on the lookup', async () => {
    const row = new FakePropertiesRow({});
    const person = fakePersonServiceOver(row, NEW_SELF_ID);
    const moduleRef = {
      get: jest.fn(() => {
        throw new Error('Nest could not find SELF_ENTITY_PROVISIONER');
      }),
    };
    const service = new ChatModelPreferenceService(
      person.service as never,
      { getSelfIdentity: async () => null } as never,
      moduleRef as never,
    );

    await expect(service.setChatModel(CONTEXT, 'x')).rejects.toThrow('Self entity not found');
  });
});

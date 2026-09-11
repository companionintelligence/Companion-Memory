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

import type { UserServiceContext } from '@ci/common/context';
import {
  FakePropertiesRow,
  fakePersonServiceOver,
  flushAsync,
  type FakePersonService,
} from '@ci/domains/__tests__/support/plannerPropertiesRow';

import { ImageDescriptionPreferenceService } from '../ImageDescriptionPreferenceService';

/**
 * `setEnabled` now reads `readEnabled` (a parked `findById`) both before AND
 * after the write, not once — so a fixed single `flushAsync` + one release
 * pass (the old pattern) leaves the second read parked forever. This drains
 * however many parked reads show up, as they show up, until `promise`
 * settles — decoupling the test from the exact number of internal reads.
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

const SELF_ID = 'self-entity-1';
const CONTEXT = { userId: 'user-1' } as UserServiceContext;
const MODEL = 'gemma4:e4b';

function harness(opts: { supportsVision?: boolean } = {}) {
  const row = new FakePropertiesRow({
    first_name: 'Ada',
    planner: { trust_mode: 'balanced', source: 'onboarding' },
  });
  const person = fakePersonServiceOver(row, SELF_ID);
  const userContextService = { getSelfIdentity: async () => ({ entityId: SELF_ID }) };
  const sent: unknown[] = [];
  const eventService = {
    send: async (...args: unknown[]) => {
      sent.push(args);
    },
  };
  const ollamaService = {
    resolveVisionModel: async () => ({ model: MODEL, supportsVision: opts.supportsVision ?? false }),
  };

  return {
    row,
    person,
    sent,
    service: new ImageDescriptionPreferenceService(
      person.service as never,
      userContextService as never,
      eventService as never,
      ollamaService as never,
    ),
  };
}

describe('ImageDescriptionPreferenceService.setEnabled writes one leaf', () => {
  it('sends `planner.image_description_overrides.<model>` as a leaf path, never a rebuilt planner object', async () => {
    const { service, person } = harness();

    await drive(person, service.setEnabled(CONTEXT, true));

    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      `planner.image_description_overrides.${MODEL}`,
      'planner.source',
    ]);
    expect(person.leafCalls[0]![0]!.value).toBe(true);
  });

  it('does not clobber a trust mode a concurrent writer commits to a different leaf', async () => {
    const { service, person, row } = harness();

    await drive(person, service.setEnabled(CONTEXT, true));

    // A true leaf write cannot see or touch a sibling leaf either way —
    // simulate the concurrent write landing right after, and confirm both hold.
    row.setLeaves([{ path: ['planner', 'trust_mode'], value: 'cautious' }]);

    expect((row.planner.image_description_overrides as Record<string, unknown>)[MODEL]).toBe(true);
    expect(row.planner.trust_mode).toBe('cautious');
  });

  it('does not clobber a DIFFERENT model’s override when this write targets its own leaf', async () => {
    const { service, person, row } = harness();

    // Another model already has an explicit override sitting in the bag.
    row.setLeaves([{ path: ['planner', 'image_description_overrides', 'qwen3.6:27b'], value: false }]);

    await drive(person, service.setEnabled(CONTEXT, true));

    const overrides = row.planner.image_description_overrides as Record<string, unknown>;

    expect(overrides[MODEL]).toBe(true);
    expect(overrides['qwen3.6:27b']).toBe(false);
  });

  it('fires a backfill only on a genuine off→on transition, not on an already-on model', async () => {
    const { service, person, sent } = harness({ supportsVision: true });

    // The model already defaults on (it supports vision); an explicit `true`
    // is not a transition and must not re-fire the backfill.
    await drive(person, service.setEnabled(CONTEXT, true));

    expect(sent).toHaveLength(0);
  });

  it('fires a backfill when an explicit override turns a defaulted-off model on', async () => {
    const { service, person, sent } = harness({ supportsVision: false });

    await drive(person, service.setEnabled(CONTEXT, true));

    expect(sent).toHaveLength(1);
  });

  it('clearing the override (enabled: null) returns to the model’s automatic default', async () => {
    const { service, person, row } = harness({ supportsVision: true });

    await drive(person, service.setEnabled(CONTEXT, false));
    expect((row.planner.image_description_overrides as Record<string, unknown>)[MODEL]).toBe(false);

    const resolved = await drive(person, service.setEnabled(CONTEXT, null));

    expect(resolved).toBe(true);
    expect((row.planner.image_description_overrides as Record<string, unknown>)[MODEL]).toBeNull();
  });
});

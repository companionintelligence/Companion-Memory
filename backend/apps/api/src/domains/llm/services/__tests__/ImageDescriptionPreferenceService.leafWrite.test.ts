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

function harness(opts: { supportsVision?: boolean; moduleRef?: unknown } = {}) {
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
      opts.moduleRef as never,
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

describe('ImageDescriptionPreferenceService for a user who has no self entity yet', () => {
  // `ci.users.entity_id` stays NULL until something self-anchored is ingested, and
  // an account whose data came from an import never gets one. `setEnabled` threw
  // "Self entity not found" — a 500 — for it, and `readEnabled` reads such a user
  // as OFF (no identity), whatever the vision model.
  const NEW_SELF_ID = 'provisioned-self-entity';

  function harnessWithoutSelf(
    opts: { supportsVision?: boolean; provisioner?: { ensureSelfEntityForOwner: jest.Mock } | null } = {},
  ) {
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

    // Once the provisioner has run, `ci.users.entity_id` points at the new entity.
    let provisioned = false;
    const provisioner =
      opts.provisioner === undefined
        ? {
            ensureSelfEntityForOwner: jest.fn(async () => {
              provisioned = true;

              return { id: NEW_SELF_ID, type: 'Person' };
            }),
          }
        : opts.provisioner;
    const userContextService = {
      getSelfIdentity: jest.fn(async () => (provisioned ? { entityId: NEW_SELF_ID } : null)),
    };
    const moduleRef = provisioner ? { get: jest.fn(() => provisioner) } : undefined;
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
      written,
      sent,
      provisioner,
      service: new ImageDescriptionPreferenceService(
        person.service as never,
        userContextService as never,
        eventService as never,
        ollamaService as never,
        moduleRef as never,
      ),
    };
  }

  it('provisions the caller’s self entity and writes the override onto it', async () => {
    const { service, person, row, written, provisioner } = harnessWithoutSelf();

    await drive(person, service.setEnabled(CONTEXT, true));

    expect(provisioner!.ensureSelfEntityForOwner).toHaveBeenCalledTimes(1);
    expect(provisioner!.ensureSelfEntityForOwner).toHaveBeenCalledWith(CONTEXT);
    expect(written).toStrictEqual([NEW_SELF_ID]);
    expect((row.planner.image_description_overrides as Record<string, unknown>)[MODEL]).toBe(true);
  });

  it('fires the backfill on the first enable for a vision model: with no self entity the setting read as off', async () => {
    const { service, person, sent } = harnessWithoutSelf({ supportsVision: true });

    await drive(person, service.setEnabled(CONTEXT, true));

    // Read after provisioning, the model's automatic default (on) would already
    // be showing and this off→on transition — and the descriptions of every image
    // already imported — would be lost.
    expect(sent).toHaveLength(1);
  });

  it('does not fire a backfill for an explicit "off"', async () => {
    const { service, person, sent, row } = harnessWithoutSelf({ supportsVision: true });

    await drive(person, service.setEnabled(CONTEXT, false));

    expect(sent).toHaveLength(0);
    expect((row.planner.image_description_overrides as Record<string, unknown>)[MODEL]).toBe(false);
  });

  it('never provisions on a READ: isEnabled keeps answering off for a user with no self entity', async () => {
    const { service, provisioner, person } = harnessWithoutSelf({ supportsVision: true });

    await expect(drive(person, service.isEnabled(CONTEXT.userId))).resolves.toBe(false);

    expect(provisioner!.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });

  it('does not provision when the user already has a self entity', async () => {
    const provisioner = { ensureSelfEntityForOwner: jest.fn() };
    const { service, person } = harness({ moduleRef: { get: () => provisioner } });

    await drive(person, service.setEnabled(CONTEXT, true));

    expect(provisioner.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });

  it('still fails with "Self entity not found" when nothing can provision one', async () => {
    const noBinding = harnessWithoutSelf({ provisioner: null });
    const declines = harnessWithoutSelf({
      provisioner: { ensureSelfEntityForOwner: jest.fn(async () => null) },
    });

    await expect(drive(noBinding.person, noBinding.service.setEnabled(CONTEXT, true))).rejects.toThrow(
      'Self entity not found',
    );
    await expect(drive(declines.person, declines.service.setEnabled(CONTEXT, true))).rejects.toThrow(
      'Self entity not found',
    );
    expect(noBinding.written).toStrictEqual([]);
    expect(declines.written).toStrictEqual([]);
  });
});

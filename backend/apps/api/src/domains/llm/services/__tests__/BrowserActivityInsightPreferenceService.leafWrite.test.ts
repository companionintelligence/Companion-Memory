import type { UserServiceContext } from '@ci/common/context';
import {
  FakePropertiesRow,
  fakePersonServiceOver,
  flushAsync,
} from '@ci/domains/__tests__/support/plannerPropertiesRow';

import { BrowserActivityInsightPreferenceService } from '../BrowserActivityInsightPreferenceService';

const SELF_ID = 'self-entity-1';
const CONTEXT = { userId: 'user-1' } as UserServiceContext;

function harness(opts: { moduleRef?: unknown } = {}) {
  const row = new FakePropertiesRow({
    first_name: 'Ada',
    planner: { trust_mode: 'balanced', source: 'onboarding' },
  });
  const person = fakePersonServiceOver(row, SELF_ID);
  const userContextService = { getSelfIdentity: async () => ({ entityId: SELF_ID }) };

  return {
    row,
    person,
    service: new BrowserActivityInsightPreferenceService(
      person.service as never,
      userContextService as never,
      opts.moduleRef as never,
    ),
  };
}

/** Drives a `setEnabled` call past its one `findById` read (an existence check, not a stale-read hazard here — see the test below). */
async function setEnabled(
  service: BrowserActivityInsightPreferenceService,
  person: ReturnType<typeof fakePersonServiceOver>,
  enabled: boolean,
): Promise<boolean> {
  const write = service.setEnabled(CONTEXT, enabled);
  await flushAsync();
  person.pendingReads.forEach((release) => release());

  return write;
}

describe('BrowserActivityInsightPreferenceService.setEnabled writes one leaf', () => {
  it('sends `planner.browser_activity_insight_enabled` as a leaf path, never a rebuilt planner object', async () => {
    const { service, person } = harness();

    await setEnabled(service, person, true);

    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls).toHaveLength(1);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      'planner.browser_activity_insight_enabled',
      'planner.source',
    ]);
    expect(person.leafCalls[0]![0]!.value).toBe(true);
  });

  it('does not touch a trust mode set alongside it', async () => {
    const { service, person, row } = harness();

    await setEnabled(service, person, true);

    expect(row.planner.browser_activity_insight_enabled).toBe(true);
    expect(row.planner.trust_mode).toBe('balanced');
  });
});

describe('BrowserActivityInsightPreferenceService.isEnabled', () => {
  it('defaults to false when the leaf was never set', async () => {
    const { service, person } = harness();

    const read = service.isEnabled(CONTEXT.userId!);
    await flushAsync();
    person.pendingReads.forEach((release) => release());

    await expect(read).resolves.toBe(false);
  });

  it('reflects a value written by setEnabled', async () => {
    const { service, person } = harness();

    await setEnabled(service, person, true);

    const read = service.isEnabled(CONTEXT.userId!);
    await flushAsync();
    person.pendingReads.forEach((release) => release());

    await expect(read).resolves.toBe(true);
  });
});

describe('BrowserActivityInsightPreferenceService for a user who has no self entity yet', () => {
  // `ci.users.entity_id` stays NULL until something self-anchored is ingested, and
  // an account whose data came from an import never gets one: `setEnabled` threw
  // "Self entity not found" (a 500) for it.
  const NEW_SELF_ID = 'provisioned-self-entity';

  function harnessWithoutSelf(opts: { provisioner?: { ensureSelfEntityForOwner: jest.Mock } | null } = {}) {
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

    return {
      row,
      person,
      written,
      provisioner,
      service: new BrowserActivityInsightPreferenceService(
        person.service as never,
        userContextService as never,
        moduleRef as never,
      ),
    };
  }

  it('provisions the caller’s self entity and writes the flag onto it', async () => {
    const { service, person, row, written, provisioner } = harnessWithoutSelf();

    await expect(setEnabled(service, person, true)).resolves.toBe(true);

    expect(provisioner!.ensureSelfEntityForOwner).toHaveBeenCalledTimes(1);
    expect(provisioner!.ensureSelfEntityForOwner).toHaveBeenCalledWith(CONTEXT);
    expect(written).toStrictEqual([NEW_SELF_ID]);
    expect(row.planner.browser_activity_insight_enabled).toBe(true);
    expect(row.planner.source).toBe('settings');
  });

  it('reads the flag back from the entity it provisioned', async () => {
    const { service, person } = harnessWithoutSelf();

    await setEnabled(service, person, true);

    const read = service.isEnabled(CONTEXT.userId!);
    await flushAsync();
    person.pendingReads.forEach((release) => release());

    await expect(read).resolves.toBe(true);
  });

  it('never provisions on a READ: isEnabled keeps answering off for a user with no self entity', async () => {
    const { service, provisioner } = harnessWithoutSelf();

    await expect(service.isEnabled(CONTEXT.userId!)).resolves.toBe(false);

    expect(provisioner!.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });

  it('does not provision when the user already has a self entity', async () => {
    const provisioner = { ensureSelfEntityForOwner: jest.fn() };
    const { service, person } = harness({ moduleRef: { get: () => provisioner } });

    await setEnabled(service, person, true);

    expect(provisioner.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });

  it('still fails with "Self entity not found" when nothing can provision one', async () => {
    const noBinding = harnessWithoutSelf({ provisioner: null });
    const declines = harnessWithoutSelf({
      provisioner: { ensureSelfEntityForOwner: jest.fn(async () => null) },
    });

    // It throws before the existence read, so there is no parked read to release.
    await expect(noBinding.service.setEnabled(CONTEXT, true)).rejects.toThrow('Self entity not found');
    await expect(declines.service.setEnabled(CONTEXT, true)).rejects.toThrow('Self entity not found');
    expect(noBinding.written).toStrictEqual([]);
    expect(declines.written).toStrictEqual([]);
  });
});

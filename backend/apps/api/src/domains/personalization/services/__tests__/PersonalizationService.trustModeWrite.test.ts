import type { UserServiceContext } from '@ci/common/context';
import {
  FakePropertiesRow,
  fakePersonServiceOver,
  flushAsync,
} from '@ci/domains/__tests__/support/plannerPropertiesRow';

import { PersonalizationService } from '../PersonalizationService';

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
    service: new PersonalizationService(
      person.service as never,
      userContextService as never,
      opts.moduleRef as never,
    ),
  };
}

describe('PersonalizationService.updateTrustMode writes one leaf', () => {
  it('sends `planner.trust_mode` as a leaf path, never a rebuilt planner object', async () => {
    const { service, person } = harness();

    const write = service.updateTrustMode(CONTEXT, 'cautious');
    await flushAsync();
    person.pendingReads.forEach((release) => release());
    await write;

    // The top-level shallow merge is what loses other writers' leaves.
    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls).toHaveLength(1);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      'planner.trust_mode',
      'planner.source',
    ]);
    expect(person.leafCalls[0]![0]!.value).toBe('cautious');
  });

  it('does not clobber a sibling leaf another writer committed after our read', async () => {
    const { service, person, row } = harness();

    // We read...
    const write = service.updateTrustMode(CONTEXT, 'cautious');
    await flushAsync();
    expect(person.pendingReads).toHaveLength(1);

    // ...the other settings writer (ImageDescriptionPreferenceService, whose
    // domain this spec may not import) commits its own leaf...
    row.setLeaves([{ path: ['planner', 'image_description_enabled'], value: true }]);

    // ...and only then does our write land.
    person.pendingReads.forEach((release) => release());
    await write;

    expect(row.planner.trust_mode).toBe('cautious');
    // Sending a rebuilt `planner` here would resurrect the pre-read absence.
    expect(row.planner.image_description_enabled).toBe(true);
    expect(row.properties.first_name).toBe('Ada');
  });
});

describe('PersonalizationService for a user who has no self entity yet', () => {
  // Settings → Autonomy. `ci.users.entity_id` stays NULL until something
  // self-anchored is ingested, and an account whose data came from an import never
  // gets one: `updateTrustMode` threw "Self entity not found" (a 500), so the
  // trust dial could not be saved at all — and the dial decides what the
  // appliance may do unattended.
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
      service: new PersonalizationService(
        person.service as never,
        userContextService as never,
        moduleRef as never,
      ),
    };
  }

  /** `updateTrustMode`, driven past its one existence read. */
  async function updateTrustMode(
    service: PersonalizationService,
    person: ReturnType<typeof fakePersonServiceOver>,
    mode: Parameters<PersonalizationService['updateTrustMode']>[1],
  ) {
    const write = service.updateTrustMode(CONTEXT, mode);
    await flushAsync();
    person.pendingReads.forEach((release) => release());

    return write;
  }

  it('provisions the caller’s self entity and writes the trust mode onto it', async () => {
    const { service, person, row, written, provisioner } = harnessWithoutSelf();

    const profile = await updateTrustMode(service, person, 'cautious');

    expect(profile.trustMode).toBe('cautious');
    expect(provisioner!.ensureSelfEntityForOwner).toHaveBeenCalledTimes(1);
    expect(provisioner!.ensureSelfEntityForOwner).toHaveBeenCalledWith(CONTEXT);
    expect(written).toStrictEqual([NEW_SELF_ID]);
    expect(row.planner.trust_mode).toBe('cautious');
  });

  it('writes exactly the two leaves it always wrote: provisioning widens nothing', async () => {
    const { service, person } = harnessWithoutSelf();

    await updateTrustMode(service, person, 'hands_off');

    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls).toHaveLength(1);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      'planner.trust_mode',
      'planner.source',
    ]);
  });

  it('reads the mode back from the entity it provisioned', async () => {
    const { service, person } = harnessWithoutSelf();

    await updateTrustMode(service, person, 'hands_off');

    const read = service.getProfile(CONTEXT.userId);
    await flushAsync();
    person.pendingReads.forEach((release) => release());

    await expect(read).resolves.toMatchObject({ trustMode: 'hands_off' });
  });

  it('never provisions on a READ: getProfile keeps answering the default for a user with no self entity', async () => {
    const { service, provisioner } = harnessWithoutSelf();

    await expect(service.getProfile(CONTEXT.userId)).resolves.toMatchObject({ trustMode: 'balanced' });
    await expect(service.getTrustMode(CONTEXT.userId)).resolves.toBe('balanced');

    expect(provisioner!.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });

  it('does not provision when the user already has a self entity', async () => {
    const provisioner = { ensureSelfEntityForOwner: jest.fn() };
    const { service, person } = harness({ moduleRef: { get: () => provisioner } });

    await updateTrustMode(service, person, 'cautious');

    expect(provisioner.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });

  it('still fails with "Self entity not found" when nothing can provision one, and writes nothing', async () => {
    const noBinding = harnessWithoutSelf({ provisioner: null });
    const declines = harnessWithoutSelf({
      provisioner: { ensureSelfEntityForOwner: jest.fn(async () => null) },
    });

    // It throws before the existence read, so there is no parked read to release.
    await expect(noBinding.service.updateTrustMode(CONTEXT, 'cautious')).rejects.toThrow(
      'Self entity not found',
    );
    await expect(declines.service.updateTrustMode(CONTEXT, 'cautious')).rejects.toThrow(
      'Self entity not found',
    );
    expect(noBinding.written).toStrictEqual([]);
    expect(declines.written).toStrictEqual([]);
  });
});

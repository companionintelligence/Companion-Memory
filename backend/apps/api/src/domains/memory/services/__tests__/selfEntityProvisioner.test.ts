import type { ModuleRef } from '@nestjs/core';

import type { UserServiceContext } from '@ci/common/context';

import {
  SELF_ENTITY_PROVISIONER,
  ensureSelfEntityId,
  resolveSelfEntityProvisioner,
  type SelfEntityProvisioner,
} from '../selfEntityProvisioner';

const OWNER = { userId: 'user-1' } as UserServiceContext;

function moduleRefBinding(provisioner: SelfEntityProvisioner): ModuleRef {
  return { get: jest.fn(() => provisioner) } as unknown as ModuleRef;
}

describe('ensureSelfEntityId', () => {
  it('returns the existing self entity and provisions nothing', async () => {
    const lookup = { getSelfIdentity: jest.fn(async () => ({ entityId: 'self-existing' })) };
    const provisioner = { ensureSelfEntityForOwner: jest.fn() };

    await expect(ensureSelfEntityId(OWNER, lookup, moduleRefBinding(provisioner))).resolves.toBe(
      'self-existing',
    );

    expect(lookup.getSelfIdentity).toHaveBeenCalledWith('user-1');
    expect(provisioner.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });

  // The account the iOS QA run had: `ci.users.entity_id` NULL, no `is_self` Person.
  it('provisions the caller’s own self entity when the user has none, and returns its id', async () => {
    const lookup = { getSelfIdentity: jest.fn(async () => null) };
    const provisioner = {
      ensureSelfEntityForOwner: jest.fn(async () => ({ id: 'self-new', type: 'Person' })),
    };
    const moduleRef = moduleRefBinding(provisioner);

    await expect(ensureSelfEntityId(OWNER, lookup, moduleRef)).resolves.toBe('self-new');

    expect(moduleRef.get).toHaveBeenCalledWith(SELF_ENTITY_PROVISIONER, { strict: false });
    // Ownership: the provisioner gets the caller's context, the very object, and
    // is asked about nobody else. It is called once, for this user.
    expect(provisioner.ensureSelfEntityForOwner).toHaveBeenCalledTimes(1);
    expect((provisioner.ensureSelfEntityForOwner.mock.calls as unknown[][])[0]![0]).toBe(OWNER);
    expect(lookup.getSelfIdentity).toHaveBeenCalledTimes(1);
    expect(lookup.getSelfIdentity).toHaveBeenCalledWith('user-1');
  });

  it('keeps the old error when nothing can provision one, so the real problem is still named', async () => {
    const lookup = { getSelfIdentity: jest.fn(async () => null) };
    const declines = moduleRefBinding({ ensureSelfEntityForOwner: jest.fn(async () => null) });
    const noBinding = {
      get: jest.fn(() => {
        throw new Error('Nest could not find SELF_ENTITY_PROVISIONER');
      }),
    } as unknown as ModuleRef;

    await expect(ensureSelfEntityId(OWNER, lookup, declines)).rejects.toThrow('Self entity not found');
    await expect(ensureSelfEntityId(OWNER, lookup, noBinding)).rejects.toThrow('Self entity not found');
    await expect(ensureSelfEntityId(OWNER, lookup, undefined)).rejects.toThrow('Self entity not found');
  });

  it('lets a provisioning failure through as itself rather than hiding it behind "not found"', async () => {
    const lookup = { getSelfIdentity: jest.fn(async () => null) };
    const broken = moduleRefBinding({
      ensureSelfEntityForOwner: jest.fn(async () => {
        throw new Error('deadlock detected');
      }),
    });

    await expect(ensureSelfEntityId(OWNER, lookup, broken)).rejects.toThrow('deadlock detected');
  });

  it('does not provision when the lookup itself fails', async () => {
    const lookup = {
      getSelfIdentity: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    const provisioner = { ensureSelfEntityForOwner: jest.fn() };

    await expect(ensureSelfEntityId(OWNER, lookup, moduleRefBinding(provisioner))).rejects.toThrow(
      'connection reset',
    );
    expect(provisioner.ensureSelfEntityForOwner).not.toHaveBeenCalled();
  });
});

describe('resolveSelfEntityProvisioner', () => {
  it('returns the bound provisioner', () => {
    const provisioner = { ensureSelfEntityForOwner: jest.fn() };

    expect(resolveSelfEntityProvisioner(moduleRefBinding(provisioner))).toBe(provisioner);
  });

  it('returns null — never throws — for no ModuleRef, an unbound token, or a binding that resolves to nothing', () => {
    const unbound = {
      get: jest.fn(() => {
        throw new Error('not bound');
      }),
    } as unknown as ModuleRef;
    const empty = { get: jest.fn(() => undefined) } as unknown as ModuleRef;

    expect(resolveSelfEntityProvisioner(undefined)).toBeNull();
    expect(resolveSelfEntityProvisioner(unbound)).toBeNull();
    expect(resolveSelfEntityProvisioner(empty)).toBeNull();
  });
});

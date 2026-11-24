/**
 * The self-entity provisioner is found through Nest's `ModuleRef`, not injected
 * (see `SELF_ENTITY_PROVISIONER`: `GraphModule` binds it and imports
 * `MemoryModule`, so a constructor injection would close a module cycle). The unit
 * tests hand the service a fake `ModuleRef`; this one lets Nest build it, with the
 * provisioner registered in a module its own module knows nothing about — which is
 * how the real app wires it.
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { type UserServiceContext } from '@ci/common/context';
import { PersonService, SELF_ENTITY_PROVISIONER, UserContextService } from '@ci/domains/memory';

import { PersonalizationService } from '../PersonalizationService';

const context = { userId: 'user-1' } as UserServiceContext;

describe('PersonalizationService finds the self-entity provisioner through Nest', () => {
  it('provisions the caller’s entity for the Autonomy write, then writes the trust mode onto it', async () => {
    const ensureSelfEntityForOwner = jest.fn(async () => ({ id: 'self-1', type: 'Person' }));
    const patchPropertyLeaves = jest.fn(async () => ({}));

    @Module({
      providers: [
        PersonalizationService,
        {
          provide: PersonService,
          // A just-provisioned entity exists, and has no preferences yet.
          useValue: { patchPropertyLeaves, findById: async () => ({ id: 'self-1', properties: {} }) },
        },
        // Nothing is a self entity until the provisioner runs.
        { provide: UserContextService, useValue: { getSelfIdentity: jest.fn(async () => null) } },
      ],
    })
    class PersonalizationModuleUnderTest {}

    // Stands in for GraphModule: provides the token, exports nothing to the other.
    @Module({
      providers: [{ provide: SELF_ENTITY_PROVISIONER, useValue: { ensureSelfEntityForOwner } }],
    })
    class GraphLikeModule {}

    const app = await Test.createTestingModule({
      imports: [PersonalizationModuleUnderTest, GraphLikeModule],
    }).compile();

    const profile = await app.get(PersonalizationService).updateTrustMode(context, 'cautious');

    expect(profile.trustMode).toBe('cautious');
    expect(ensureSelfEntityForOwner).toHaveBeenCalledWith(context);
    expect(patchPropertyLeaves).toHaveBeenCalledWith(
      context,
      'self-1',
      expect.arrayContaining([{ path: ['planner', 'trust_mode'], value: 'cautious' }]),
    );
  });
});

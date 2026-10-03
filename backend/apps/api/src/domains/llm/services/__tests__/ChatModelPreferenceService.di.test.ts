/**
 * The self-entity provisioner is found through Nest's `ModuleRef`, not injected:
 * `GraphModule` binds it and imports `MemoryModule`, so a constructor injection
 * here would close a module cycle (see `SELF_ENTITY_PROVISIONER`). The unit tests
 * hand the service a fake `ModuleRef`; this one lets Nest build it, with the
 * provisioner registered in a module the service's own module knows nothing
 * about — which is how the real app wires it.
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { type UserServiceContext } from '@ci/common/context';
import { PersonService, SELF_ENTITY_PROVISIONER, UserContextService } from '@ci/domains/memory';

import { ChatModelPreferenceService } from '../ChatModelPreferenceService';

const context = { userId: 'user-1' } as UserServiceContext;

describe('ChatModelPreferenceService dependency injection', () => {
  it('finds a provisioner bound in another module and writes the preference onto the entity it provisions', async () => {
    const ensureSelfEntityForOwner = jest.fn(async () => ({ id: 'self-1', type: 'Person' }));
    const patchPropertyLeaves = jest.fn(async () => ({}));

    @Module({
      providers: [
        ChatModelPreferenceService,
        { provide: PersonService, useValue: { patchPropertyLeaves } },
        { provide: UserContextService, useValue: { getSelfIdentity: async () => null } },
      ],
    })
    class PreferenceModule {}

    // Stands in for GraphModule: provides the token, exports nothing to the other.
    @Module({
      providers: [{ provide: SELF_ENTITY_PROVISIONER, useValue: { ensureSelfEntityForOwner } }],
    })
    class GraphLikeModule {}

    const app = await Test.createTestingModule({ imports: [PreferenceModule, GraphLikeModule] }).compile();

    await app.get(ChatModelPreferenceService).setChatModel(context, 'qwen3.5:2b-mlx');

    expect(ensureSelfEntityForOwner).toHaveBeenCalledWith(context);
    expect(patchPropertyLeaves).toHaveBeenCalledWith(
      context,
      'self-1',
      expect.arrayContaining([{ path: ['planner', 'chat_model'], value: 'qwen3.5:2b-mlx' }]),
    );
  });

  it('still constructs where no module binds a provisioner', async () => {
    @Module({
      providers: [
        ChatModelPreferenceService,
        { provide: PersonService, useValue: {} },
        { provide: UserContextService, useValue: { getSelfIdentity: async () => null } },
      ],
    })
    class LoneModule {}

    const app = await Test.createTestingModule({ imports: [LoneModule] }).compile();

    await expect(app.get(ChatModelPreferenceService).setChatModel(context, 'x')).rejects.toThrow(
      'Self entity not found',
    );
  });
});

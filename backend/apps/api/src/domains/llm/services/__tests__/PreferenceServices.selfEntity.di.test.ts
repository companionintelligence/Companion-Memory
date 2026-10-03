/**
 * The self-entity provisioner is found through Nest's `ModuleRef`, not injected
 * (see `SELF_ENTITY_PROVISIONER`: `GraphModule` binds it and imports
 * `MemoryModule`, so a constructor injection would close a module cycle). The unit
 * tests hand each service a fake `ModuleRef`; these let Nest build the two
 * services that gained that parameter, with the provisioner registered in a module
 * their own module knows nothing about — which is how the real app wires it.
 * `ChatModelPreferenceService.di.test.ts` does the same for the third.
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import { PersonService, SELF_ENTITY_PROVISIONER, UserContextService } from '@ci/domains/memory';

import { BrowserActivityInsightPreferenceService } from '../BrowserActivityInsightPreferenceService';
import { ImageDescriptionPreferenceService } from '../ImageDescriptionPreferenceService';
import { OllamaService } from '../OllamaService';

const context = { userId: 'user-1' } as UserServiceContext;

function appWith(
  service: typeof BrowserActivityInsightPreferenceService | typeof ImageDescriptionPreferenceService,
  ensureSelfEntityForOwner: jest.Mock,
  patchPropertyLeaves: jest.Mock,
) {
  const send = jest.fn(async () => []);

  @Module({
    providers: [
      service,
      {
        provide: PersonService,
        // A just-provisioned entity exists, and has no preferences yet.
        useValue: {
          patchPropertyLeaves,
          findById: async () => ({ id: 'self-1', properties: {} }),
        },
      },
      // Nothing is a self entity until the provisioner runs.
      { provide: UserContextService, useValue: { getSelfIdentity: jest.fn(async () => null) } },
      { provide: EventService, useValue: { send } },
      {
        provide: OllamaService,
        useValue: { resolveVisionModel: async () => ({ model: 'gemma4:e4b', supportsVision: false }) },
      },
    ],
  })
  class PreferenceModule {}

  // Stands in for GraphModule: provides the token, exports nothing to the other.
  @Module({
    providers: [{ provide: SELF_ENTITY_PROVISIONER, useValue: { ensureSelfEntityForOwner } }],
  })
  class GraphLikeModule {}

  return Test.createTestingModule({ imports: [PreferenceModule, GraphLikeModule] }).compile();
}

describe('Settings preference writers find the self-entity provisioner through Nest', () => {
  it('BrowserActivityInsightPreferenceService provisions, then writes onto the new entity', async () => {
    const ensureSelfEntityForOwner = jest.fn(async () => ({ id: 'self-1', type: 'Person' }));
    const patchPropertyLeaves = jest.fn(async () => ({}));
    const app = await appWith(
      BrowserActivityInsightPreferenceService,
      ensureSelfEntityForOwner,
      patchPropertyLeaves,
    );

    await app.get(BrowserActivityInsightPreferenceService).setEnabled(context, true);

    expect(ensureSelfEntityForOwner).toHaveBeenCalledWith(context);
    expect(patchPropertyLeaves).toHaveBeenCalledWith(
      context,
      'self-1',
      expect.arrayContaining([{ path: ['planner', 'browser_activity_insight_enabled'], value: true }]),
    );
  });

  it('ImageDescriptionPreferenceService provisions, then writes onto the new entity', async () => {
    const ensureSelfEntityForOwner = jest.fn(async () => ({ id: 'self-1', type: 'Person' }));
    const patchPropertyLeaves = jest.fn(async () => ({}));
    const app = await appWith(
      ImageDescriptionPreferenceService,
      ensureSelfEntityForOwner,
      patchPropertyLeaves,
    );

    await app.get(ImageDescriptionPreferenceService).setEnabled(context, false);

    expect(ensureSelfEntityForOwner).toHaveBeenCalledWith(context);
    expect(patchPropertyLeaves).toHaveBeenCalledWith(
      context,
      'self-1',
      expect.arrayContaining([
        { path: ['planner', 'image_description_overrides', 'gemma4:e4b'], value: false },
      ]),
    );
  });
});

import { type RequestContext } from '@ci/common/context';
import { ChatModelPreferenceService } from '@ci/domains/llm';
import { type PersonService, type UserContextService } from '@ci/domains/memory';

import { PersonalizationController } from '../controllers/PersonalizationController';
import { type PersonalizationService } from '../services/PersonalizationService';

describe('PersonalizationController & ChatModelPreferenceService — Memory Governance & Decision Engines', () => {
  function makeController() {
    const plannerBag: Record<string, unknown> = {};

    const userContextService = {
      getSelfIdentity: jest.fn(async () => ({ entityId: 'self-entity-1' })),
    } as unknown as UserContextService;

    const personService = {
      findById: jest.fn(async () => ({
        id: 'self-entity-1',
        properties: { planner: plannerBag },
      })),
      patchPropertyLeaves: jest.fn(
        async (_ctx: unknown, _id: string, leaves: Array<{ path: string[]; value: unknown }>) => {
          for (const leaf of leaves) {
            if (leaf.path[0] === 'planner' && leaf.path[1]) {
              plannerBag[leaf.path[1]] = leaf.value;
            }
          }
        },
      ),
    } as unknown as PersonService;

    const chatModelPref = new ChatModelPreferenceService(personService, userContextService);
    const controller = new PersonalizationController(
      {} as PersonalizationService,
      {} as never,
      {} as never,
      chatModelPref,
    );

    return { controller, chatModelPref, plannerBag, personService };
  }

  it('defaults both Memory Governance and Decision Engine flags to true and persists updates', async () => {
    const { controller } = makeController();
    const ctx = { userId: 'user-1' } as RequestContext;

    const initialGov = await controller.getMemoryGovernance(ctx);
    expect(initialGov).toEqual({
      memoryGovernanceEnabled: true,
      memoryRecencyDecayEnabled: true,
    });

    const updatedGov = await controller.updateMemoryGovernance(ctx, {
      memoryGovernanceEnabled: false,
      memoryRecencyDecayEnabled: true,
    });
    expect(updatedGov).toEqual({
      memoryGovernanceEnabled: false,
      memoryRecencyDecayEnabled: true,
    });

    const initialDec = await controller.getDecisionEngine(ctx);
    expect(initialDec).toEqual({
      contrastiveDecisionEnabled: true,
      generativeDecisionEnabled: true,
    });

    const updatedDec = await controller.updateDecisionEngine(ctx, {
      contrastiveDecisionEnabled: true,
      generativeDecisionEnabled: false,
    });
    expect(updatedDec).toEqual({
      contrastiveDecisionEnabled: true,
      generativeDecisionEnabled: false,
    });
  });
});

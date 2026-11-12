import type { RequestContext } from '@ci/common/context';

import { expectFixtureShapes, readCliWireFixture } from '../../__tests__/support/cliWireFixtures';
import {
  ModelRoutingController,
  decideRequestSchema,
  rankRequestSchema,
  routingRequestSchema,
} from '../controllers/ModelRoutingController';
import { ContrastiveDecisionService } from '../services/ContrastiveDecisionService';
import { ModelTierRouter } from '../services/ModelTierRouter';

/**
 * `ci inference tiers|decide|rank` against the routes they call, through the
 * fixture both suites read (see `__tests__/support/cliWireFixtures.ts`).
 *
 * The services here are the real ones: the router is pure, and the decision
 * service with no embedding daemon falls back to its deterministic projection.
 * Only latency varies between runs, and only shapes are compared.
 */

const FIXTURE = 'model-routing.json';
const context = { userId: '00000000-0000-4000-8000-000000000001' } as RequestContext;

describe('the ci CLI against /model-routing', () => {
  const fixture = readCliWireFixture(FIXTURE);

  /**
   * All three schemas STRIP unknown keys, so a field the CLI misnames is not a
   * 400. It is silently dropped, and the flag behind it does nothing. Parsing
   * with nothing removed is the only way to tell the two apart.
   */
  it('parses every request the CLI sends with nothing stripped', () => {
    expect(routingRequestSchema.parse(fixture.plan.request)).toEqual(fixture.plan.request);

    for (const name of ['decideNoul', 'decideChoice', 'decideScore']) {
      expect(decideRequestSchema.parse(fixture[name].request)).toEqual(fixture[name].request);
    }

    expect(rankRequestSchema.parse(fixture.rank.request)).toEqual(fixture.rank.request);
  });

  it('answers in the shapes the CLI is tested against', async () => {
    const controller = new ModelRoutingController(new ModelTierRouter(), new ContrastiveDecisionService());

    const actual: Record<string, unknown> = {
      tiers: controller.getTiers(),
      plan: controller.plan(fixture.plan.request),
      decideNoul: await controller.decide(context, fixture.decideNoul.request),
      decideChoice: await controller.decide(context, fixture.decideChoice.request),
      decideScore: await controller.decide(context, fixture.decideScore.request),
      rank: await controller.rank(context, fixture.rank.request),
    };

    actual.arena = controller.getArena();

    expectFixtureShapes(FIXTURE, actual);
  });

  it('pins the plan the --sensitive flag asks for', () => {
    const controller = new ModelRoutingController(new ModelTierRouter(), new ContrastiveDecisionService());

    // The fixture request asks for a forced cloud tier AND the privacy pin. The
    // pin has to win, which it only can if `localOnly` arrives.
    expect(controller.plan(fixture.plan.request)).toMatchObject({ tier: 'on_device', downgraded: true });
  });
});

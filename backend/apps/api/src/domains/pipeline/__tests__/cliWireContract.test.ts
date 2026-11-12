import type { RequestContext } from '@ci/common/context';
import type { ApplianceAdminGuard } from '@ci/common/guards';

import {
  asQueryString,
  expectFixtureShapes,
  readCliWireFixture,
} from '../../__tests__/support/cliWireFixtures';
import { PipelineController, deadLettersQuerySchema } from '../controllers/PipelineController';
import type { PipelineDeadLetterView, PipelineRunService } from '../services/PipelineRunService';
import type { PipelineStateService } from '../services/PipelineStateService';
import type { StageCoverage } from '../types';

/**
 * `ci audit pipeline` and `ci audit dead-letters` against `GET /pipeline/state`
 * and `GET /pipeline/dead-letters`, through the fixture both suites read (see
 * `__tests__/support/cliWireFixtures.ts`).
 *
 * The controller is the real one and decides the envelope (`{ stages }`,
 * `{ deadLetters }`); the run service under it is stubbed with rows typed as it
 * returns them, so a change to `StageCoverage` or `PipelineDeadLetterView`
 * stops this compiling before it can reach the CLI unnoticed.
 */

const FIXTURE = 'pipeline.json';
const OWNER = '00000000-0000-4000-8000-000000000001';

const stages: StageCoverage[] = [
  {
    stage: 'embed',
    stageVersion: 3,
    total: 1000,
    done: 960,
    skipped: 28,
    failed: 7,
    pending: 3,
    running: 1,
    quarantined: 1,
    stale: 40,
    coverage: 0.988,
  },
];

const deadLetters: PipelineDeadLetterView[] = [
  {
    id: '0193a3c4-0000-7000-8000-0000000000d1',
    queue: 'enrichment-pipeline',
    eventName: 'pipeline.stage.summarize',
    stage: 'summarize',
    entityType: 'content',
    entityId: '0193a3c4-0000-7000-8000-0000000000e1',
    userId: OWNER,
    payload: { contentId: '0193a3c4-0000-7000-8000-0000000000e1' },
    error: 'LLM endpoint timed out after 30000ms\n    at SummaryClient.request',
    failedAt: new Date('2026-11-12T07:00:00.000Z'),
    replayedAt: null,
  },
];

describe('the ci CLI against /pipeline', () => {
  const fixture = readCliWireFixture(FIXTURE);
  const query = fixture.deadLetters.query ?? {};

  it('reads every dead-letter query parameter the CLI sends', () => {
    const parsed = deadLettersQuerySchema.parse(asQueryString(query));

    expect(Object.keys(parsed).sort()).toEqual(Object.keys(query).sort());
  });

  it('answers in the shapes the CLI is tested against', async () => {
    const listDeadLetters = jest.fn(async () => deadLetters);
    const controller = new PipelineController(
      { stageState: jest.fn(async () => stages), listDeadLetters } as unknown as PipelineRunService,
      {} as PipelineStateService,
      { admits: jest.fn(async () => false) } as unknown as ApplianceAdminGuard,
    );
    const context = { userId: OWNER } as RequestContext;

    const actual = {
      state: await controller.getState(context),
      deadLetters: await controller.listDeadLetters(
        context,
        { user: { role: 'member' } },
        deadLettersQuerySchema.parse(asQueryString(query)),
      ),
    };

    expect(listDeadLetters).toHaveBeenCalledWith(
      { userId: OWNER },
      expect.objectContaining({ queue: query.queue, stage: query.stage, limit: query.limit }),
    );
    expectFixtureShapes(FIXTURE, actual);
  });
});

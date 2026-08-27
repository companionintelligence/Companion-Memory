import type { DataSource } from 'typeorm';

import type { RequestContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import { UserContextService } from '@ci/domains/memory';
import type { CommunicationService, GraphQueryService } from '@ci/domains/memory';
import type { HbpeService, ForecastResponse } from '@ci/domains/predictions';

import type { AgentMemoryService } from '../../services/AgentMemoryService';
import { ForecastContextService } from '../../services/ForecastContextService';
import type { MemoryCompactionService } from '../../services/MemoryCompactionService';
import type { RecallService } from '../../services/RecallService';
import { MemoryController } from '../MemoryController';

/**
 * `GET /memory/context` is documented as the L0 block, "called once per session
 * (system_prompt_block), not per turn" — a contract out-of-process harnesses
 * (CI-Hermes, CI-OpenClaw) cache against. These tests pin the only property that
 * makes that possible: two builds of the block, with the wall clock advanced and
 * the graph grown in between, must be byte-identical.
 */

// The barrel does not re-export the UserContext shape; derive it from the
// service so the fixture cannot drift from what the controller actually reads.
type UserContext = NonNullable<Awaited<ReturnType<UserContextService['getUserContextForLLM']>>>;

const USER_ID = '00000000-0000-4000-8000-000000000001';
const T0 = new Date('2026-08-26T09:00:00.000Z');
const T1 = new Date('2026-08-26T14:00:00.000Z'); // five hours later, same UTC day

function loggerStub(): LoggerService {
  return { setContext: () => undefined, warn: () => undefined } as unknown as LoggerService;
}

function userContextAt(totalEntities: number): UserContext {
  return {
    currentUser: {
      entityId: 'u1',
      name: 'Alex Rivera',
      username: 'alex',
      about: 'I run a small bakery.',
    },
    familyMembers: [{ entityId: 'f1', name: 'Sam Rivera', relationship: 'SPOUSE' }],
    topPreferences: [
      {
        entityId: 'c1',
        name: 'Burgers',
        type: 'Concept',
        category: 'food',
        strength: 0.85,
        relationship: 'PREFERS',
      },
    ],
    quickStats: {
      totalEntities,
      totalPreferences: 1,
      totalDislikes: 0,
      familySize: 1,
    },
  };
}

function forecast(): ForecastResponse {
  const bucketAt = (iso: string, index: number) => ({
    bucket_index: index,
    start_time: iso,
    l0_probs: { WORK: 0.7, LEISURE: 0.3 },
    l1_probs: { focus: 0.6 },
    l2_probs: null,
    q10: 0,
    q50: 0.5,
    q90: 1,
  });

  return {
    horizon: '24h',
    // The HBPE run stamp: a wall-clock value that has no business in a cached block.
    generated_at: '2026-08-26T08:55:00.000Z',
    system_status: 'OK',
    buckets: [
      bucketAt('2026-08-26T09:00:00.000Z', 0),
      bucketAt('2026-08-26T10:00:00.000Z', 1),
      bucketAt('2026-08-26T16:00:00.000Z', 2),
      bucketAt('2026-08-26T20:00:00.000Z', 3),
    ],
  };
}

function makeHarness() {
  const userContextService = new UserContextService(
    undefined as unknown as GraphQueryService,
    undefined as unknown as DataSource,
    loggerStub(),
  );
  let totalEntities = 1200;
  jest
    .spyOn(userContextService, 'getUserContextForLLM')
    .mockImplementation(async () => userContextAt(totalEntities));

  const hbpeService = { getForecast: jest.fn(async () => forecast()) } as unknown as HbpeService;
  const featureService = { isFeatureEnabled: jest.fn(async () => true) } as unknown as FeatureService;
  const dataSource = {
    query: jest.fn(async () => [{ timezone: 'UTC' }]),
  } as unknown as DataSource;

  const forecastContextService = new ForecastContextService(
    hbpeService,
    featureService,
    dataSource,
    loggerStub(),
  );

  const controller = new MemoryController(
    userContextService,
    undefined as unknown as RecallService,
    undefined as unknown as AgentMemoryService,
    undefined as unknown as CommunicationService,
    forecastContextService,
    undefined as unknown as MemoryCompactionService,
    loggerStub(),
  );

  return {
    controller,
    forecastContextService,
    growGraph: (to: number) => {
      totalEntities = to;
    },
  };
}

describe('MemoryController L0 GET /memory/context', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders byte-identically after the clock advances and the graph grows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);

    const harness = makeHarness();
    // A fresh RequestContext per call: toServiceContext caches per object, so
    // reusing one would hide any per-request coupling.
    const first = await harness.controller.context({ userId: USER_ID } as RequestContext);

    jest.setSystemTime(T1);
    harness.growGraph(1873);

    const second = await harness.controller.context({ userId: USER_ID } as RequestContext);

    // Guard against a vacuously-equal pair of empty strings.
    expect(first.block).toContain('Alex Rivera');
    expect(first.block).toContain('## Predicted Day Ahead');
    expect(first.block.length).toBeGreaterThan(200);

    expect(second.block).toBe(first.block);
  });

  it('omits the two moving parts entirely: graph totals and the forecast run stamp', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);

    const harness = makeHarness();
    const { block } = await harness.controller.context({ userId: USER_ID } as RequestContext);

    expect(block).not.toContain('## Quick Stats');
    expect(block).not.toContain('Total entities in graph');
    expect(block).not.toContain('Generated:');
  });

  it('leaves the per-turn forecast block time-sensitive (the L0 change is opt-in)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);

    const harness = makeHarness();
    const atT0 = await harness.forecastContextService.getRestOfDayBlock({ userId: USER_ID });

    jest.setSystemTime(T1);
    const atT1 = await harness.forecastContextService.getRestOfDayBlock({ userId: USER_ID });

    expect(atT0).toContain('Generated:');
    // Proof that the fixture really does move with the clock, so the byte-equality
    // assertion above is testing the fix and not an inert fixture.
    expect(atT1).not.toBe(atT0);
  });
});

import type { RequestContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { BranchialForecastService, BranchialTree } from '@ci/domains/agent';

import { BranchialResolver } from '../BranchialResolver';

const TREE: BranchialTree = {
  question: 'What happens next',
  guessed: false,
  steps: [
    {
      id: 'morning',
      label: 'Morning',
      startTime: '2026-08-22T10:00:00Z',
      branches: [
        {
          id: 'morning:WORK',
          title: 'WORK',
          l0: 'WORK',
          mass: 0.7,
          why: 'Occupancy',
          permutations: [{ id: 'standup', title: 'standup', mass: 0.6 }],
        },
      ],
    },
  ],
};

function logger(): LoggerService {
  return { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;
}

function buildResolver(over: {
  occupancy?: jest.Mock;
  guess?: jest.Mock;
  hbpe?: boolean;
}): BranchialResolver {
  const branchial = {
    occupancy: over.occupancy ?? jest.fn().mockResolvedValue(TREE),
    guess: over.guess ?? jest.fn().mockResolvedValue({ ...TREE, guessed: true }),
  } as unknown as BranchialForecastService;
  const featureService = {
    isFeatureEnabled: jest.fn().mockResolvedValue(over.hbpe ?? true),
  } as unknown as FeatureService;

  return new BranchialResolver(branchial, featureService, logger());
}

describe('BranchialResolver', () => {
  const context = { userId: 'user-1' } as RequestContext;

  it('returns the occupancy spine', async () => {
    const occupancy = jest.fn().mockResolvedValue(TREE);
    const resolver = buildResolver({ occupancy });

    const result = await resolver.branchialForecast(context);

    expect(occupancy).toHaveBeenCalledWith(context);
    expect(result?.steps[0]?.id).toBe('morning');
    expect(result?.guessed).toBe(false);
  });

  it('guesses names from memory', async () => {
    const guess = jest.fn().mockResolvedValue({
      ...TREE,
      guessed: true,
      question: 'Where is Saturday going',
    });
    const resolver = buildResolver({ guess });

    const result = await resolver.guessBranchialForecast(context);

    expect(guess).toHaveBeenCalledWith(context);
    expect(result?.guessed).toBe(true);
    expect(result?.question).toBe('Where is Saturday going');
  });

  it('returns null when hbpe is off', async () => {
    const occupancy = jest.fn();
    const resolver = buildResolver({ occupancy, hbpe: false });

    expect(await resolver.branchialForecast(context)).toBeNull();
    expect(occupancy).not.toHaveBeenCalled();
  });
});

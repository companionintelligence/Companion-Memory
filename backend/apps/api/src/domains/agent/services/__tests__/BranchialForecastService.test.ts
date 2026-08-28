import { BranchialForecastService } from '../BranchialForecastService';

describe('BranchialForecastService.parseGuess', () => {
  it('reads a JSON object and marks the tree guessed', () => {
    const tree = BranchialForecastService.parseGuess(
      JSON.stringify({
        question: 'Where is Saturday going',
        steps: [
          {
            id: 'morning',
            branches: [
              {
                id: 'morning:beach',
                title: 'beach with Jerry',
                l0: 'LEISURE',
                mass: 0.55,
                why: 'Jerry texted about surf.',
                permutations: [{ id: 'jerry', title: 'Jerry', mass: 0.8 }],
              },
            ],
          },
        ],
      }),
    );

    expect(tree?.guessed).toBe(true);
    expect(tree?.question).toBe('Where is Saturday going');
    expect(tree?.steps[0]?.branches[0]?.title).toBe('beach with Jerry');
  });

  it('strips a markdown fence', () => {
    const tree = BranchialForecastService.parseGuess(
      '```json\n{"question":"next","steps":[{"id":"evening","branches":[{"id":"e","title":"dinner","l0":"SOCIAL","mass":0.4}]}]}\n```',
    );

    expect(tree?.steps[0]?.id).toBe('evening');
    expect(tree?.steps[0]?.branches[0]?.permutations).toEqual([]);
  });

  it('returns null on garbage', () => {
    expect(BranchialForecastService.parseGuess('not json')).toBeNull();
    expect(BranchialForecastService.parseGuess('{"steps":[]}')).not.toBeNull();
    expect(BranchialForecastService.parseGuess('{"nope":1}')).toBeNull();
  });
});

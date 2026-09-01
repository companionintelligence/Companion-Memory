import {
  branchesFromClusters,
  expandQuery,
  observationCue,
  peopleLinkedToEvents,
  slugName,
  supportingBranches,
  tokensOf,
} from '../forageCorpus';

describe('forageCorpus', () => {
  it('slugs people without colliding with solo', () => {
    const used = new Set(['solo']);
    expect(slugName('Solo', used)).toBe('solo_2');
    expect(slugName('Jerry Rivera', used)).toBe('jerry_rivera');
  });

  it('maps an event onto week-ahead branches by token overlap', () => {
    const branches = [
      {
        id: 'beach_trip',
        name: 'beach trip',
        l0: 'LEISURE',
        prior: 0.6,
        tokens: tokensOf('beach trip LEISURE'),
      },
      { id: 'office', name: 'office', l0: 'WORK', prior: 0.3, tokens: tokensOf('office WORK') },
    ];

    expect(supportingBranches('Saturday beach with Jerry', branches)).toEqual(['beach_trip']);
    expect(supportingBranches('standup at work', branches)).toEqual(['office']);
  });

  it('names the observation cue from what the fact supports', () => {
    expect(
      observationCue({ supports_branches: ['beach_trip'], supports_people: ['jerry'], source: 'event' }),
    ).toBe('beach_trip_mention');
    expect(observationCue({ supports_branches: [], supports_people: ['jerry'], source: 'person' })).toBe(
      'jerry_mention',
    );
    expect(observationCue({ supports_branches: [], supports_people: [], source: 'place' })).toBe(
      'place_mention',
    );
  });

  it('builds an index query from the current joint', () => {
    expect(
      expandQuery({ question: 'What happens next', branch: 'beach_trip', people: ['jerry', 'solo'] }),
    ).toContain('jerry');
    expect(
      expandQuery({ question: 'What happens next', branch: 'beach_trip', people: ['jerry', 'solo'] }),
    ).toContain('where they live');
  });

  it('seeds only high-confidence named clusters, not Drs / No Think', () => {
    const branches = branchesFromClusters(
      [
        { name: 'Drs', l0_class: 'UNKNOWN', p_occur: 0.9 },
        { name: 'No Think', l0_class: 'LEISURE', p_occur: 0.8 },
        { name: 'beach trip', l0_class: 'LEISURE', p_occur: 0.6 },
        { name: 'office standup', l0_class: 'WORK', p_occur: 0.05 },
      ],
      new Set(),
    );

    expect(branches.map((row) => row.name)).toEqual(['beach trip']);
  });

  it('keeps people only when they are on a passing event', () => {
    const people = peopleLinkedToEvents(
      [
        { entity_id: 'jerry', name: 'Jerry Rivera' },
        { entity_id: 'stranger', name: 'Someone Else' },
        { entity_id: 'al', name: 'Al' },
      ],
      ['jerry'],
    );

    expect(people.map((row) => row.entity_id)).toEqual(['jerry']);
  });
});

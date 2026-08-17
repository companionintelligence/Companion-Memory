import { DEFAULT_SAVED_SEARCHES, LIFESCOPE_SAVED_SEARCHES } from '../defaultSavedSearches';

describe('DEFAULT_SAVED_SEARCHES', () => {
  it('starts with the LifeScope initial_searches fixtures in fixture order', () => {
    expect(LIFESCOPE_SAVED_SEARCHES.map((seed) => seed.name)).toEqual([
      'Recent Entertainment',
      'Recent Images',
      'Everything from the past week',
      'Trophy Case',
      'Recent Social Media',
      'Recent Productivity',
      'Recent Emails',
      'One year ago today',
      'All my stuff',
    ]);
    expect(DEFAULT_SAVED_SEARCHES.slice(0, LIFESCOPE_SAVED_SEARCHES.length)).toEqual(
      LIFESCOPE_SAVED_SEARCHES,
    );
  });

  it('has unique names so a card is not seeded twice', () => {
    const names = DEFAULT_SAVED_SEARCHES.map((seed) => seed.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('maps Last 7 days fixtures onto the last-week rolling preset', () => {
    const weekSeeds = [
      'Recent Entertainment',
      'Recent Images',
      'Everything from the past week',
      'Recent Social Media',
      'Recent Productivity',
      'Recent Emails',
    ];

    for (const name of weekSeeds) {
      const seed = DEFAULT_SAVED_SEARCHES.find((row) => row.name === name);
      expect(seed?.filters?.datePreset).toBe('last-week');
    }
  });

  it('maps One year ago today onto the one-year-ago rolling preset', () => {
    const seed = DEFAULT_SAVED_SEARCHES.find((row) => row.name === 'One year ago today');
    expect(seed?.filters).toEqual({ datePreset: 'one-year-ago' });
  });

  it('keeps All my stuff unfiltered', () => {
    const seed = DEFAULT_SAVED_SEARCHES.find((row) => row.name === 'All my stuff');
    expect(seed?.query).toBeUndefined();
    expect(seed?.entityTypes).toBeUndefined();
    expect(seed?.filters).toBeUndefined();
  });
});

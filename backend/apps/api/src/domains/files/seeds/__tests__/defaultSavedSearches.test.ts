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

  it('keeps Recent Images to pictures of any source, with no search text', () => {
    const seed = DEFAULT_SAVED_SEARCHES.find((row) => row.name === 'Recent Images');

    expect(seed?.query).toBeUndefined();
    expect(seed?.entityTypes).toEqual(['file']);
    // No date window: the explorer will not apply one to files.
    expect(seed?.filters).toEqual({ fileKinds: ['image'] });
  });

  it('filters social media on every social source, and mail on the one source a message carries', () => {
    const social = DEFAULT_SAVED_SEARCHES.find((row) => row.name === 'Recent Social Media');
    expect(social?.filters?.connectors).toEqual(['instagram', 'reddit', 'twitter', 'facebook', 'linkedin']);

    // `gmail` / `google` are not sources a communication records; `email` is.
    for (const name of ['Recent Emails', 'Email from Today']) {
      const seed = DEFAULT_SAVED_SEARCHES.find((row) => row.name === name);
      expect(seed?.entityTypes).toEqual(['communication']);
      expect(seed?.filters?.connectors).toEqual(['email']);
      expect(seed?.filters?.eventTypes).toBeUndefined();
    }
  });

  it('opens every Where search on the map, and nothing else there', () => {
    for (const seed of DEFAULT_SAVED_SEARCHES) {
      const where =
        Boolean(seed.filters?.places?.length) ||
        Boolean(seed.filters?.areas?.length) ||
        seed.filters?.hasLocation === true;

      expect(seed.filters?.view === 'map').toBe(where);
    }

    // A region is a rectangle, not a name match: "Queenstown" never contained
    // the words "New Zealand", but it sits inside the box.
    expect(DEFAULT_SAVED_SEARCHES.find((row) => row.name === 'New Zealand Trip')?.filters).toEqual({
      areas: [[165.5, -47.5, 179.5, -33.5]],
      view: 'map',
    });
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

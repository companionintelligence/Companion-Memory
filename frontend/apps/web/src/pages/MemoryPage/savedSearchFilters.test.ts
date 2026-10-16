import { describe, expect, it } from 'vitest';

import { buildSavedSearchFilters } from './savedSearchFilters';

describe('buildSavedSearchFilters', () => {
  it('returns undefined when no secondary filters are active', () => {
    expect(buildSavedSearchFilters(new URLSearchParams('search=hello&view=list'))).toBeUndefined();
  });

  it('stores rolling When presets as datePreset instead of fixed dates', () => {
    const params = new URLSearchParams('when=yesterday&from=ignored&to=ignored');

    expect(buildSavedSearchFilters(params)).toEqual({
      datePreset: 'yesterday',
    });
  });

  it('captures custom ranges as startTime/endTime', () => {
    const params = new URLSearchParams(
      'eventTypes=visited,messaged&connectors=gmail&people=alice&people=bob&places=paris&when=custom&from=2024-01-01&to=2024-12-31&sortBy=time&sortOrder=desc&hasLocation=1&semantic=1',
    );

    expect(buildSavedSearchFilters(params)).toEqual({
      eventTypes: ['visited', 'messaged'],
      connectors: ['gmail'],
      people: ['alice', 'bob'],
      places: ['paris'],
      startTime: '2024-01-01',
      endTime: '2024-12-31',
      sortBy: 'time',
      sortOrder: 'desc',
      hasLocation: true,
      semantic: true,
    });
  });

  it('omits empty CSV params and treats only hasLocation=1 / semantic=1 as true', () => {
    const filters = buildSavedSearchFilters(new URLSearchParams('people=alice&connectors=&hasLocation=0'));

    expect(filters).toEqual({ people: ['alice'] });
    expect(filters?.connectors).toBeUndefined();
    expect(filters?.hasLocation).toBeUndefined();
  });
});

describe('buildSavedSearchFilters — the map area', () => {
  it('keeps every drawn rectangle so a trip saved from the map stays geographic', () => {
    const params = new URLSearchParams(
      'view=map&areas=-0.500000,51.300000,0.300000,51.700000;2.200000,48.800000,2.500000,48.900000',
    );

    expect(buildSavedSearchFilters(params)).toEqual({
      view: 'map',
      areas: [
        [-0.5, 51.3, 0.3, 51.7],
        [2.2, 48.8, 2.5, 48.9],
      ],
    });
  });

  it('reads an old single-box link as one area', () => {
    expect(buildSavedSearchFilters(new URLSearchParams('bbox=165.5,-47.5,179.5,-33.5'))).toEqual({
      areas: [[165.5, -47.5, 179.5, -33.5]],
    });
  });

  it('drops a malformed rectangle rather than saving one no search can apply', () => {
    expect(buildSavedSearchFilters(new URLSearchParams('areas=1,2,3'))).toBeUndefined();
    expect(buildSavedSearchFilters(new URLSearchParams('areas=a,b,c,d;1,2,3,4'))).toEqual({
      areas: [[1, 2, 3, 4]],
    });
  });
});

describe('buildSavedSearchFilters — the view', () => {
  it('keeps the view the search was built in, so a Where search saved from the map reopens there', () => {
    expect(buildSavedSearchFilters(new URLSearchParams('view=map&places=paris'))).toMatchObject({
      view: 'map',
      places: ['paris'],
    });
    expect(buildSavedSearchFilters(new URLSearchParams('places=paris'))?.view).toBeUndefined();
  });
});

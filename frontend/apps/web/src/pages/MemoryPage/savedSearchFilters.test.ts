import { describe, expect, it } from 'vitest';

import { buildSavedSearchFilters } from './savedSearchFilters';

describe('buildSavedSearchFilters', () => {
  it('returns undefined when no secondary filters are active', () => {
    expect(buildSavedSearchFilters(new URLSearchParams('search=hello&view=list'))).toBeUndefined();
  });

  it('captures every dimension, mapping ?from/?to to startTime/endTime', () => {
    const params = new URLSearchParams(
      'eventTypes=visited,messaged&connectors=gmail&people=alice,bob&places=paris&from=2024-01-01&to=2024-12-31&sortBy=time&sortOrder=desc&hasLocation=1&semantic=1',
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

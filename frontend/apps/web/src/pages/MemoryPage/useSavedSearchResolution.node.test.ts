import { describe, expect, it } from 'vitest';

import { applySavedSearchToParams } from './useSavedSearchResolution';

const base = {
  id: 'c2F2ZWQtc2VhcmNoOnRyaXAtMQ==',
  name: 'New Zealand Trip',
  description: null,
  query: null,
  entityTypes: [],
  tags: [],
};

describe('applySavedSearchToParams', () => {
  it('puts a saved map area back into ?areas without selecting Has a location, since the area is ORed with the names', () => {
    const next = applySavedSearchToParams(new URLSearchParams('view=list'), {
      ...base,
      filters: { areas: [[165.5, -47.5, 179.5, -33.5]], view: 'map' },
    });

    expect(next.get('areas')).toBe('165.500000,-47.500000,179.500000,-33.500000');
    expect(next.get('hasLocation')).toBeNull();
    expect(next.get('view')).toBe('map');
  });

  it('does the same for a row that still carries the single legacy bbox', () => {
    const next = applySavedSearchToParams(new URLSearchParams(), {
      ...base,
      filters: { bbox: [165.5, -47.5, 179.5, -33.5] },
    });

    expect(next.get('areas')).toBe('165.500000,-47.500000,179.500000,-33.500000');
    expect(next.get('hasLocation')).toBeNull();
  });

  it('leaves Has a location alone for a search with no area and no located-only flag', () => {
    const next = applySavedSearchToParams(new URLSearchParams('hasLocation=1'), {
      ...base,
      filters: { places: ['Paris'] },
    });

    expect(next.get('hasLocation')).toBeNull();
    expect(next.getAll('places')).toEqual(['Paris']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  applyViewFilterDefaults,
  droppedFilters,
  isDimensionActive,
  readMemoryView,
  unsupportedDimensions,
  unsupportedReason,
  MEMORY_VIEWS,
} from './viewFilterSupport';

describe('readMemoryView', () => {
  it.each(MEMORY_VIEWS)('passes %s through', (view) => {
    expect(readMemoryView(view)).toBe(view);
  });

  it('falls back to list for a missing or unknown ?view', () => {
    expect(readMemoryView(null)).toBe('list');
    expect(readMemoryView(undefined)).toBe('list');
    // `events` was a view once; it is a What-bar filter now and the pages
    // rewrite it to `list`.
    expect(readMemoryView('events')).toBe('list');
  });
});

describe('unsupportedReason', () => {
  it('reports every filter as honoured in the search-backed views', () => {
    for (const view of ['list', 'gallery', 'map'] as const) {
      expect(unsupportedDimensions(view)).toEqual([]);
    }
  });

  it('names the graph dimensions the /api/graph endpoints have no notion of', () => {
    expect(unsupportedDimensions('graph').sort()).toEqual(['areas', 'direction', 'semantic', 'sort']);
    expect(unsupportedReason('graph', 'semantic')).toMatch(/semantic/i);
    expect(unsupportedReason('graph', 'direction')).toMatch(/sent or received/i);
    expect(unsupportedReason('graph', 'areas')).toMatch(/map/i);
    expect(unsupportedReason('graph', 'sort')).toMatch(/order/i);
  });

  it('drops sort on the timeline, which always plays chronologically', () => {
    expect(unsupportedDimensions('timeline')).toEqual(['sort']);
    expect(unsupportedReason('timeline', 'sort')).toMatch(/chronological/i);
  });

  it('leaves the timeline honouring every other dimension', () => {
    for (const dimension of [
      'entityTypes',
      'eventTypes',
      'tags',
      'date',
      'connectors',
      'people',
      'places',
      'hasLocation',
      'semantic',
      'areas',
    ] as const) {
      expect(unsupportedReason('timeline', dimension)).toBeNull();
    }
  });

  it('leaves the graph honouring the dimensions it does forward', () => {
    for (const dimension of [
      'entityTypes',
      'eventTypes',
      'tags',
      'date',
      'connectors',
      'people',
      'places',
      'hasLocation',
    ] as const) {
      expect(unsupportedReason('graph', dimension)).toBeNull();
    }
  });
});

describe('isDimensionActive', () => {
  it('reads a dimension through any of the params that set it', () => {
    expect(isDimensionActive(new URLSearchParams('?when=yesterday'), 'date')).toBe(true);
    expect(isDimensionActive(new URLSearchParams('?from=2026-01-01'), 'date')).toBe(true);
    expect(isDimensionActive(new URLSearchParams('?sortOrder=asc'), 'sort')).toBe(true);
    expect(isDimensionActive(new URLSearchParams('?excludedEntityTypes=File'), 'entityTypes')).toBe(true);
  });

  it('is false for a param that is absent or empty', () => {
    expect(isDimensionActive(new URLSearchParams('?semantic='), 'semantic')).toBe(false);
    expect(isDimensionActive(new URLSearchParams(''), 'areas')).toBe(false);
  });
});

describe('droppedFilters', () => {
  const params = new URLSearchParams('?semantic=1&areas=1,2,3,4&tags=space&sortBy=name');

  it('lists only the set filters the view cannot apply', () => {
    expect(droppedFilters('graph', params).sort()).toEqual(['areas', 'semantic', 'sort']);
  });

  it('is empty for the views that honour everything', () => {
    expect(droppedFilters('list', params)).toEqual([]);
    expect(droppedFilters('gallery', params)).toEqual([]);
    expect(droppedFilters('map', params)).toEqual([]);
  });

  it('drops the sort the user set when the timeline is active', () => {
    expect(droppedFilters('timeline', params)).toEqual(['sort']);
  });

  it('ignores unsupported dimensions the user has not set', () => {
    expect(droppedFilters('graph', new URLSearchParams('?tags=space'))).toEqual([]);
  });
});

describe('applyViewFilterDefaults', () => {
  it('turns "Has a location" on when switching to the map', () => {
    const params = applyViewFilterDefaults(new URLSearchParams('?search=trip'), 'map');

    expect(params.get('hasLocation')).toBe('1');
    // ...as a real URL filter, so it chips in the toolbar and means the same
    // thing in the other views.
    expect(params.get('search')).toBe('trip');
  });

  it('leaves an explicit choice alone', () => {
    expect(applyViewFilterDefaults(new URLSearchParams('?hasLocation=0'), 'map').get('hasLocation')).toBe(
      '0',
    );
  });

  it('adds nothing for the other views', () => {
    for (const view of ['list', 'gallery', 'graph', 'timeline'] as const) {
      expect(applyViewFilterDefaults(new URLSearchParams(''), view).toString()).toBe('');
    }
  });
});

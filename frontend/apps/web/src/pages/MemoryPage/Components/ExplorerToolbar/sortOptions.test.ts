import { describe, expect, it } from 'vitest';

import { SORT_OPTIONS, currentSortValue, explorerSortOptions } from './sortOptions';

const WHEN = new URLSearchParams('when=last-week&from=2026-01-01T00:00:00.000Z&to=2026-01-07T23:59:59.999Z');

describe('explorerSortOptions', () => {
  it('offers the full preset list on the events browse and everywhere else', () => {
    expect(explorerSortOptions('/memory/events', new URLSearchParams())).toBe(SORT_OPTIONS);
    expect(explorerSortOptions('/', new URLSearchParams())).toBe(SORT_OPTIONS);
  });

  it('offers relevance and name sorts only on /memory without a When filter', () => {
    expect(
      explorerSortOptions('/memory', new URLSearchParams('view=list')).map((option) => option.value),
    ).toEqual(['relevance', 'name-asc', 'name-desc']);
  });

  it('adds Newest / Oldest on /memory once a When filter is active', () => {
    expect(explorerSortOptions('/memory', WHEN).map((option) => option.value)).toEqual([
      'relevance',
      'newest',
      'oldest',
      'name-asc',
      'name-desc',
    ]);
  });

  it('writes no sort params for Relevance on /memory — the server default is the ranking', () => {
    const relevance = explorerSortOptions('/memory', WHEN).find((option) => option.value === 'relevance');

    expect(relevance).toEqual({ value: 'relevance', label: 'Relevance', sortBy: '', sortOrder: '' });
  });

  it('treats a trailing slash as the same page', () => {
    expect(explorerSortOptions('/memory/', new URLSearchParams()).map((option) => option.value)).toEqual([
      'relevance',
      'name-asc',
      'name-desc',
    ]);
  });
});

describe('currentSortValue', () => {
  it('maps a sortBy/sortOrder pair to its preset', () => {
    expect(currentSortValue(SORT_OPTIONS, 'time', 'asc')).toBe('oldest');
    expect(currentSortValue(SORT_OPTIONS, '', '')).toBe('default');
  });

  it('reads an absent or unlisted sort as the list default', () => {
    const everything = explorerSortOptions('/memory', new URLSearchParams());

    expect(currentSortValue(everything, '', '')).toBe('relevance');
    // A legacy `sortBy=relevance` deep link, and a time sort the reset has not yet cleared.
    expect(currentSortValue(everything, 'relevance', 'desc')).toBe('relevance');
    expect(currentSortValue(everything, 'time', 'desc')).toBe('relevance');
    expect(currentSortValue(SORT_OPTIONS, 'bogus', '')).toBe('default');
  });
});

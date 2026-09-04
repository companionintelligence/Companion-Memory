import { isEverythingExplorer } from '@/pages/MemoryPage/explorerRoute';

import { hasWhenFilter } from './filterParams';

export interface SortOption {
  value: string;
  label: string;
  /** Written to `?sortBy=`; empty means "leave it to the server". */
  sortBy: string;
  /** Written to `?sortOrder=`; empty means "leave it to the server". */
  sortOrder: string;
}

// Single-select sort presets that map to the backend's sortBy + sortOrder pair.
// "Default" leaves both params unset: the server then ranks a text search by
// relevance and orders a plain browse by time.
export const SORT_OPTIONS: readonly SortOption[] = [
  { value: 'default', label: 'Default', sortBy: '', sortOrder: '' },
  { value: 'relevance', label: 'Relevance', sortBy: 'relevance', sortOrder: 'desc' },
  { value: 'newest', label: 'Newest first', sortBy: 'time', sortOrder: 'desc' },
  { value: 'oldest', label: 'Oldest first', sortBy: 'time', sortOrder: 'asc' },
  { value: 'name-asc', label: 'Name (A–Z)', sortBy: 'name', sortOrder: 'asc' },
  { value: 'name-desc', label: 'Name (Z–A)', sortBy: 'name', sortOrder: 'desc' },
];

/**
 * The presets the everything browse (`/memory`) offers.
 *
 * Relevance is the default there and writes no sort params: with a search
 * query the server already ranks by relevance, and without one the server's
 * own order is the only ranking there is — an explicit `sortBy=relevance`
 * would change nothing except break cursor paging on the timed browse, whose
 * cursors are minted from the time order. So "Relevance" IS the server
 * default, and "Default" would be a second name for the same thing.
 *
 * Newest / Oldest only appear while a When filter is active: they group the
 * list under date headings, and outside a date range the everything browse
 * is a mix of kinds that mostly have no date to sort on. When the When
 * filter goes, useExplorerWhenReset drops a time sort back to relevance.
 */
const EVERYTHING_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'relevance', label: 'Relevance', sortBy: '', sortOrder: '' },
  ...SORT_OPTIONS.filter((option) => option.sortBy === 'time' || option.sortBy === 'name'),
];

/** The sort presets the Sort control offers at `pathname` with `params` applied. */
export function explorerSortOptions(pathname: string, params: URLSearchParams): readonly SortOption[] {
  if (!isEverythingExplorer(pathname)) {
    return SORT_OPTIONS;
  }

  if (hasWhenFilter(params)) {
    return EVERYTHING_SORT_OPTIONS;
  }

  return EVERYTHING_SORT_OPTIONS.filter((option) => option.sortBy !== 'time');
}

/**
 * Which of `options` the URL's `sortBy`/`sortOrder` pair selects. A pair no
 * option writes (a legacy `sortBy=relevance` link on `/memory`, or a time
 * sort the reset has not yet cleared) reads as the list's default entry.
 */
export function currentSortValue(options: readonly SortOption[], sortBy: string, sortOrder: string): string {
  const match = options.find((option) => option.sortBy === sortBy && option.sortOrder === sortOrder);

  if (match) {
    return match.value;
  }

  return options.some((option) => option.value === 'default') ? 'default' : 'relevance';
}

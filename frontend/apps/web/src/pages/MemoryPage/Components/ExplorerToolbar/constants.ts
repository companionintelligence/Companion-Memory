// Shared vocabulary for the explorer toolbar and its active-filter summary so
// both render the same sort labels, date labels, and param set.

// Single-select sort presets that map to the backend's sortBy + sortOrder pair.
export const SORT_OPTIONS = [
  { value: 'default', label: 'Default', sortBy: '', sortOrder: '' },
  { value: 'relevance', label: 'Relevance', sortBy: 'relevance', sortOrder: 'desc' },
  { value: 'newest', label: 'Newest first', sortBy: 'time', sortOrder: 'desc' },
  { value: 'oldest', label: 'Oldest first', sortBy: 'time', sortOrder: 'asc' },
  { value: 'name-asc', label: 'Name (A–Z)', sortBy: 'name', sortOrder: 'asc' },
  { value: 'name-desc', label: 'Name (Z–A)', sortBy: 'name', sortOrder: 'desc' },
] as const;

/** Human label for a sortBy/sortOrder pair, falling back to "Custom". */
export function sortLabel(sortBy: string, sortOrder: string): string {
  return (
    SORT_OPTIONS.find((option) => option.sortBy === sortBy && option.sortOrder === sortOrder)?.label ??
    'Custom'
  );
}

export function formatDateLabel(dateFrom: string, dateTo: string): string {
  const fmt = (value: string) => new Date(value).toLocaleDateString();

  if (dateFrom && dateTo) {
    return `${fmt(dateFrom)} – ${fmt(dateTo)}`;
  }

  if (dateFrom) {
    return `After ${fmt(dateFrom)}`;
  }

  if (dateTo) {
    return `Before ${fmt(dateTo)}`;
  }

  return 'Any time';
}

/**
 * Every URL search param the explorer toolbar owns. "Clear all" deletes exactly
 * these, leaving unrelated params (view state, saved_search) untouched.
 */
export const EXPLORER_PARAM_KEYS = [
  'search',
  'includedEntityTypes',
  'excludedEntityTypes',
  'eventTypes',
  'tags',
  'from',
  'to',
  'sortBy',
  'sortOrder',
  'connectors',
  'people',
  'places',
  'hasLocation',
  'semantic',
] as const;

/**
 * Pure value-transforms for the saved-search filter editor (SavedSearchFiltersEditor).
 * Kept React-free so they can be unit-tested in the node vitest env. The value
 * shape is tolerant of the nullable fields the GraphQL fragment returns; the
 * editor edits it and {@link toFiltersInput} turns it back into the mutation input.
 */
export interface EditableFilters {
  eventTypes?: string[] | null;
  startTime?: string | null;
  endTime?: string | null;
  sortBy?: string | null;
  sortOrder?: string | null;
  connectors?: string[] | null;
  people?: string[] | null;
  places?: string[] | null;
  hasLocation?: boolean | null;
  semantic?: boolean | null;
}

/** The list-valued dimensions, edited as removable chips with a free-text add. */
export type ListField = 'eventTypes' | 'connectors' | 'people' | 'places';

/** Sort presets mapping a single label to the backend sortBy + sortOrder pair. */
export const SAVED_SEARCH_SORT_PRESETS = [
  { value: 'default', label: 'Default', sortBy: undefined, sortOrder: undefined },
  { value: 'relevance', label: 'Relevance', sortBy: 'relevance', sortOrder: 'desc' },
  { value: 'newest', label: 'Newest first', sortBy: 'time', sortOrder: 'desc' },
  { value: 'oldest', label: 'Oldest first', sortBy: 'time', sortOrder: 'asc' },
  { value: 'name-asc', label: 'Name (A–Z)', sortBy: 'name', sortOrder: 'asc' },
  { value: 'name-desc', label: 'Name (Z–A)', sortBy: 'name', sortOrder: 'desc' },
] as const;

export type SortPreset = (typeof SAVED_SEARCH_SORT_PRESETS)[number]['value'];

/** Which sort preset the current (sortBy, sortOrder) corresponds to. */
export function sortPresetOf(filters: EditableFilters): SortPreset {
  const match = SAVED_SEARCH_SORT_PRESETS.find(
    (preset) =>
      preset.sortBy === (filters.sortBy ?? undefined) &&
      preset.sortOrder === (filters.sortOrder ?? undefined),
  );

  return match?.value ?? 'default';
}

/** Apply a sort preset, clearing both fields for 'default'. */
export function applySortPreset(filters: EditableFilters, value: SortPreset): EditableFilters {
  const preset = SAVED_SEARCH_SORT_PRESETS.find((option) => option.value === value);

  return { ...filters, sortBy: preset?.sortBy, sortOrder: preset?.sortOrder };
}

/** Append a trimmed, de-duplicated value to a list field. No-op for blanks/dupes. */
export function addListValue(filters: EditableFilters, field: ListField, raw: string): EditableFilters {
  const item = raw.trim();

  if (!item) {
    return filters;
  }

  const current = filters[field] ?? [];

  if (current.includes(item)) {
    return filters;
  }

  return { ...filters, [field]: [...current, item] };
}

/** Remove a value from a list field. */
export function removeListValue(filters: EditableFilters, field: ListField, item: string): EditableFilters {
  return { ...filters, [field]: (filters[field] ?? []).filter((value) => value !== item) };
}

/**
 * Convert the editor value into a SavedSearchFiltersInput for the mutation,
 * dropping empty/false dimensions. Returns null when nothing is active so the
 * saved search stores `filters: null` rather than an empty object.
 */
export function toFiltersInput(filters: EditableFilters): EditableFilters | null {
  const result: EditableFilters = {};

  const setIf = <K extends keyof EditableFilters>(key: K, value: EditableFilters[K] | undefined) => {
    if (value !== undefined) {
      result[key] = value;
    }
  };

  const list = (value?: string[] | null) => (value && value.length > 0 ? value : undefined);

  setIf('eventTypes', list(filters.eventTypes));
  setIf('connectors', list(filters.connectors));
  setIf('people', list(filters.people));
  setIf('places', list(filters.places));
  setIf('startTime', filters.startTime || undefined);
  setIf('endTime', filters.endTime || undefined);
  setIf('sortBy', filters.sortBy || undefined);
  setIf('sortOrder', filters.sortOrder || undefined);
  setIf('hasLocation', filters.hasLocation ? true : undefined);
  setIf('semantic', filters.semantic ? true : undefined);

  return Object.keys(result).length > 0 ? result : null;
}

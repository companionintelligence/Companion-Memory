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
  datePreset?: string | null;
  sortBy?: string | null;
  sortOrder?: string | null;
  connectors?: string[] | null;
  people?: string[] | null;
  places?: string[] | null;
  hasLocation?: boolean | null;
  semantic?: boolean | null;
  /** Sent / received (`inbound` / `outbound`) — the Who field's toggle. */
  direction?: string | null;
  /** File kinds the explorer narrowed to; carried through, not edited here. */
  fileKinds?: string[] | null;
  /** The explorer view the search opens in; carried through, not edited here. */
  view?: string | null;
  /** The map areas, each `[minLon, minLat, maxLon, maxLat]`; drawn on the map, removable here. */
  areas?: (number | null)[][] | null;
  /** The single-area predecessor of `areas`, read as one entry and never written. */
  bbox?: (number | null)[] | null;
}

/** Whether `bbox` is a usable map area: exactly four finite numbers. */
export function isValidBbox(bbox: unknown): bbox is [number, number, number, number] {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every((value) => Number.isFinite(value));
}

/**
 * The map areas an editor value carries: `areas` with any malformed entry
 * dropped, else the legacy single `bbox` as one entry, else an empty list.
 */
export function editableAreas(
  filters: Pick<EditableFilters, 'areas' | 'bbox'>,
): [number, number, number, number][] {
  const areas = (filters.areas ?? []).filter(isValidBbox);

  if (areas.length > 0) {
    return areas;
  }

  return isValidBbox(filters.bbox) ? [filters.bbox] : [];
}

/** Drop one area by position; the legacy `bbox` is folded into `areas` on the way. */
export function removeArea(filters: EditableFilters, index: number): EditableFilters {
  const areas = editableAreas(filters).filter((_, position) => position !== index);

  return { ...filters, areas, bbox: undefined };
}

/** Drop every area; the Where field's Clear takes the names and the rectangles together. */
export function clearWhere(filters: EditableFilters): EditableFilters {
  return { ...filters, places: [], areas: [], bbox: undefined };
}

export { describeBbox } from '@/pages/MemoryPage/bbox';

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
/** What `toFiltersInput` writes: the editor value with the map areas narrowed to real rectangles, and no legacy `bbox`. */
export type SavedSearchFiltersInput = Omit<EditableFilters, 'areas' | 'bbox'> & {
  areas?: [number, number, number, number][];
};

export function toFiltersInput(filters: EditableFilters): SavedSearchFiltersInput | null {
  const result: SavedSearchFiltersInput = {};

  const setIf = <K extends keyof SavedSearchFiltersInput>(
    key: K,
    value: SavedSearchFiltersInput[K] | undefined,
  ) => {
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
  setIf('datePreset', filters.datePreset || undefined);
  setIf('sortBy', filters.sortBy || undefined);
  setIf('sortOrder', filters.sortOrder || undefined);
  // Not implied by a map area: Where is "at a named place OR inside a
  // rectangle", and forcing located-only here would drop the named-place
  // matches that have no coordinates. The switch is the person's own.
  setIf('hasLocation', filters.hasLocation ? true : undefined);
  setIf('semantic', filters.semantic ? true : undefined);
  setIf('direction', filters.direction || undefined);
  // Dimensions the editor shows but does not build: an edit must not strip
  // the view a search opens in, its file kinds, or the map area it was drawn with.
  setIf('fileKinds', list(filters.fileKinds));
  setIf('view', filters.view || undefined);
  // Written as `areas` only: a legacy `bbox` is read into the list above and
  // not carried forward, so the row converges on the one shape.
  const areas = editableAreas(filters);
  setIf('areas', areas.length > 0 ? areas : undefined);

  return Object.keys(result).length > 0 ? result : null;
}

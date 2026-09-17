/**
 * Which explorer filters each Memory view can actually honour.
 *
 * The explorer's contract is that the URL *is* the query: List, Gallery, Map,
 * Timeline and Graph all run the same filter set, so one link means the same
 * thing wherever it opens. Two exceptions used to break that silently — the gallery
 * forced `includeFiles` on and the map forced `hasLocation` on, both derived
 * from `?view` rather than from anything the user set. Both are gone; the
 * remaining divergence is real and lives here.
 *
 * The graph is not served by the GraphQL `search` resolver at all — it reads
 * `/api/graph/{data,dots,search}`, which take the type / tag / who / where /
 * when / how dimensions but have no notion of semantic ranking, a map viewport,
 * or result ordering. Rather than drop those filters without a word, the
 * toolbar renders them as "not applied here" with the reason below.
 */

/** The Memory explorer views, as written to `?view=`. */
export const MEMORY_VIEWS = ['list', 'gallery', 'map', 'graph', 'timeline'] as const;

export type MemoryView = (typeof MEMORY_VIEWS)[number];

/** `?view=` values that aren't one of these fall back to the list default. */
export function readMemoryView(value: string | null | undefined): MemoryView {
  return MEMORY_VIEWS.includes(value as MemoryView) ? (value as MemoryView) : 'list';
}

/**
 * Filter dimensions the toolbar can report on. `sort` covers the
 * `sortBy`/`sortOrder` pair, which the Sort control writes together.
 */
export type FilterDimension =
  | 'entityTypes'
  | 'eventTypes'
  | 'tags'
  | 'date'
  | 'connectors'
  | 'people'
  | 'places'
  | 'hasLocation'
  | 'semantic'
  | 'bbox'
  | 'direction'
  | 'sort';

/**
 * Per-view exceptions: dimension -> why this view can't apply it. A dimension
 * absent from a view's record is honoured there. Keep the reasons short — they
 * render inside a chip tooltip.
 */
const UNSUPPORTED: Record<MemoryView, Partial<Record<FilterDimension, string>>> = {
  list: {},
  gallery: {},
  map: {},
  timeline: {
    sort: 'Timeline always plays chronologically, so sort has no effect here.',
  },
  graph: {
    semantic: 'The graph ranks by connection, not by meaning, so semantic search has no effect here.',
    bbox: 'The graph has no map viewport, so a map area cannot narrow it.',
    direction: 'The graph has no notion of sent or received, so a message direction cannot narrow it.',
    sort: 'The graph has no result order to sort — nodes are laid out by their connections.',
  },
};

/** Why `view` cannot apply `dimension`, or null when it can. */
export function unsupportedReason(view: MemoryView, dimension: FilterDimension): string | null {
  return UNSUPPORTED[view][dimension] ?? null;
}

/** Every dimension `view` drops, whether or not the user has set it. */
export function unsupportedDimensions(view: MemoryView): FilterDimension[] {
  return Object.keys(UNSUPPORTED[view]) as FilterDimension[];
}

/** The URL params each dimension is set through (used to spot active ones). */
const DIMENSION_PARAMS: Record<FilterDimension, string[]> = {
  entityTypes: ['includedEntityTypes', 'excludedEntityTypes'],
  eventTypes: ['eventTypes'],
  tags: ['tags'],
  date: ['from', 'to', 'when'],
  connectors: ['connectors'],
  people: ['people'],
  places: ['places'],
  hasLocation: ['hasLocation'],
  semantic: ['semantic'],
  bbox: ['bbox'],
  direction: ['direction'],
  sort: ['sortBy', 'sortOrder'],
};

/** Whether the user has actually set `dimension` in the URL. */
export function isDimensionActive(params: URLSearchParams, dimension: FilterDimension): boolean {
  return DIMENSION_PARAMS[dimension].some((param) => Boolean(params.get(param)));
}

/**
 * The dimensions the user has set that `view` will not apply — what the
 * toolbar marks as dropped, and what the filter count reports as
 * "N not applied here".
 */
export function droppedFilters(view: MemoryView, params: URLSearchParams): FilterDimension[] {
  return unsupportedDimensions(view).filter((dimension) => isDimensionActive(params, dimension));
}

/**
 * Filters a *view switch* turns on. The map is a pins surface: with no "Has a
 * location" filter the shared result set is dominated by rows that carry no
 * coordinates, and the map reads as empty. So clicking the Map tab applies it —
 * but as a real URL filter with its own removable chip, which then means the
 * same thing in List, Gallery and Graph too.
 *
 * This is the honest version of what MemoryPage used to do: it forced
 * `hasLocation` on whenever `?view=map`, invisibly, which also flipped the
 * whole browse to events-only (the server routes `hasLocation` through its
 * event filter). Deep links are left exactly as written — only a tab click
 * applies this, and only when the user has expressed no preference.
 */
export function applyViewFilterDefaults(params: URLSearchParams, view: MemoryView): URLSearchParams {
  if (view === 'map' && params.get('hasLocation') == null) {
    params.set('hasLocation', '1');
  }

  return params;
}

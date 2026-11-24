import type { FilterDragKind } from '@/components/SearchBox/filterDrag';
import { AVAILABLE_ENTITY_TYPES, HIDDEN_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';
import { EVENTS_EXPLORER_TYPES, isEventsExplorer } from '@/pages/MemoryPage/explorerRoute';

import { isRollingDatePreset } from './datePresets';

/**
 * The saved search the explorer's filters were loaded from (its raw id), set by
 * `applySavedSearchToParams` and read by the Save dialog so it can offer
 * "Update <name>" instead of only "save another one". Not a filter: it says
 * where the filters came from. It is swept with them, because clearing every
 * filter is starting over, and it rides along with them when the header
 * search box carries the filter set into a new query.
 */
export const LOADED_SEARCH_PARAM = 'loaded_search';

// Every URL param the explorer toolbar can set. The full-reset affordances —
// the header search box's X and the drop area's `Clear all` — remove all of
// them; `countActiveFilters` powers the "N filters" indicators. `search` is
// excluded — it lives in the always-visible search box and reads as its own
// affordance.
export const FILTER_PARAMS = [
  'includedEntityTypes',
  'excludedEntityTypes',
  'eventTypes',
  'tags',
  'from',
  'to',
  'when',
  'sortBy',
  'sortOrder',
  'connectors',
  'people',
  'places',
  'hasLocation',
  'semantic',
  'areas',
  // The single-rectangle predecessor of `areas`; old links still carry it.
  'bbox',
  'direction',
  LOADED_SEARCH_PARAM,
] as const;

/**
 * Entity types are filtered either by an exclude-list (the toolbar's own type
 * picker) or by an externally-applied include-list (e.g. a graph-explorer deep
 * link). The include-list takes precedence, mirroring the search dropdown's URL
 * sync. Returns the types still selected when a type filter narrows the set,
 * or null when no type filter is active.
 */
export function narrowedEntityTypes(params: URLSearchParams): string[] | null {
  const total = AVAILABLE_ENTITY_TYPES.length;
  const included = params.get('includedEntityTypes')?.split(',').filter(Boolean) ?? [];

  if (included.length) {
    const selected = AVAILABLE_ENTITY_TYPES.filter((type) => included.includes(type));

    return selected.length < total ? selected : null;
  }

  const excluded = params.get('excludedEntityTypes')?.split(',').filter(Boolean) ?? [];
  const selected = AVAILABLE_ENTITY_TYPES.filter((type) => !excluded.includes(type));

  return selected.length < total ? selected : null;
}

/**
 * Whether a When filter is in force: an explicit `from`/`to` range, or a
 * rolling preset (`?when=last-week`) that resolves to one. Mirrors the rule
 * the toolbar's date chip renders on, so "the chip is showing" and "the When
 * override is applied" can never disagree.
 */
export function hasWhenFilter(params: URLSearchParams): boolean {
  return Boolean(params.get('from') || params.get('to') || isRollingDatePreset(params.get('when')));
}

/** Whether an Activity filter (`?eventTypes=`) names at least one kind of event. */
export function hasActivityFilter(params: URLSearchParams): boolean {
  return (params.get('eventTypes')?.split(',') ?? []).some(Boolean);
}

/**
 * The What-picker types whose rows carry a real moment in time, so a When
 * filter can mean something for them:
 *
 * - Event (`startTime`), Communication and Browser (`time`) are things that
 *   happened.
 * - Receipt has `purchasedAt` — nullable, but the domain time when it is set.
 *
 * Everything else in the picker has no time of its own. Content, File, Note,
 * Thing and Product only carry a row-write time — when they were imported, not
 * when anything happened. Person and Place are the same: the server can stamp
 * them with `appearedAt` (first activity inside a date window) on the timed
 * browse, but that is a derived moment, not part of the record, and the text
 * search path never stamps it. A When filter therefore sets all of those
 * types aside rather than showing them under "No date".
 */
export const DATED_ENTITY_TYPES: readonly string[] = ['Browser', 'Communication', 'Event', 'Receipt'];

/** The picker types a When filter sets aside, in picker order. */
export const UNDATED_ENTITY_TYPES: readonly string[] = AVAILABLE_ENTITY_TYPES.filter(
  (type) => !DATED_ENTITY_TYPES.includes(type),
);

/**
 * Kinds the search returns that no What picker offers and that carry only a
 * row-write time: a chat thread is dated by its last write, a document excerpt
 * by its file's, a planner task and a feed action by their own row. The timed
 * browse never lists them under a date range, but the text and tag searches'
 * date check falls back to that write time, so a When filter plus search text
 * brought a chat started today back into "Last week". The device list dates
 * its task, thread and excerpt records the same way, browse or not. A When
 * filter sets them aside with {@link UNDATED_ENTITY_TYPES}.
 */
export const UNDATED_UNLISTED_TYPES: readonly string[] = ['Thread', 'FileChunk', 'Task', 'Action'];

/**
 * Kinds the server's text search leaves out on its own, but only while the
 * request names no types: raw chat messages (the recall channel) and GPS
 * fixes. Neither resolves to a result row, so any exclude list has to name
 * them itself, or they take places in the candidate pool that real matches
 * should have had.
 */
export const SERVER_DEFAULT_EXCLUDED_TYPES: readonly string[] = ['Message', 'Position'];

export interface ExplorerTypeResolution {
  includeTypes?: string[];
  excludeTypes?: string[];
  /**
   * The types the user selected in the What picker that the When filter set
   * aside (display names, picker order). Empty when no When filter is active
   * or nothing the user picked was undated. The empty state reads this to
   * explain why a Content-only browse with a date range shows nothing.
   */
  droppedByWhen: string[];
  /**
   * True when the When filter left no type to ask for — every selected type
   * was undated. The page must then render the explanation instead of
   * querying, because an empty include list means "everything" to the server.
   */
  nothingLeft: boolean;
}

/**
 * Type filters for the explorer `search` query, with the When override applied.
 *
 * The What picker writes an *exclude* list (`?excludedEntityTypes=`). The timed
 * browse only fetches opt-in types (Person, Place, Thing, Product, Receipt)
 * when they appear in `includeTypes`, so forwarding that exclude list made a
 * People-only (or Places-only, …) browse return an empty page — the heatmap
 * already converted the same URL to includes via {@link narrowedEntityTypes}.
 * When the picker has narrowed the set, send the remaining types as includes
 * and drop the exclude list so both sides of the page agree.
 *
 * A When filter then narrows further, to {@link DATED_ENTITY_TYPES}: a date
 * range can only ever match things that have a date, and the alternative —
 * letting Content/Files/Notes through on their import time — put them under
 * a "No date" heading at the foot of a dated list, where the next page's rows
 * inserted themselves above the reader. With no picker selection the override
 * is an exclude list, so the server's default browse set is otherwise
 * untouched (opt-in types stay opt-in). With a selection it intersects, and
 * reports what it set aside in `droppedByWhen`.
 *
 * On `/memory/events` (pass the `pathname`) the universe is smaller still:
 * only the kinds with a moment of their own (EVENTS_EXPLORER_TYPES). The What
 * bar there offers only those, and a deep link naming anything else is
 * clipped to them — never widened back to everything, and never emptied. That
 * clipping happens before the When override, and every one of those kinds
 * is dated, so the two never fight.
 *
 * An Activity filter (`?eventTypes=`) then pins the browse to events. The
 * server applies that filter to event rows only and lets every other kind
 * through untouched (SearchResolver's eventTypes post-filter, and the timed
 * browse's per-type queries), so asking for the events-browse kinds alongside
 * "sale" returned no sales and every browser visit and message there is.
 * Nobody means that by picking an activity; the graph endpoint already reads
 * it as events-only and the heatmap counts only events under it. The pin
 * applies only while events were in play: a What bar that has left events
 * out keeps its selection, and the toolbar marks the Activity chip as one
 * that can never match (see {@link eventsInPlay}). It also applies only to
 * a browse whose kinds were not really chosen — an un-narrowed What bar, or
 * one narrowed to the events-browse kinds. A selection that names another
 * kind alongside events is kept whole: those rows were asked for, not let
 * through, and the server already narrows the events among them by
 * activity. The seeded "Trophy Case" search is exactly that (Event + Content
 * + an activity + a query), and it is what a shared link of the same saved
 * search returns. The pin comes before the When override, and events are
 * dated, so the two never fight either.
 */
export function resolveExplorerTypes(params: URLSearchParams, pathname?: string): ExplorerTypeResolution {
  let narrowed = narrowedEntityTypes(params);

  if (pathname != null && isEventsExplorer(pathname)) {
    const kept = (narrowed ?? EVENTS_EXPLORER_TYPES).filter((type) => EVENTS_EXPLORER_TYPES.includes(type));

    narrowed = kept.length > 0 ? kept : [...EVENTS_EXPLORER_TYPES];
  }

  if (
    hasActivityFilter(params) &&
    (narrowed == null ||
      (narrowed.includes('Event') && narrowed.every((type) => EVENTS_EXPLORER_TYPES.includes(type))))
  ) {
    narrowed = ['Event'];
  }

  if (!hasWhenFilter(params)) {
    return narrowed
      ? { includeTypes: narrowed, droppedByWhen: [], nothingLeft: false }
      : { droppedByWhen: [], nothingLeft: false };
  }

  if (!narrowed) {
    return {
      excludeTypes: [
        ...UNDATED_ENTITY_TYPES,
        ...HIDDEN_ENTITY_TYPES,
        ...UNDATED_UNLISTED_TYPES,
        ...SERVER_DEFAULT_EXCLUDED_TYPES,
      ],
      droppedByWhen: [],
      nothingLeft: false,
    };
  }

  const kept = narrowed.filter((type) => DATED_ENTITY_TYPES.includes(type));
  const droppedByWhen = narrowed.filter((type) => !DATED_ENTITY_TYPES.includes(type));

  if (kept.length === 0) {
    return { droppedByWhen, nothingLeft: true };
  }

  return { includeTypes: kept, droppedByWhen, nothingLeft: false };
}

/** Just the include/exclude pair of {@link resolveExplorerTypes}. */
export function explorerSearchTypeFilters(
  params: URLSearchParams,
  pathname?: string,
): {
  includeTypes?: string[];
  excludeTypes?: string[];
} {
  const { includeTypes, excludeTypes } = resolveExplorerTypes(params, pathname);

  return {
    ...(includeTypes ? { includeTypes } : {}),
    ...(excludeTypes ? { excludeTypes } : {}),
  };
}

/**
 * Whether events are among the kinds the explorer will search, and so whether
 * an event-scoped control has anything to act on. The Activity picker
 * (`?eventTypes=`) only narrows rows of kind `event` — SearchInput.eventTypes
 * is documented as event-only — so offering it while the What bar has left
 * events out (say `/memory` narrowed to Content) would be a filter that can
 * never match. Follows the same resolution the search sends, including the
 * events-browse clip and the When override.
 */
export function eventsInPlay(params: URLSearchParams, pathname?: string): boolean {
  return kindsInPlay(params, pathname, ['Event']);
}

/**
 * Whether any kind that links to people is among the kinds the explorer will
 * search — the Who picker's (`?people=`) precondition. The backend narrows
 * events (participants / organizer) and communications (sender / recipients)
 * by Who and sets every other kind aside, so the picker is offered while
 * either of those two is in play.
 */
export function peopleInPlay(params: URLSearchParams, pathname?: string): boolean {
  return kindsInPlay(params, pathname, ['Event', 'Communication']);
}

/** Whether at least one of `kinds` (display names) survives the current type resolution. */
function kindsInPlay(params: URLSearchParams, pathname: string | undefined, kinds: string[]): boolean {
  const { includeTypes, excludeTypes, nothingLeft } = resolveExplorerTypes(params, pathname);

  if (nothingLeft) {
    return false;
  }

  if (includeTypes) {
    return kinds.some((kind) => includeTypes.includes(kind));
  }

  return kinds.some((kind) => !(excludeTypes ?? []).includes(kind));
}

export function normalizeFilterValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Case-insensitive identity for dedupe/removal of filter values. */
export function filterValueKey(value: string): string {
  return normalizeFilterValue(value).toLocaleLowerCase();
}

export function readCsvParam(params: URLSearchParams, key: string): string[] {
  return params.get(key)?.split(',').map(normalizeFilterValue).filter(Boolean) ?? [];
}

export function writeCsvFilterParam(params: URLSearchParams, key: string, next: string[]) {
  const normalized = next.map(normalizeFilterValue).filter(Boolean);

  if (normalized.length === 0) {
    params.delete(key);
  } else {
    params.set(key, normalized.join(','));
  }
}

/**
 * The free-text list dimensions — Who (`people`), Where (`places`) and `tags`
 * — carry one value per occurrence of their param: `?places=a&places=b`.
 * A value is a name the person typed or picked, and a place is often a full
 * street address ("4000 Ontario Center, Ontario, CA, 91764"), so a comma
 * inside it is ordinary and nothing splits on it. The CSV helpers above stay
 * for the backend-vocabulary lists (`connectors` / `eventTypes` /
 * `fileKinds`), whose values are the server's own names.
 *
 * A link from before this change, `?people=a,b`, now reads as the one name
 * "a,b"; a single value reads the same either way.
 */
export const LIST_PARAMS = ['people', 'places', 'tags'] as const;

export function readListParam(params: URLSearchParams, key: string): string[] {
  return params.getAll(key).map(normalizeFilterValue).filter(Boolean);
}

export function writeListParam(params: URLSearchParams, key: string, next: string[]) {
  params.delete(key);

  for (const value of next.map(normalizeFilterValue).filter(Boolean)) {
    params.append(key, value);
  }
}

/**
 * Validation for the exact-match list dimensions (How / Activity): a value is
 * one of the backend's own names, so only the CSV framing can go wrong.
 */
export function validateExactFilterValue(value: string): string | null {
  const normalized = normalizeFilterValue(value);

  if (!normalized) {
    return 'Enter a value first.';
  }

  if (normalized.includes(',')) {
    return 'Values cannot include commas.';
  }

  return null;
}

function validatePersonFilterValue(value: string): string | null {
  const normalized = normalizeFilterValue(value);

  if (!normalized) {
    return 'Enter a name first.';
  }

  if (normalized.length < 2) {
    return 'Use at least 2 characters.';
  }

  if (normalized.length > 80) {
    return 'Keep names under 80 characters.';
  }

  return null;
}

function validateTagFilterValue(value: string): string | null {
  const normalized = normalizeFilterValue(value);

  if (!normalized) {
    return 'Drop a tag first.';
  }

  if (normalized.length > 80) {
    return 'Keep tags under 80 characters.';
  }

  return null;
}

function validatePlaceFilterValue(value: string): string | null {
  const normalized = normalizeFilterValue(value);

  if (!normalized) {
    return 'Search for a place first.';
  }

  if (normalized.length < 2) {
    return 'Use at least 2 characters.';
  }

  if (normalized.length > 120) {
    return 'Keep place names under 120 characters.';
  }

  return null;
}

// The entity filter dimensions a search result can feed (by drag onto the drop
// area, or arrow keys on a highlighted suggestion): which URL param each kind
// writes and the validator for an incoming name.
export const ENTITY_FILTER_KINDS: Record<
  FilterDragKind,
  { param: string; validate: (value: string) => string | null }
> = {
  person: { param: 'people', validate: validatePersonFilterValue },
  place: { param: 'places', validate: validatePlaceFilterValue },
  tag: { param: 'tags', validate: validateTagFilterValue },
};

/**
 * Validate and append one entity filter value to its CSV param. Mutates
 * `params` only on success; returns the validation/duplicate error otherwise.
 */
export function addEntityFilter(
  params: URLSearchParams,
  kind: FilterDragKind,
  rawName: string,
): string | null {
  const { param, validate } = ENTITY_FILTER_KINDS[kind];
  const validation = validate(rawName);

  if (validation) {
    return validation;
  }

  // Tag labels are canonically lowercase (the backend lowercases on create).
  const normalized =
    kind === 'tag' ? normalizeFilterValue(rawName).toLocaleLowerCase() : normalizeFilterValue(rawName);
  const current = readListParam(params, param);

  if (current.some((value) => filterValueKey(value) === filterValueKey(normalized))) {
    return `${normalized} is already selected.`;
  }

  writeListParam(params, param, [...current, normalized]);

  return null;
}

/** Remove one entity filter value from its list param (no-op when absent). */
export function removeEntityFilter(params: URLSearchParams, kind: FilterDragKind, name: string) {
  const { param } = ENTITY_FILTER_KINDS[kind];
  const key = filterValueKey(name);

  writeListParam(
    params,
    param,
    readListParam(params, param).filter((value) => filterValueKey(value) !== key),
  );
}

/** Number of distinct active filter dimensions (for the "N filters" indicators). */
export function countActiveFilters(params: URLSearchParams): number {
  let count = 0;

  if (narrowedEntityTypes(params) !== null) {
    count += 1;
  }

  for (const key of ['connectors', 'eventTypes']) {
    count += readCsvParam(params, key).length;
  }

  for (const key of LIST_PARAMS) {
    count += readListParam(params, key).length;
  }

  if (params.get('from') || params.get('to')) {
    count += 1;
  }

  if (params.get('direction')) {
    count += 1;
  }

  if (params.get('hasLocation') === '1') {
    count += 1;
  }

  if (params.get('semantic') === '1') {
    count += 1;
  }

  // One dimension however many rectangles it holds: they are one Where.
  if (params.get('areas') || params.get('bbox')) {
    count += 1;
  }

  return count;
}

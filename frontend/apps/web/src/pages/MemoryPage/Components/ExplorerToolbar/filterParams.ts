import type { FilterDragKind } from '@/components/SearchBox/filterDrag';
import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';

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
  'sortBy',
  'sortOrder',
  'connectors',
  'people',
  'places',
  'hasLocation',
  'semantic',
  'bbox',
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

function validatePersonFilterValue(value: string): string | null {
  const normalized = normalizeFilterValue(value);

  if (!normalized) {
    return 'Enter a name first.';
  }

  if (normalized.includes(',')) {
    return 'Names cannot include commas.';
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

  if (normalized.includes(',')) {
    return 'Tags cannot include commas.';
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

  if (normalized.includes(',')) {
    return 'Place filters cannot include commas.';
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
  const current = readCsvParam(params, param);

  if (current.some((value) => filterValueKey(value) === filterValueKey(normalized))) {
    return `${normalized} is already selected.`;
  }

  writeCsvFilterParam(params, param, [...current, normalized]);

  return null;
}

/** Remove one entity filter value from its CSV param (no-op when absent). */
export function removeEntityFilter(params: URLSearchParams, kind: FilterDragKind, name: string) {
  const { param } = ENTITY_FILTER_KINDS[kind];
  const key = filterValueKey(name);

  writeCsvFilterParam(
    params,
    param,
    readCsvParam(params, param).filter((value) => filterValueKey(value) !== key),
  );
}

/** Number of distinct active filter dimensions (for the "N filters" indicators). */
export function countActiveFilters(params: URLSearchParams): number {
  let count = 0;

  if (narrowedEntityTypes(params) !== null) {
    count += 1;
  }

  for (const key of ['connectors', 'eventTypes', 'people', 'places', 'tags']) {
    count += params.get(key)?.split(',').filter(Boolean).length ?? 0;
  }

  if (params.get('from') || params.get('to')) {
    count += 1;
  }

  if (params.get('hasLocation') === '1') {
    count += 1;
  }

  if (params.get('semantic') === '1') {
    count += 1;
  }

  if (params.get('bbox')) {
    count += 1;
  }

  return count;
}

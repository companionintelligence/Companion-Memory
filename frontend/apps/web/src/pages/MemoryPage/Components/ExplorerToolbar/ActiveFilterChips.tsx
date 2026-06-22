import { Badge, Button } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';

// Every URL param the explorer toolbar can set. `Clear all` removes all of them;
// `countActiveFilters` powers the "Filters (N)" badge. `search` is excluded —
// it lives in the always-visible search box and reads as its own affordance.
const FILTER_PARAMS = [
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

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

/** Number of distinct active filter dimensions (for the "Filters (N)" badge). */
export function countActiveFilters(params: URLSearchParams): number {
  let count = 0;

  if (params.get('excludedEntityTypes')) {
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

interface Chip {
  key: string;
  label: string;
  onRemove: (params: URLSearchParams) => void;
}

/** Always-visible row of removable chips summarising the applied filters. */
export function ActiveFilterChips() {
  const [searchParams, setSearchParams] = useSearchParams();

  const removeFromCsv = (key: string, value: string) => (params: URLSearchParams) => {
    const next = (params.get(key)?.split(',') ?? []).filter((entry) => entry && entry !== value);

    if (next.length) {
      params.set(key, next.join(','));
    } else {
      params.delete(key);
    }
  };

  const deleteKey =
    (...keys: string[]) =>
    (params: URLSearchParams) =>
      keys.forEach((key) => params.delete(key));

  const chips: Chip[] = [];

  // Entity types use an inverted (exclude-list) representation; show the count of
  // still-selected types when not everything is selected.
  const excluded = searchParams.get('excludedEntityTypes')?.split(',').filter(Boolean) ?? [];
  if (excluded.length) {
    const selected = AVAILABLE_ENTITY_TYPES.length - excluded.length;
    chips.push({
      key: 'types',
      label: `Types: ${selected} of ${AVAILABLE_ENTITY_TYPES.length}`,
      onRemove: deleteKey('excludedEntityTypes', 'includedEntityTypes'),
    });
  }

  for (const { key, prefix } of [
    { key: 'connectors', prefix: 'Source' },
    { key: 'eventTypes', prefix: 'Activity' },
    { key: 'people', prefix: 'Who' },
    { key: 'places', prefix: 'Where' },
  ]) {
    for (const value of searchParams.get(key)?.split(',').filter(Boolean) ?? []) {
      chips.push({
        key: `${key}:${value}`,
        label: `${prefix}: ${value}`,
        onRemove: removeFromCsv(key, value),
      });
    }
  }

  for (const value of searchParams.get('tags')?.split(',').filter(Boolean) ?? []) {
    chips.push({ key: `tag:${value}`, label: `#${value}`, onRemove: removeFromCsv('tags', value) });
  }

  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from || to) {
    const label =
      from && to
        ? `${fmtDate(from)} – ${fmtDate(to)}`
        : from
          ? `After ${fmtDate(from)}`
          : `Before ${fmtDate(to as string)}`;
    chips.push({ key: 'date', label, onRemove: deleteKey('from', 'to') });
  }

  if (searchParams.get('hasLocation') === '1') {
    chips.push({ key: 'located', label: 'Located', onRemove: deleteKey('hasLocation') });
  }

  if (searchParams.get('semantic') === '1') {
    chips.push({ key: 'semantic', label: 'Semantic', onRemove: deleteKey('semantic') });
  }

  // The map's "Search this area" viewport filter (?bbox=...) — surface + clearable.
  if (searchParams.get('bbox')) {
    chips.push({ key: 'bbox', label: 'Map area', onRemove: deleteKey('bbox') });
  }

  if (chips.length === 0) {
    return null;
  }

  const apply = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams((params) => {
      mutate(params);

      return params;
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Badge key={chip.key} variant="secondary" className="gap-1">
          {chip.label}
          <button type="button" onClick={() => apply(chip.onRemove)} aria-label={`Remove ${chip.label}`}>
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-muted-foreground"
        onClick={() => apply(deleteKey('search', ...FILTER_PARAMS))}
      >
        Clear all
      </Button>
    </div>
  );
}

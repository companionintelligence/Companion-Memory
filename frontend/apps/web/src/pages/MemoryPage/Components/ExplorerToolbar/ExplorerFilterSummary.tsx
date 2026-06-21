import { Badge, Button } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { useEntityService } from '../../useEntityService';

import { EXPLORER_PARAM_KEYS, formatDateLabel, sortLabel } from './constants';

/** One active-filter chip: a human label plus the URL params its ✕ removes. */
interface FilterChip {
  id: string;
  label: string;
  params: string[];
}

/** Compact "a, b" for short lists, "a +N" once it would get noisy. */
function summarizeValues(values: string[]): string {
  return values.length <= 2 ? values.join(', ') : `${values[0]} +${values.length - 1}`;
}

/** Derive a removable chip per active explorer filter from the URL params. */
function buildChips(params: URLSearchParams): FilterChip[] {
  const chips: FilterChip[] = [];
  const list = (key: string) => params.get(key)?.split(',').filter(Boolean) ?? [];

  const pushList = (key: string, prefix: string) => {
    const values = list(key);

    if (values.length > 0) {
      chips.push({ id: key, label: `${prefix}: ${summarizeValues(values)}`, params: [key] });
    }
  };

  const search = params.get('search')?.trim();

  if (search) {
    chips.push({ id: 'search', label: `Search: “${search}”`, params: ['search'] });
  }

  pushList('includedEntityTypes', 'Types');
  pushList('excludedEntityTypes', 'Excluding');
  pushList('eventTypes', 'Activity');
  pushList('connectors', 'Source');
  pushList('people', 'Who');
  pushList('places', 'Where');
  pushList('tags', 'Tags');

  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  if (from || to) {
    // A date range is one logical filter spread across two params.
    chips.push({ id: 'date', label: formatDateLabel(from, to), params: ['from', 'to'] });
  }

  const sortBy = params.get('sortBy') ?? '';

  if (sortBy) {
    chips.push({
      id: 'sort',
      label: `Sort: ${sortLabel(sortBy, params.get('sortOrder') ?? '')}`,
      params: ['sortBy', 'sortOrder'],
    });
  }

  if (params.get('hasLocation') === '1') {
    chips.push({ id: 'hasLocation', label: 'Located', params: ['hasLocation'] });
  }

  if (params.get('semantic') === '1') {
    chips.push({ id: 'semantic', label: 'Semantic', params: ['semantic'] });
  }

  return chips;
}

/**
 * At-a-glance summary beneath the explorer toolbar: the result count, one
 * removable chip per active filter, and a one-click "Clear all". State lives in
 * the URL search params, so every action here is a param mutation that the
 * Search query re-reads. Rendered on both the desktop and mobile memory pages.
 */
export function ExplorerFilterSummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ totalCount, loading }] = useEntityService();

  const chips = buildChips(searchParams);
  const hasCount = totalCount != null;

  const removeParams = (keys: string[]) =>
    setSearchParams((params) => {
      keys.forEach((key) => params.delete(key));

      return params;
    });

  const clearAll = () =>
    setSearchParams((params) => {
      EXPLORER_PARAM_KEYS.forEach((key) => params.delete(key));

      return params;
    });

  // Nothing to say yet — no results loaded and no filters applied.
  if (!hasCount && !loading && chips.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {(hasCount || loading) && (
        <span className="text-muted-foreground">
          {hasCount
            ? `${totalCount.toLocaleString()} ${totalCount === 1 ? 'result' : 'results'}`
            : 'Searching…'}
        </span>
      )}

      {(hasCount || loading) && chips.length > 0 && (
        <span className="text-muted-foreground" aria-hidden>
          ·
        </span>
      )}

      {chips.map((chip) => (
        <Badge key={chip.id} variant="secondary" className="gap-1">
          {chip.label}
          <button
            type="button"
            onClick={() => removeParams(chip.params)}
            aria-label={`Remove ${chip.label} filter`}
            className="-mr-0.5 rounded-sm hover:text-foreground focus-visible:outline-none"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      {chips.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-muted-foreground"
          onClick={clearAll}
        >
          Clear all ({chips.length})
        </Button>
      )}
    </div>
  );
}

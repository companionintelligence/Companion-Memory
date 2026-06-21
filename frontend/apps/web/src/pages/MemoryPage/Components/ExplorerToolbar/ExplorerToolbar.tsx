import { useEffect, useState } from 'react';

import { Badge, Button, Calendar, Input, Popover, Select } from '@ci/shadcn';
import { Calendar as CalendarIcon, MapPin, Search, SlidersHorizontal, Sparkles, X } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { ConnectorFilter } from '@/components/SearchBox/ConnectorFilter';
import { EntityTypeFilter } from '@/components/SearchBox/EntityTypeFilter';
import { HowFilter } from '@/components/SearchBox/HowFilter';
import { DropdownProvider, useDropdown } from '@/components/SearchBox/useDropdown';
import { TagInput } from '@/components/TagInput';

import { useEntityService } from '../../useEntityService';

import { ActiveFilterChips, countActiveFilters } from './ActiveFilterChips';

// Single-select sort presets that map to the backend's sortBy + sortOrder pair.
const SORT_OPTIONS = [
  { value: 'default', label: 'Default', sortBy: '', sortOrder: '' },
  { value: 'relevance', label: 'Relevance', sortBy: 'relevance', sortOrder: 'desc' },
  { value: 'newest', label: 'Newest first', sortBy: 'time', sortOrder: 'desc' },
  { value: 'oldest', label: 'Oldest first', sortBy: 'time', sortOrder: 'asc' },
  { value: 'name-asc', label: 'Name (A–Z)', sortBy: 'name', sortOrder: 'asc' },
  { value: 'name-desc', label: 'Name (Z–A)', sortBy: 'name', sortOrder: 'desc' },
] as const;

function formatDateLabel(dateFrom: string, dateTo: string): string {
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

/** Debounced free-text search bound to the `?search` URL param. */
function SearchField() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlValue = searchParams.get('search') ?? '';
  const [value, setValue] = useState(urlValue);

  // Keep the input in sync when the URL changes externally (e.g. clear, saved search).
  useEffect(() => {
    setValue(urlValue);
  }, [urlValue]);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (value === urlValue) {
        return;
      }

      setSearchParams(
        (params) => {
          if (value) {
            params.set('search', value);
          } else {
            params.delete('search');
          }

          return params;
        },
        { replace: true },
      );
    }, 350);

    return () => clearTimeout(handle);
  }, [value, urlValue, setSearchParams]);

  return (
    <div className="relative min-w-[220px] flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search your memory…"
        className="pl-8"
      />
    </div>
  );
}

/** A comma-list URL param edited as removable chips (used for who/where). */
function ChipFilter({ param, placeholder }: { param: string; placeholder: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const values = searchParams.get(param)?.split(',').filter(Boolean) ?? [];
  const [draft, setDraft] = useState('');

  const write = (next: string[]) => {
    setSearchParams((params) => {
      if (next.length === 0) {
        params.delete(param);
      } else {
        params.set(param, next.join(','));
      }

      return params;
    });
  };

  const add = () => {
    const value = draft.trim();

    if (value && !values.includes(value)) {
      write([...values, value]);
    }

    setDraft('');
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={placeholder}
        className="h-9 w-[140px]"
      />
      {values.map((value) => (
        <Badge key={value} variant="secondary" className="gap-1">
          {value}
          <button
            type="button"
            onClick={() => write(values.filter((entry) => entry !== value))}
            aria-label={`Remove ${value}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

/** A boolean URL flag rendered as a toggle button (used for located-only / semantic). */
function ToggleChip({ param, label, icon }: { param: string; label: string; icon: React.ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = searchParams.get(param) === '1';

  return (
    <Button
      type="button"
      variant={active ? 'secondary' : 'outline'}
      onClick={() =>
        setSearchParams((params) => {
          if (active) {
            params.delete(param);
          } else {
            params.set(param, '1');
          }

          return params;
        })
      }
    >
      {icon}
      <span className="ml-1">{label}</span>
    </Button>
  );
}

function ExplorerToolbarInner() {
  const [{ tags, dateFrom, dateTo, sortBy, sortOrder }, { setTags, setDateRange, setSort }] = useDropdown();
  const [{ data, hasNextPage, loading }] = useEntityService();
  const [searchParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const activeCount = countActiveFilters(searchParams);

  const selectedRange =
    dateFrom || dateTo
      ? { from: dateFrom ? new Date(dateFrom) : undefined, to: dateTo ? new Date(dateTo) : undefined }
      : undefined;

  const currentSort =
    SORT_OPTIONS.find((option) => option.sortBy === sortBy && option.sortOrder === sortOrder)?.value ??
    'default';

  return (
    <div className="flex flex-col gap-2">
      {/* Primary row — always visible: search, when, sort, the Filters toggle, and the result count. */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchField />

        <Popover>
          <Popover.Trigger asChild>
            <Button variant="outline">
              <CalendarIcon className="mr-2 h-4 w-4" />
              {formatDateLabel(dateFrom, dateTo)}
            </Button>
          </Popover.Trigger>
          <Popover.Content className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={selectedRange}
              onSelect={(range) => {
                const from = range?.from ? range.from.toISOString() : undefined;
                let to: string | undefined;

                if (range?.to) {
                  const end = new Date(range.to);
                  end.setHours(23, 59, 59, 999);
                  to = end.toISOString();
                }

                setDateRange(from, to);
              }}
              numberOfMonths={1}
            />
            {(dateFrom || dateTo) && (
              <div className="border-t p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setDateRange(undefined, undefined)}
                >
                  Clear dates
                </Button>
              </div>
            )}
          </Popover.Content>
        </Popover>

        <Select
          value={currentSort}
          onValueChange={(value) => {
            const option = SORT_OPTIONS.find((item) => item.value === value);

            setSort(option?.sortBy || undefined, option?.sortOrder || undefined);
          }}
        >
          <Select.Trigger className="w-[150px]">
            <Select.Value placeholder="Sort" />
          </Select.Trigger>
          <Select.Content>
            {SORT_OPTIONS.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>

        <Button
          type="button"
          variant={filtersOpen ? 'secondary' : 'outline'}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Filters
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-2 h-5 px-1.5">
              {activeCount}
            </Badge>
          )}
        </Button>

        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          {loading && data.length === 0
            ? 'Searching…'
            : `Showing ${data.length.toLocaleString()}${hasNextPage ? '+' : ''}`}
        </span>
      </div>

      {/* Advanced filters — collapsed by default to keep the bar uncluttered. */}
      {filtersOpen && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-2">
          <EntityTypeFilter modal={false} />
          <HowFilter modal={false} />
          <ConnectorFilter modal={false} />
          <ChipFilter param="people" placeholder="Who…" />
          <ChipFilter param="places" placeholder="Where…" />
          <ToggleChip param="hasLocation" label="Located" icon={<MapPin className="h-4 w-4" />} />
          <ToggleChip param="semantic" label="Semantic" icon={<Sparkles className="h-4 w-4" />} />
          <div className="min-w-[160px]">
            <TagInput
              tags={tags}
              onTagAdded={(tag) => {
                setTags([...tags, tag]);

                return true;
              }}
              onTagRemoved={(tag) => setTags(tags.filter((value) => value !== tag))}
            />
          </div>
        </div>
      )}

      {/* Applied filters as removable chips — always visible when any are set. */}
      <ActiveFilterChips />
    </div>
  );
}

/**
 * The always-visible explorer toolbar: free-text search plus the full
 * LifeScope-parity filter set (what / how / connector / who / where / when),
 * sort, semantic toggle, and tags. Wrapped in DropdownProvider so the
 * useDropdown URL-param setters (entity types, date, sort, tags) work.
 */
export function ExplorerToolbar() {
  return (
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <ExplorerToolbarInner />
    </DropdownProvider>
  );
}

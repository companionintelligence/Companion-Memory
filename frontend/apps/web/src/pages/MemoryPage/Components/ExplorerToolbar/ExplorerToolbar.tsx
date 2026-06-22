import { useEffect, useState } from 'react';

import { useMutation } from '@apollo/client';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { Badge, Button, Calendar, Dialog, Input, Label, Popover, Select, useToast } from '@ci/shadcn';
import {
  ArrowUpDown,
  Calendar as CalendarIcon,
  ChevronDown,
  ChevronUp,
  MapPin,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { ConnectorFilter } from '@/components/SearchBox/ConnectorFilter';
import { EntityTypeFilter } from '@/components/SearchBox/EntityTypeFilter';
import { DropdownProvider, useDropdown } from '@/components/SearchBox/useDropdown';
import { TagInput } from '@/components/TagInput';
import { gql } from '@/graphql';

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

const CREATE_SAVED_SEARCH = gql(`
  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {
    createSavedSearch(input: $input) {
      success
      savedSearch {
        id
        name
        description
        query
        entityTypes
        tags
      }
    }
  }
`);

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

/** Date-range picker bound to the `from`/`to` URL params. */
function DateControl() {
  const [{ dateFrom, dateTo }, { setDateRange }] = useDropdown();

  const selectedRange =
    dateFrom || dateTo
      ? { from: dateFrom ? new Date(dateFrom) : undefined, to: dateTo ? new Date(dateTo) : undefined }
      : undefined;

  return (
    <Popover>
      <Popover.Trigger asChild>
        <Button variant="outline">
          <CalendarIcon className="mr-2 h-4 w-4 text-muted-foreground" />
          When: {dateFrom || dateTo ? formatDateLabel(dateFrom, dateTo) : 'all'}
          <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
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
  );
}

/** Sort preset selector bound to the `sortBy`/`sortOrder` URL params. */
function SortControl() {
  const [{ sortBy, sortOrder }, { setSort }] = useDropdown();

  const currentSort =
    SORT_OPTIONS.find((option) => option.sortBy === sortBy && option.sortOrder === sortOrder)?.value ??
    'default';

  return (
    <Select
      value={currentSort}
      onValueChange={(value) => {
        const option = SORT_OPTIONS.find((item) => item.value === value);

        setSort(option?.sortBy || undefined, option?.sortOrder || undefined);
      }}
    >
      <Select.Trigger className="w-[150px]">
        <ArrowUpDown className="mr-2 h-4 w-4 text-muted-foreground" />
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
  );
}

/** "Who" — the people dimension, as a plain "Who: …" dropdown over `people`. */
function WhoFilter() {
  const [searchParams] = useSearchParams();
  const people = searchParams.get('people')?.split(',').filter(Boolean) ?? [];
  const value = people.length === 0 ? 'all' : people.length === 1 ? people[0] : `${people.length} selected`;

  return (
    <Popover>
      <Popover.Trigger asChild>
        <Button variant="outline">
          <Users className="mr-2 h-4 w-4 text-muted-foreground" />
          Who: {value}
          <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
        </Button>
      </Popover.Trigger>
      <Popover.Content align="start" className="w-72 space-y-2">
        <span className="text-xs font-medium text-muted-foreground">People involved</span>
        <ChipFilter param="people" placeholder="Add a name…" />
      </Popover.Content>
    </Popover>
  );
}

/** "Where" — the location dimension (located-only + place names) as a "Where: …" dropdown. */
function WhereFilter() {
  const [searchParams] = useSearchParams();
  const located = searchParams.get('hasLocation') === '1';
  const places = searchParams.get('places')?.split(',').filter(Boolean) ?? [];
  const value =
    places.length > 0
      ? places.length === 1
        ? places[0]
        : `${places.length} places`
      : located
        ? 'located'
        : 'all';

  return (
    <Popover>
      <Popover.Trigger asChild>
        <Button variant="outline">
          <MapPin className="mr-2 h-4 w-4 text-muted-foreground" />
          Where: {value}
          <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
        </Button>
      </Popover.Trigger>
      <Popover.Content align="start" className="w-72 space-y-3">
        <ToggleChip param="hasLocation" label="Has a location" icon={<MapPin className="h-4 w-4" />} />
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Places</span>
          <ChipFilter param="places" placeholder="Add a place…" />
        </div>
      </Popover.Content>
    </Popover>
  );
}

/**
 * The advanced search controls in plain Who / What / When / Where / How order,
 * followed by tags + a semantic toggle, then sort + save. `modal` is forwarded
 * to the portaled Radix dropdowns so they behave inside a modal Sheet/Dialog.
 */
function AdvancedFilters({ modal }: { modal: boolean }) {
  const [{ tags }, { setTags }] = useDropdown();

  return (
    <>
      <WhoFilter />
      <EntityTypeFilter modal={modal} label="What" />
      <DateControl />
      <WhereFilter />
      <ConnectorFilter modal={modal} label="How" />

      <span className="mx-1 h-6 w-px self-center bg-border" />

      <div className="w-44">
        <TagInput
          tags={tags}
          onTagAdded={(tag) => {
            setTags([...tags, tag]);

            return true;
          }}
          onTagRemoved={(tag) => setTags(tags.filter((value) => value !== tag))}
        />
      </div>
      <ToggleChip param="semantic" label="Semantic" icon={<Sparkles className="h-4 w-4" />} />

      <span className="mx-1 h-6 w-px self-center bg-border" />

      <SortControl />
      <SaveSearchButton />
    </>
  );
}

/**
 * "Save search" — captures a name and persists the current query + selected
 * entity types + tags as a SavedSearch (shown on the Saved Searches page).
 */
function SaveSearchButton() {
  const [searchParams] = useSearchParams();
  const [{ selectedEntityTypes }] = useDropdown();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const [createSavedSearch, { loading }] = useMutation(CREATE_SAVED_SEARCH, {
    // Drop the cached list so the Saved Searches page refetches it with the new entry.
    update(cache, { data }) {
      if (data?.createSavedSearch?.success) {
        cache.evict({ id: 'ROOT_QUERY', fieldName: 'savedSearches' });
        cache.gc();
      }
    },
  });

  const handleSave = async () => {
    const trimmed = name.trim();

    if (!trimmed) {
      return;
    }

    const query = searchParams.get('search')?.trim() || undefined;
    const tags = searchParams.get('tags')?.split(',').filter(Boolean) ?? [];
    const entityTypes = selectedEntityTypes.map(
      (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP],
    );

    try {
      const result = await createSavedSearch({
        variables: {
          input: {
            name: trimmed,
            query,
            entityTypes,
            tags: tags.length > 0 ? tags : undefined,
          },
        },
      });

      if (result.data?.createSavedSearch?.success) {
        toast.success(`Saved search “${trimmed}”`);
        setName('');
        setOpen(false);
      } else {
        toast.error('Failed to save search');
      }
    } catch {
      toast.error('Failed to save search');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="outline">
          <Save className="mr-2 h-4 w-4" />
          Save search
        </Button>
      </Dialog.Trigger>
      <Dialog.Content className="sm:max-w-[420px]">
        <Dialog.Header>
          <Dialog.Title>Save this search</Dialog.Title>
          <Dialog.Description>
            Stores the current query, selected entity types, and tags so you can reuse them later.
          </Dialog.Description>
        </Dialog.Header>

        <div className="space-y-2 py-2">
          <Label htmlFor="saved-search-name">Name</Label>
          <Input
            id="saved-search-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSave();
              }
            }}
            placeholder="e.g. Work emails this month"
          />
        </div>

        <Dialog.Footer>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading || !name.trim()}>
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

function ResultCount() {
  const [{ data, hasNextPage, loading }] = useEntityService();

  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground">
      {loading && data.length === 0
        ? 'Searching…'
        : `Showing ${data.length.toLocaleString()}${hasNextPage ? '+' : ''}`}
    </span>
  );
}

/**
 * The "Advanced" toggle. Lives in the global header (desktop) or above the mobile
 * tabs; it controls the toolbar drawer via the page's lifted `open` state and
 * surfaces the active-filter count with an up/down chevron.
 */
export function AdvancedSearchToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [searchParams] = useSearchParams();
  const activeCount = countActiveFilters(searchParams);

  return (
    <Button
      type="button"
      variant={open || activeCount > 0 ? 'secondary' : 'outline'}
      onClick={onToggle}
      aria-expanded={open}
    >
      <SlidersHorizontal className="mr-2 h-4 w-4" />
      Advanced
      {activeCount > 0 && (
        <Badge variant="secondary" className="ml-2 h-5 px-1.5">
          {activeCount}
        </Badge>
      )}
      {open ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
    </Button>
  );
}

/**
 * Debounced free-text search bound to the `?search` URL param. Used on mobile,
 * where the unified header search bar isn't shown; desktop uses the header
 * GlobalSearchBox instead.
 */
export function MemorySearchField() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlValue = searchParams.get('search') ?? '';
  const [value, setValue] = useState(urlValue);

  // Keep the input in sync when the URL changes externally (clear, saved search).
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
    <div className="relative w-full">
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

function ExplorerToolbarInner({ open }: { open: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {/* The advanced-search drawer: plain Who / What / When / Where / How, then
          tags + semantic, then sort + save. Opened from the header toggle. */}
      {open && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <AdvancedFilters modal={false} />
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <ActiveFilterChips />
        </div>
        <div className="shrink-0">
          <ResultCount />
        </div>
      </div>
    </div>
  );
}

/**
 * The explorer toolbar body that sits under the unified header bar: the
 * advanced-search drawer (Who / What / When / Where / How + tags, semantic, sort,
 * save) plus the active-filter chips and result count. `open` is controlled by
 * the page — the AdvancedSearchToggle that flips it lives in the header. Wrapped
 * in DropdownProvider so the useDropdown URL-param setters work.
 */
export function ExplorerToolbar({ open }: { open: boolean }) {
  return (
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <ExplorerToolbarInner open={open} />
    </DropdownProvider>
  );
}

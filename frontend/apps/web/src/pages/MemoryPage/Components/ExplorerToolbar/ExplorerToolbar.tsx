import { useEffect, useMemo, useState } from 'react';

import { gql as apolloGql, useMutation, useQuery } from '@apollo/client';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import {
  Badge,
  Button,
  Calendar,
  Dialog,
  Input,
  Label,
  Popover,
  Select,
  Tooltip,
  cn,
  useToast,
} from '@ci/shadcn';
import {
  ArrowUpDown,
  Calendar as CalendarIcon,
  ChevronDown,
  Check,
  Clock,
  MapPin,
  Plus,
  Save,
  Search,
  Share2,
  Sparkles,
  Users,
  X,
} from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { ConnectorFilter } from '@/components/SearchBox/ConnectorFilter';
import { EntityTypeFilter } from '@/components/SearchBox/EntityTypeFilter';
import { DropdownProvider, useDropdown } from '@/components/SearchBox/useDropdown';
import { TagInput } from '@/components/TagInput';
import { gql, type FragmentType } from '@/graphql';

import type { SavedSearchGridItemFragment } from '../../../SavedSearchesPage/SavedSearch';
import { ShareSavedSearchModal } from '../../../SavedSearchesPage/ShareSavedSearchModal';
import { buildSavedSearchFilters } from '../../savedSearchFilters';
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

const MAX_PERSON_SUGGESTIONS = 8;
const MAX_PLACE_SUGGESTIONS = 8;
const START_OF_DAY_TIME = '00:00';
const END_OF_DAY_TIME = '23:59';

const CREATE_SAVED_SEARCH = gql(`
  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {
    createSavedSearch(input: $input) {
      success
      savedSearch {
        id
        # Full grid fragment (incl. isPublic/shareToken/filters) so the created
        # search can be handed straight to the share modal from "Save & share".
        ...SavedSearchGridItemFragment
      }
    }
  }
`);

const EXPLORER_PEOPLE = apolloGql`
  query ExplorerPeople {
    people(first: 100) {
      edges {
        node {
          id
          name
          description
        }
      }
    }
  }
`;

const EXPLORER_PLACES = apolloGql`
  query ExplorerPlaces {
    places(first: 100) {
      edges {
        node {
          id
          name
          description
          type
          properties
        }
      }
    }
  }
`;

interface ExplorerPeopleQuery {
  people?: {
    edges: Array<{
      node: {
        id: string;
        name?: string | null;
        description?: string | null;
      };
    }>;
  };
}

interface ExplorerPlacesQuery {
  places?: {
    edges: Array<{
      node: {
        id: string;
        name?: string | null;
        description?: string | null;
        type?: string | null;
        properties?: Record<string, unknown> | null;
      };
    }>;
  };
}

interface PersonOption {
  id: string;
  name: string;
  description?: string | null;
}

interface PlaceOption {
  id: string;
  name: string;
  description?: string | null;
  type?: string | null;
  address?: string | null;
}

// The user's existing tags, used to autocomplete the drawer's tag filter — the
// same vocabulary the Tags page browses, so the two stay unified.
const EXPLORER_TAGS = gql(`
  query ExplorerTags {
    tags {
      edges {
        node {
          id
          label
        }
      }
    }
  }
`);

function localDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function dateInputValue(value: string): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return localDateInputValue(date);
}

function timeInputValue(value: string, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function isCompleteTimeValue(value: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);

  return Boolean(match);
}

function dateTimeIso(dateValue: string, timeValue: string, mode: 'start' | 'end'): string | undefined {
  if (!dateValue) {
    return undefined;
  }

  const [year, month, day] = dateValue.split('-').map(Number);
  const [hours, minutes] = timeValue.split(':').map(Number);

  if ([year, month, day, hours, minutes].some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  const date = new Date(
    year,
    month - 1,
    day,
    hours,
    minutes,
    mode === 'end' ? 59 : 0,
    mode === 'end' ? 999 : 0,
  );

  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function rangeHasDetailedTime(dateFrom: string, dateTo: string): boolean {
  const fromHasTime = Boolean(dateFrom) && timeInputValue(dateFrom, START_OF_DAY_TIME) !== START_OF_DAY_TIME;
  const toHasTime = Boolean(dateTo) && timeInputValue(dateTo, END_OF_DAY_TIME) !== END_OF_DAY_TIME;

  return fromHasTime || toHasTime;
}

function formatDateLabel(dateFrom: string, dateTo: string): string {
  const includeTime = rangeHasDetailedTime(dateFrom, dateTo);
  const fmt = (value: string) => {
    const date = new Date(value);
    const dateLabel = date.toLocaleDateString();

    if (!includeTime) {
      return dateLabel;
    }

    return `${dateLabel}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };

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

function normalizeFilterValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function filterValueKey(value: string): string {
  return normalizeFilterValue(value).toLocaleLowerCase();
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

function writeCsvFilterParam(params: URLSearchParams, key: string, next: string[]) {
  const normalized = next.map(normalizeFilterValue).filter(Boolean);

  if (normalized.length === 0) {
    params.delete(key);
  } else {
    params.set(key, normalized.join(','));
  }
}

function PeopleFilterPicker() {
  const [searchParams, setSearchParams] = useSearchParams();
  const people = useMemo(
    () => searchParams.get('people')?.split(',').map(normalizeFilterValue).filter(Boolean) ?? [],
    [searchParams],
  );
  const selectedKeys = useMemo(() => new Set(people.map(filterValueKey)), [people]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const {
    data,
    loading,
    error: peopleError,
  } = useQuery<ExplorerPeopleQuery>(EXPLORER_PEOPLE, {
    fetchPolicy: 'cache-and-network',
  });

  const knownPeople = useMemo<PersonOption[]>(() => {
    const seen = new Set<string>();

    return (data?.people?.edges ?? [])
      .map(({ node }) => ({
        id: node.id,
        name: normalizeFilterValue(node.name ?? ''),
        description: node.description,
      }))
      .filter((person) => {
        const key = filterValueKey(person.name);

        if (!key || seen.has(key)) {
          return false;
        }

        seen.add(key);

        return true;
      });
  }, [data]);

  const query = filterValueKey(draft);
  const exactMatch = useMemo(
    () => knownPeople.find((person) => filterValueKey(person.name) === query),
    [knownPeople, query],
  );
  const suggestions = useMemo(() => {
    const matches = knownPeople.filter((person) => {
      const nameKey = filterValueKey(person.name);
      const description = person.description?.toLocaleLowerCase() ?? '';

      return !selectedKeys.has(nameKey) && (!query || nameKey.includes(query) || description.includes(query));
    });

    return matches
      .sort((a, b) => {
        const aStarts = filterValueKey(a.name).startsWith(query);
        const bStarts = filterValueKey(b.name).startsWith(query);

        if (aStarts !== bStarts) {
          return aStarts ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_PERSON_SUGGESTIONS);
  }, [knownPeople, query, selectedKeys]);

  const writePeople = (next: string[]) => {
    setSearchParams((params) => {
      writeCsvFilterParam(params, 'people', next);

      return params;
    });
  };

  const removePerson = (name: string) => {
    const key = filterValueKey(name);

    writePeople(people.filter((person) => filterValueKey(person) !== key));
    setError(null);
  };

  const addPerson = (rawName: string) => {
    const validation = validatePersonFilterValue(rawName);

    if (validation) {
      setError(validation);

      return;
    }

    const normalized = normalizeFilterValue(rawName);
    const canonical =
      knownPeople.find((person) => filterValueKey(person.name) === filterValueKey(normalized))?.name ??
      normalized;
    const key = filterValueKey(canonical);

    if (selectedKeys.has(key)) {
      setError(`${canonical} is already selected.`);
      setDraft('');

      return;
    }

    writePeople([...people, canonical]);
    setDraft('');
    setError(null);
  };

  const commitDraft = () => {
    const validation = validatePersonFilterValue(draft);

    if (validation) {
      setError(validation);

      return;
    }

    if (exactMatch) {
      addPerson(exactMatch.name);

      return;
    }

    if (suggestions.length === 1) {
      addPerson(suggestions[0].name);

      return;
    }

    if (suggestions.length > 1) {
      setError('Choose a matching person, or keep typing to narrow it.');

      return;
    }

    addPerson(draft);
  };

  const canCommitDraft =
    draft.trim().length > 0 &&
    validatePersonFilterValue(draft) === null &&
    (exactMatch || suggestions.length <= 1);
  const showCustomAdd =
    draft.trim().length > 0 &&
    validatePersonFilterValue(draft) === null &&
    !exactMatch &&
    suggestions.length === 0 &&
    !selectedKeys.has(filterValueKey(draft));

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">People involved</span>
          {people.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => writePeople([])}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              }

              if (event.key === ',') {
                event.preventDefault();
                setError('Names cannot include commas.');
              }

              if (event.key === 'Escape') {
                if (draft) {
                  setDraft('');
                  setError(null);
                } else {
                  event.currentTarget.blur();
                }
              }

              if (event.key === 'Backspace' && !event.currentTarget.value && people.length > 0) {
                removePerson(people[people.length - 1]);
              }
            }}
            placeholder="Search people…"
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'people-filter-error' : undefined}
            className="h-9"
          />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={!canCommitDraft}
            onClick={commitDraft}
            aria-label="Add person filter"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {error && (
          <p id="people-filter-error" className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      {people.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {people.map((person) => (
            <Badge key={person} variant="secondary" className="max-w-full gap-1.5 pl-2">
              <span className="max-w-[180px] truncate">{person}</span>
              <button
                type="button"
                onClick={() => removePerson(person)}
                aria-label={`Remove ${person}`}
                className="-mr-1 rounded p-0.5 hover:bg-background/60"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{query ? 'Matching people' : 'Suggested people'}</span>
          {loading && <span>Loading…</span>}
        </div>
        <div className="max-h-56 overflow-y-auto rounded-md border bg-background p-1">
          {showCustomAdd && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-accent"
              onClick={() => addPerson(draft)}
            >
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Add “{normalizeFilterValue(draft)}”</span>
            </button>
          )}
          {suggestions.length > 0 ? (
            suggestions.map((person) => (
              <button
                key={person.id}
                type="button"
                className="flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-accent"
                onClick={() => addPerson(person.name)}
              >
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{person.name}</span>
                  {person.description && (
                    <span className="block truncate text-xs text-muted-foreground">{person.description}</span>
                  )}
                </span>
                {exactMatch?.id === person.id && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
              </button>
            ))
          ) : (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              {loading
                ? 'Finding people…'
                : peopleError
                  ? 'Suggestions unavailable. Type a full name to add a custom filter.'
                  : 'No matching people. Type a full name to add a custom filter.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getPlaceAddress(properties: Record<string, unknown> | null | undefined): string | null {
  const address = properties?.address;

  return typeof address === 'string' ? normalizeFilterValue(address) : null;
}

function PlaceFilterPicker() {
  const [searchParams, setSearchParams] = useSearchParams();
  const places = useMemo(
    () => searchParams.get('places')?.split(',').map(normalizeFilterValue).filter(Boolean) ?? [],
    [searchParams],
  );
  const selectedKeys = useMemo(() => new Set(places.map(filterValueKey)), [places]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const {
    data,
    loading,
    error: placesError,
  } = useQuery<ExplorerPlacesQuery>(EXPLORER_PLACES, {
    fetchPolicy: 'cache-and-network',
  });

  const knownPlaces = useMemo<PlaceOption[]>(() => {
    const seen = new Set<string>();

    return (data?.places?.edges ?? [])
      .map(({ node }) => ({
        id: node.id,
        name: normalizeFilterValue(node.name ?? ''),
        description: node.description,
        type: node.type,
        address: getPlaceAddress(node.properties),
      }))
      .filter((place) => {
        const key = filterValueKey(place.name);

        if (!key || seen.has(key)) {
          return false;
        }

        seen.add(key);

        return true;
      });
  }, [data]);

  const query = filterValueKey(draft);
  const exactMatch = useMemo(
    () => knownPlaces.find((place) => filterValueKey(place.name) === query),
    [knownPlaces, query],
  );
  const suggestions = useMemo(() => {
    const matches = knownPlaces.filter((place) => {
      const nameKey = filterValueKey(place.name);
      const description = place.description?.toLocaleLowerCase() ?? '';
      const address = place.address?.toLocaleLowerCase() ?? '';
      const type = place.type?.toLocaleLowerCase() ?? '';

      return (
        !selectedKeys.has(nameKey) &&
        (!query ||
          nameKey.includes(query) ||
          description.includes(query) ||
          address.includes(query) ||
          type.includes(query))
      );
    });

    return matches
      .sort((a, b) => {
        const aStarts = filterValueKey(a.name).startsWith(query);
        const bStarts = filterValueKey(b.name).startsWith(query);

        if (aStarts !== bStarts) {
          return aStarts ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_PLACE_SUGGESTIONS);
  }, [knownPlaces, query, selectedKeys]);

  const writePlaces = (next: string[]) => {
    setSearchParams((params) => {
      writeCsvFilterParam(params, 'places', next);

      return params;
    });
  };

  const removePlace = (name: string) => {
    const key = filterValueKey(name);

    writePlaces(places.filter((place) => filterValueKey(place) !== key));
    setError(null);
  };

  const addPlace = (rawName: string) => {
    const validation = validatePlaceFilterValue(rawName);

    if (validation) {
      setError(validation);

      return;
    }

    const normalized = normalizeFilterValue(rawName);
    const canonical =
      knownPlaces.find((place) => filterValueKey(place.name) === filterValueKey(normalized))?.name ??
      normalized;
    const key = filterValueKey(canonical);

    if (selectedKeys.has(key)) {
      setError(`${canonical} is already selected.`);
      setDraft('');

      return;
    }

    if (!knownPlaces.some((place) => filterValueKey(place.name) === key)) {
      setError('Choose a saved place from the list.');

      return;
    }

    writePlaces([...places, canonical]);
    setDraft('');
    setError(null);
  };

  const commitDraft = () => {
    const validation = validatePlaceFilterValue(draft);

    if (validation) {
      setError(validation);

      return;
    }

    if (exactMatch) {
      addPlace(exactMatch.name);

      return;
    }

    if (suggestions.length === 1) {
      addPlace(suggestions[0].name);

      return;
    }

    if (suggestions.length > 1) {
      setError('Choose a matching place, or keep typing to narrow it.');

      return;
    }

    setError('Choose a saved place from the list.');
  };

  const canCommitDraft =
    draft.trim().length > 0 &&
    validatePlaceFilterValue(draft) === null &&
    Boolean(exactMatch || suggestions.length === 1);

  return (
    <div className="space-y-3">
      <ToggleChip param="hasLocation" label="Has a location" icon={<MapPin className="h-4 w-4" />} />

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">Places</span>
          {places.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => writePlaces([])}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              }

              if (event.key === ',') {
                event.preventDefault();
                setError('Place filters cannot include commas.');
              }

              if (event.key === 'Escape') {
                if (draft) {
                  setDraft('');
                  setError(null);
                } else {
                  event.currentTarget.blur();
                }
              }

              if (event.key === 'Backspace' && !event.currentTarget.value && places.length > 0) {
                removePlace(places[places.length - 1]);
              }
            }}
            placeholder="Search saved places..."
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'place-filter-error' : undefined}
            className="h-9"
          />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={!canCommitDraft}
            onClick={commitDraft}
            aria-label="Add place filter"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {error && (
          <p id="place-filter-error" className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      {places.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {places.map((place) => (
            <Badge key={place} variant="secondary" className="max-w-full gap-1.5 pl-2">
              <span className="max-w-[180px] truncate">{place}</span>
              <button
                type="button"
                onClick={() => removePlace(place)}
                aria-label={`Remove ${place}`}
                className="-mr-1 rounded p-0.5 hover:bg-background/60"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{query ? 'Matching places' : 'Saved places'}</span>
          {loading && <span>Loading...</span>}
        </div>
        <div className="max-h-60 overflow-y-auto rounded-md border bg-background p-1">
          {suggestions.length > 0 ? (
            suggestions.map((place) => {
              const secondary = [place.address, place.description, place.type].filter(Boolean).join(' - ');

              return (
                <button
                  key={place.id}
                  type="button"
                  className="flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-accent"
                  onClick={() => addPlace(place.name)}
                >
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{place.name}</span>
                    {secondary && (
                      <span className="block truncate text-xs text-muted-foreground">{secondary}</span>
                    )}
                  </span>
                  {exactMatch?.id === place.id && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })
          ) : (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              {loading
                ? 'Finding places...'
                : placesError
                  ? 'Saved places unavailable. Try again after the source data loads.'
                  : 'No saved places match. Use a place already in your memory.'}
            </div>
          )}
        </div>
      </div>
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
  const [timeExpanded, setTimeExpanded] = useState(() => rangeHasDetailedTime(dateFrom, dateTo));

  const selectedRange =
    dateFrom || dateTo
      ? { from: dateFrom ? new Date(dateFrom) : undefined, to: dateTo ? new Date(dateTo) : undefined }
      : undefined;
  const fromDateValue = dateInputValue(dateFrom);
  const toDateValue = dateInputValue(dateTo);
  const fromTimeValue = timeInputValue(dateFrom, START_OF_DAY_TIME);
  const toTimeValue = timeInputValue(dateTo, END_OF_DAY_TIME);
  const [draftFromTime, setDraftFromTime] = useState(fromTimeValue);
  const [draftToTime, setDraftToTime] = useState(toTimeValue);

  useEffect(() => {
    if (rangeHasDetailedTime(dateFrom, dateTo)) {
      setTimeExpanded(true);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    setDraftFromTime(fromTimeValue);
    setDraftToTime(toTimeValue);
  }, [fromTimeValue, toTimeValue]);

  const applyTime = (part: 'from' | 'to', value: string) => {
    const normalizedValue = value || (part === 'from' ? START_OF_DAY_TIME : END_OF_DAY_TIME);
    const nextFromTime = part === 'from' ? normalizedValue : draftFromTime;
    const nextToTime = part === 'to' ? normalizedValue : draftToTime;
    const nextFrom = fromDateValue ? dateTimeIso(fromDateValue, nextFromTime, 'start') : undefined;
    const nextTo = toDateValue ? dateTimeIso(toDateValue, nextToTime, 'end') : undefined;

    if ((fromDateValue && !nextFrom) || (toDateValue && !nextTo)) {
      return;
    }

    setDateRange(nextFrom, nextTo);
  };

  const handleTimeChange = (part: 'from' | 'to', value: string) => {
    if (part === 'from') {
      setDraftFromTime(value);
    } else {
      setDraftToTime(value);
    }

    if (isCompleteTimeValue(value)) {
      applyTime(part, value);
    }
  };

  const commitTime = (part: 'from' | 'to', value: string) => {
    const fallback = part === 'from' ? START_OF_DAY_TIME : END_OF_DAY_TIME;
    const nextValue = isCompleteTimeValue(value) ? value : fallback;

    if (part === 'from') {
      setDraftFromTime(nextValue);
    } else {
      setDraftToTime(nextValue);
    }

    applyTime(part, nextValue);
  };

  const clearDetailedTime = () => {
    setTimeExpanded(false);
    setDraftFromTime(START_OF_DAY_TIME);
    setDraftToTime(END_OF_DAY_TIME);
    setDateRange(
      fromDateValue ? dateTimeIso(fromDateValue, START_OF_DAY_TIME, 'start') : undefined,
      toDateValue ? dateTimeIso(toDateValue, END_OF_DAY_TIME, 'end') : undefined,
    );
  };

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
            const fromDate = range?.from ? localDateInputValue(range.from) : '';
            const toDate = range?.to ? localDateInputValue(range.to) : '';
            const from = fromDate
              ? dateTimeIso(fromDate, timeExpanded ? fromTimeValue : START_OF_DAY_TIME, 'start')
              : undefined;
            let to: string | undefined;

            if (toDate) {
              to = dateTimeIso(toDate, timeExpanded ? toTimeValue : END_OF_DAY_TIME, 'end');
            }

            setDateRange(from, to);
          }}
          numberOfMonths={1}
        />
        <div className="space-y-3 border-t p-3">
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => setTimeExpanded((open) => !open)}
            >
              <Clock className="mr-2 h-3.5 w-3.5" />
              Specific time
              <ChevronDown
                className={`ml-2 h-3.5 w-3.5 opacity-60 transition-transform ${timeExpanded ? 'rotate-180' : ''}`}
              />
            </Button>
            {timeExpanded && (dateFrom || dateTo) && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={clearDetailedTime}>
                All day
              </Button>
            )}
          </div>

          {timeExpanded && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="memory-filter-start-time" className="text-xs text-muted-foreground">
                  Start time
                </Label>
                <Input
                  id="memory-filter-start-time"
                  type="time"
                  value={draftFromTime}
                  disabled={!fromDateValue}
                  onChange={(event) => handleTimeChange('from', event.target.value)}
                  onBlur={(event) => commitTime('from', event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitTime('from', event.currentTarget.value);
                      event.currentTarget.blur();
                    }
                  }}
                  className="h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="memory-filter-end-time" className="text-xs text-muted-foreground">
                  End time
                </Label>
                <Input
                  id="memory-filter-end-time"
                  type="time"
                  value={draftToTime}
                  disabled={!toDateValue}
                  onChange={(event) => handleTimeChange('to', event.target.value)}
                  onBlur={(event) => commitTime('to', event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitTime('to', event.currentTarget.value);
                      event.currentTarget.blur();
                    }
                  }}
                  className="h-8"
                />
              </div>
            </div>
          )}

          {(dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full text-xs text-muted-foreground"
              onClick={() => {
                setTimeExpanded(false);
                setDateRange(undefined, undefined);
              }}
            >
              Clear range
            </Button>
          )}
        </div>
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
      <Popover.Content align="start" className="w-96 p-3">
        <PeopleFilterPicker />
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
      <Popover.Content align="start" className="w-96 p-3">
        <PlaceFilterPicker />
      </Popover.Content>
    </Popover>
  );
}

/**
 * The advanced search controls in plain Who / What / When / Where / How order,
 * followed by semantic, sort, save, and right-aligned tags. `modal` is forwarded
 * to the portaled Radix dropdowns so they behave inside a modal Sheet/Dialog.
 */
export function AdvancedFilters({ modal }: { modal: boolean }) {
  const [{ tags }, { setTags }] = useDropdown();

  const { data: tagData } = useQuery(EXPLORER_TAGS);
  const tagSuggestions = useMemo(() => tagData?.tags.edges.map((edge) => edge.node.label) ?? [], [tagData]);

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <WhoFilter />
        <EntityTypeFilter modal={modal} label="What" />
        <DateControl />
        <WhereFilter />
        <ConnectorFilter modal={modal} label="How" />

        <span className="mx-1 h-6 w-px self-center bg-border" />

        <ToggleChip param="semantic" label="Semantic" icon={<Sparkles className="h-4 w-4" />} />

        <span className="mx-1 h-6 w-px self-center bg-border" />

        <SortControl />
        <SaveSearchButton />
      </div>

      <div className="ml-auto w-[220px] shrink-0">
        <TagInput
          tags={tags}
          suggestions={tagSuggestions}
          inputPlaceholder="Search tags"
          singleLine
          className="h-9 px-2 py-1"
          onTagAdded={(tag) => {
            setTags([...tags, tag]);

            return true;
          }}
          onTagRemoved={(tag) => setTags(tags.filter((value) => value !== tag))}
        />
      </div>
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
  // Sharing (the "make public" control) is gated while the access model is hardened.
  const { isFeatureEnabled } = useFeatures();
  const sharingEnabled = isFeatureEnabled('shared.search');

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  // The just-created saved search, handed to the share modal on "Save & share".
  const [savedSearchToShare, setSavedSearchToShare] = useState<FragmentType<
    typeof SavedSearchGridItemFragment
  > | null>(null);

  const [createSavedSearch, { loading }] = useMutation(CREATE_SAVED_SEARCH, {
    // Drop the cached list so the Saved Searches page refetches it with the new entry.
    update(cache, { data }) {
      if (data?.createSavedSearch?.success) {
        cache.evict({ id: 'ROOT_QUERY', fieldName: 'savedSearches' });
        cache.gc();
      }
    },
  });

  const handleSave = async (share: boolean) => {
    const trimmed = name.trim();

    if (!trimmed) {
      return;
    }

    const query = searchParams.get('search')?.trim() || undefined;
    const tags = searchParams.get('tags')?.split(',').filter(Boolean) ?? [];
    const entityTypes = selectedEntityTypes.map(
      (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP],
    );
    const filters = buildSavedSearchFilters(searchParams);

    try {
      const result = await createSavedSearch({
        variables: {
          input: {
            name: trimmed,
            query,
            entityTypes,
            tags: tags.length > 0 ? tags : undefined,
            filters,
          },
        },
      });

      const created = result.data?.createSavedSearch?.savedSearch;

      if (created) {
        toast.success(`Saved search “${trimmed}”`);
        setName('');
        setOpen(false);
        // Hand the new search to the share modal so the user can grab a link
        // without a trip to the Saved Searches page.
        if (share) {
          setSavedSearchToShare(created);
        }
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
            Stores the current query, entity types, tags, and all active filters (who / where / when / how /
            sort) so you can reuse them later.
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
                handleSave(false);
              }
            }}
            placeholder="e.g. Work emails this month"
          />
        </div>

        <Dialog.Footer>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          {sharingEnabled && (
            <Button variant="secondary" onClick={() => handleSave(true)} disabled={loading || !name.trim()}>
              <Share2 className="mr-2 h-4 w-4" />
              Save &amp; share
            </Button>
          )}
          <Button onClick={() => handleSave(false)} disabled={loading || !name.trim()}>
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>

      {savedSearchToShare && (
        <ShareSavedSearchModal savedSearch={savedSearchToShare} onClose={() => setSavedSearchToShare(null)} />
      )}
    </Dialog>
  );
}

export function ResultCount() {
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
 * flips an up/down chevron; the caller surfaces the active-filter count.
 */
export function AdvancedSearchToggle({
  open,
  onToggle,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const label = open ? 'Close advanced search' : 'Open advanced search';

  return (
    <Tooltip.Provider>
      <Tooltip delayDuration={400}>
        <Tooltip.Trigger asChild>
          <Button
            type="button"
            size="icon"
            // Open state is signalled by the rotated chevron alone, and the
            // active-filter count by the caller's adjacent text — a filled
            // button here visually fuses with the clear-X beside it.
            variant="outline"
            onClick={onToggle}
            // Keep focus in the search input (the toggle sits inset in it) so the
            // suggestions panel doesn't blink out between mousedown and the toggle.
            onMouseDown={(e) => e.preventDefault()}
            aria-label={label}
            aria-expanded={open}
            title={label}
            className={cn('h-10 w-10 flex-shrink-0', open && 'rounded-b-none', className)}
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform duration-100', open && 'rotate-180')} />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content side="bottom">{label}</Tooltip.Content>
      </Tooltip>
    </Tooltip.Provider>
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

function ExplorerToolbarInner({ open, showResultCount }: { open: boolean; showResultCount: boolean }) {
  const [searchParams] = useSearchParams();
  const showSummaryRow = showResultCount || countActiveFilters(searchParams) > 0;

  return (
    <div className="flex flex-col gap-2">
      {/* The advanced-search drawer: plain Who / What / When / Where / How, then
          semantic, sort, save, and right-aligned tags. Opened from the header toggle. */}
      {open && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 shadow-sm">
          <AdvancedFilters modal={false} />
        </div>
      )}

      {showSummaryRow && (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <ActiveFilterChips />
          </div>
          {showResultCount && (
            <div className="shrink-0">
              <ResultCount />
            </div>
          )}
        </div>
      )}
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
export function ExplorerToolbar({
  open,
  showResultCount = true,
}: {
  open: boolean;
  showResultCount?: boolean;
}) {
  return (
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <ExplorerToolbarInner open={open} showResultCount={showResultCount} />
    </DropdownProvider>
  );
}

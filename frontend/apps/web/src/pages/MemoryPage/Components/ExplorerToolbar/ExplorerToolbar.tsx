import { useCallback, useEffect, useMemo, useState } from 'react';

import { useMutation } from '@apollo/client';
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
  Activity,
  ArrowUpDown,
  Calendar as CalendarIcon,
  ChevronDown,
  Clock,
  Database,
  EyeOff,
  Filter,
  Map as MapIcon,
  MapPin,
  Save,
  Scan,
  Shapes,
  Share2,
  Sparkles,
  Tag,
  Users,
  X,
} from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { ConnectorFilter } from '@/components/SearchBox/ConnectorFilter';
import { EntityTypeFilter } from '@/components/SearchBox/EntityTypeFilter';
import {
  FILTER_DRAG_TYPE,
  isFilterDrag,
  readFilterDrag,
  type FilterDragKind,
} from '@/components/SearchBox/filterDrag';
import { AVAILABLE_ENTITY_TYPES, useDropdown } from '@/components/SearchBox/useDropdown';
import { type FragmentType } from '@/graphql';

import { CREATE_SAVED_SEARCH } from '../../../SavedSearchesPage/CreateSavedSearchModal';
import type { SavedSearchGridItemFragment } from '../../../SavedSearchesPage/SavedSearch';
import { ShareSavedSearchModal } from '../../../SavedSearchesPage/ShareSavedSearchModal';
import { buildSavedSearchFilters } from '../../savedSearchFilters';

import {
  WHEN_PRESET_GRID,
  datePresetLabel,
  isRollingDatePreset,
  type DatePresetSelection,
} from './datePresets';
import {
  FILTER_PARAMS,
  addEntityFilter,
  countActiveFilters,
  filterValueKey,
  narrowedEntityTypes,
  readCsvParam,
  removeEntityFilter,
  writeCsvFilterParam,
} from './filterParams';
import { SavedSearchPicker } from './SavedSearchPicker';
import { droppedFilters, readMemoryView, unsupportedReason, type FilterDimension } from './viewFilterSupport';

// Single-select sort presets that map to the backend's sortBy + sortOrder pair.
const SORT_OPTIONS = [
  { value: 'default', label: 'Default', sortBy: '', sortOrder: '' },
  { value: 'relevance', label: 'Relevance', sortBy: 'relevance', sortOrder: 'desc' },
  { value: 'newest', label: 'Newest first', sortBy: 'time', sortOrder: 'desc' },
  { value: 'oldest', label: 'Oldest first', sortBy: 'time', sortOrder: 'asc' },
  { value: 'name-asc', label: 'Name (A–Z)', sortBy: 'name', sortOrder: 'asc' },
  { value: 'name-desc', label: 'Name (Z–A)', sortBy: 'name', sortOrder: 'desc' },
] as const;

const START_OF_DAY_TIME = '00:00';
const END_OF_DAY_TIME = '23:59';

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

/**
 * One removable filter chip inside the drop area.
 *
 * `inactiveReason` marks a filter the current view cannot apply: the chip stays
 * (it is still set, and still applies in the other views) but reads as struck
 * through and dimmed, with the reason in a tooltip. Silently dropping it would
 * make the same URL mean different things view to view with nothing on screen
 * to say so — see viewFilterSupport.
 */
function FilterChip({
  icon: Icon,
  label,
  removeLabel,
  onRemove,
  inactiveReason,
}: {
  icon: typeof Users;
  label: string;
  removeLabel: string;
  onRemove: () => void;
  inactiveReason?: string | null;
}) {
  const body = (
    <span className="flex min-w-0 items-center gap-1">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className={cn('max-w-[220px] truncate', inactiveReason && 'line-through')}>{label}</span>
      {inactiveReason && <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </span>
  );

  return (
    <Badge
      variant="secondary"
      className={cn('h-7 max-w-full shrink-0 gap-1 pl-2 pr-1', inactiveReason && 'opacity-60')}
    >
      {inactiveReason ? (
        <Tooltip delayDuration={200}>
          <Tooltip.Content className="max-w-[260px]">
            Not applied in this view. {inactiveReason}
          </Tooltip.Content>
          <Tooltip.Trigger asChild>
            <span
              tabIndex={0}
              className="flex min-w-0 items-center rounded"
              aria-label={`${label} — not applied in this view. ${inactiveReason}`}
            >
              {body}
            </span>
          </Tooltip.Trigger>
        </Tooltip>
      ) : (
        body
      )}
      <Tooltip delayDuration={600}>
        <Tooltip.Content>{removeLabel}</Tooltip.Content>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={onRemove}
            aria-label={removeLabel}
            className="-mr-1 rounded p-0.5 hover:bg-background/60"
          >
            <X className="h-3 w-3" />
          </button>
        </Tooltip.Trigger>
      </Tooltip>
    </Badge>
  );
}

// Chip icon per drag-in filter dimension; the URL param and validation live in
// filterParams.ts (shared with the header search box's arrow-key add/remove).
const DROP_FILTER_ICONS: Record<FilterDragKind, typeof Users> = {
  person: Users,
  place: MapPin,
  tag: Tag,
};

/**
 * The drag-and-drop filter area. Person, place, and tag rows in the header
 * search box's live results are draggable (see SearchBox/results/*Result);
 * dropping one here adds it to the matching filter (`people` / `places` /
 * `tags` URL param, unchanged). Selections render as removable chips inside
 * the area, joined by the What picker's type selection, the How picker's
 * source and activity selections, the When picker's date range, the Has a
 * location / Semantic toggles, and the map's "Search events in this area"
 * viewport so every applied filter reads from one place. `Clear all` in the
 * top-right corner resets the full filter set but leaves the search query
 * alone — the query lives in the header search box, whose X clears it.
 */
function isNativeFilterDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(FILTER_DRAG_TYPE) ?? false;
}

function readNativeFilterDrag(event: DragEvent): ReturnType<typeof readFilterDrag> {
  const raw = event.dataTransfer?.getData(FILTER_DRAG_TYPE);

  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      (parsed.kind === 'person' || parsed.kind === 'place' || parsed.kind === 'tag') &&
      'name' in parsed &&
      typeof parsed.name === 'string'
    ) {
      return { kind: parsed.kind, name: parsed.name };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Drag-and-drop filter target — hidden until a filter drag is in flight or
 * applied filters need chips. Document-level listeners catch drags from the
 * header search box even when this area isn't visible yet.
 */
function FilterDropArea() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selections = useMemo(
    () => ({
      person: readCsvParam(searchParams, 'people'),
      place: readCsvParam(searchParams, 'places'),
      tag: readCsvParam(searchParams, 'tags'),
    }),
    [searchParams],
  );
  // The type / source / activity selections, date range, located-only flag,
  // semantic flag, and map viewport also render here as chips — the drop area
  // is the single home for the applied filters — even though they're set via
  // the What / How / When / Has a location / Semantic controls or the map's
  // "Search events in this area" button rather than dragged in. Removing a
  // chip clears its URL params, which unselects the matching control since
  // both read the same params.
  const selectedTypes = narrowedEntityTypes(searchParams);
  const sources = readCsvParam(searchParams, 'connectors');
  const activities = readCsvParam(searchParams, 'eventTypes');
  const dateFrom = searchParams.get('from') ?? '';
  const dateTo = searchParams.get('to') ?? '';
  const whenPreset = searchParams.get('when');
  const hasDateRange = Boolean(dateFrom || dateTo || isRollingDatePreset(whenPreset));
  const hasLocation = searchParams.get('hasLocation') === '1';
  const semantic = searchParams.get('semantic') === '1';
  const hasMapArea = Boolean(searchParams.get('bbox'));
  // Which view the chips are being read against: a filter this view cannot
  // apply is shown struck through rather than quietly ignored.
  const view = readMemoryView(searchParams.get('view'));
  const reasonFor = (dimension: FilterDimension) => unsupportedReason(view, dimension);
  const hasSelections =
    selectedTypes !== null ||
    sources.length > 0 ||
    activities.length > 0 ||
    hasDateRange ||
    hasLocation ||
    semantic ||
    hasMapArea ||
    Object.values(selections).some((values) => values.length > 0);
  const [error, setError] = useState<string | null>(null);
  // Counts nested dragenter/dragleave pairs so the highlight doesn't flicker
  // off while an entity is dragged across the chips inside the drop area.
  const [dragDepth, setDragDepth] = useState(0);
  const isDropTarget = dragDepth > 0;

  const clearAll = () => {
    setSearchParams((params) => {
      for (const param of FILTER_PARAMS) {
        params.delete(param);
      }

      return params;
    });
    setError(null);
  };

  const remove = (kind: FilterDragKind, name: string) => {
    setSearchParams((params) => {
      removeEntityFilter(params, kind, name);

      return params;
    });
    setError(null);
  };

  // Removal for the How picker's CSV params (`connectors` / `eventTypes`),
  // which aren't drag-in kinds but chip here all the same.
  const removeCsvValue = (param: string, name: string) => {
    const key = filterValueKey(name);

    setSearchParams((params) => {
      writeCsvFilterParam(
        params,
        param,
        readCsvParam(params, param).filter((value) => filterValueKey(value) !== key),
      );

      return params;
    });
  };

  const add = useCallback(
    (kind: FilterDragKind, rawName: string) => {
      const next = new URLSearchParams(searchParams);
      const validation = addEntityFilter(next, kind, rawName);

      setError(validation);

      if (validation === null) {
        setSearchParams(next);
      }
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      if (isNativeFilterDrag(event)) {
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      }
    };

    const handleDragLeave = (event: DragEvent) => {
      if (isNativeFilterDrag(event)) {
        setDragDepth((depth) => Math.max(0, depth - 1));
      }
    };

    const handleDragOver = (event: DragEvent) => {
      if (isNativeFilterDrag(event)) {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!isNativeFilterDrag(event)) {
        return;
      }

      event.preventDefault();
      setDragDepth(0);

      const payload = readNativeFilterDrag(event);

      if (payload) {
        add(payload.kind, payload.name);
      }
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, [add]);

  if (!hasSelections && !isDropTarget) {
    return null;
  }

  const DropIcon = isDropTarget ? Scan : Filter;
  const dropText = isDropTarget
    ? 'Drop to add'
    : 'Drag a person, place, or tag from the search results here to filter';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <div
          aria-label="Filter drop area"
          onDragEnter={(event) => {
            if (isFilterDrag(event)) {
              event.preventDefault();
              setDragDepth((depth) => depth + 1);
            }
          }}
          onDragOver={(event) => {
            if (isFilterDrag(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDragLeave={(event) => {
            if (isFilterDrag(event)) {
              setDragDepth((depth) => Math.max(0, depth - 1));
            }
          }}
          onDrop={(event) => {
            if (!isFilterDrag(event)) {
              return;
            }

            event.preventDefault();
            setDragDepth(0);

            const payload = readFilterDrag(event);

            if (payload) {
              add(payload.kind, payload.name);
            }
          }}
          className={cn(
            'relative flex h-9 min-h-9 min-w-0 flex-1 select-none items-center gap-1.5 overflow-hidden transition-colors',
            isDropTarget && 'rounded-md bg-accent/40',
          )}
        >
          {hasSelections ? (
            <>
              <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain">
                {selectedTypes !== null && (
                  <FilterChip
                    icon={Shapes}
                    label={
                      selectedTypes.length === 1
                        ? selectedTypes[0]
                        : `${selectedTypes.length} of ${AVAILABLE_ENTITY_TYPES.length} types`
                    }
                    removeLabel="Remove entity types"
                    inactiveReason={reasonFor('entityTypes')}
                    onRemove={() =>
                      setSearchParams((params) => {
                        params.delete('includedEntityTypes');
                        params.delete('excludedEntityTypes');

                        return params;
                      })
                    }
                  />
                )}
                {(Object.keys(DROP_FILTER_ICONS) as FilterDragKind[]).flatMap((kind) =>
                  selections[kind].map((name) => (
                    <FilterChip
                      key={`${kind}:${name}`}
                      icon={DROP_FILTER_ICONS[kind]}
                      label={kind === 'tag' ? `#${name}` : name}
                      removeLabel={`Remove ${name}`}
                      inactiveReason={reasonFor(
                        kind === 'person' ? 'people' : kind === 'place' ? 'places' : 'tags',
                      )}
                      onRemove={() => remove(kind, name)}
                    />
                  )),
                )}
                {sources.map((name) => (
                  <FilterChip
                    key={`source:${name}`}
                    icon={Database}
                    label={name}
                    removeLabel={`Remove source ${name}`}
                    inactiveReason={reasonFor('connectors')}
                    onRemove={() => removeCsvValue('connectors', name)}
                  />
                ))}
                {activities.map((name) => (
                  <FilterChip
                    key={`activity:${name}`}
                    icon={Activity}
                    label={name}
                    removeLabel={`Remove activity ${name}`}
                    inactiveReason={reasonFor('eventTypes')}
                    onRemove={() => removeCsvValue('eventTypes', name)}
                  />
                ))}
                {hasDateRange && (
                  <FilterChip
                    icon={CalendarIcon}
                    label={
                      isRollingDatePreset(whenPreset)
                        ? (datePresetLabel(whenPreset) ?? 'When')
                        : formatDateLabel(dateFrom, dateTo)
                    }
                    removeLabel="Remove date range"
                    inactiveReason={reasonFor('date')}
                    onRemove={() =>
                      setSearchParams((params) => {
                        params.delete('from');
                        params.delete('to');
                        params.delete('when');

                        return params;
                      })
                    }
                  />
                )}
                {hasLocation && (
                  <FilterChip
                    icon={MapPin}
                    label="Has a location"
                    removeLabel="Remove has a location"
                    inactiveReason={reasonFor('hasLocation')}
                    onRemove={() =>
                      setSearchParams((params) => {
                        params.delete('hasLocation');

                        return params;
                      })
                    }
                  />
                )}
                {semantic && (
                  <FilterChip
                    icon={Sparkles}
                    label="Semantic"
                    removeLabel="Remove semantic"
                    inactiveReason={reasonFor('semantic')}
                    onRemove={() =>
                      setSearchParams((params) => {
                        params.delete('semantic');

                        return params;
                      })
                    }
                  />
                )}
                {hasMapArea && (
                  <FilterChip
                    icon={MapIcon}
                    label="Map area"
                    removeLabel="Remove map area"
                    inactiveReason={reasonFor('bbox')}
                    onRemove={() =>
                      setSearchParams((params) => {
                        params.delete('bbox');

                        return params;
                      })
                    }
                  />
                )}
              </div>
              <Button
                // Explicit: the drop area can render inside the header SearchBox's
                // <form>, where a default (submit) button would commit the search
                // right after clearing.
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                onClick={clearAll}
              >
                Clear all
              </Button>
            </>
          ) : (
            // pointer-events-none keeps the icon swap from firing its own
            // dragenter/dragleave and corrupting the depth counter mid-drag.
            <div className="pointer-events-none flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate px-1 text-xs text-muted-foreground">
              <DropIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{dropText}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <FilterCountLabel />
          <SavedSearchPicker />
          <SaveSearchButton />
        </div>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A boolean URL flag rendered as a toggle button (used for located-only /
 * semantic). `dimension` lets the control say when the current view cannot
 * apply the flag: it stays clickable — the flag is a property of the query, not
 * of the view, and it still applies everywhere else — but reads as struck
 * through with the reason in a tooltip.
 */
function ToggleChip({
  param,
  label,
  icon,
  dimension,
}: {
  param: string;
  label: string;
  icon: React.ReactNode;
  dimension: FilterDimension;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = searchParams.get(param) === '1';
  const reason = unsupportedReason(readMemoryView(searchParams.get('view')), dimension);

  const button = (
    <Button
      type="button"
      variant={active ? 'secondary' : 'outline'}
      className={cn(reason && 'opacity-70')}
      aria-label={reason ? `${label} — not applied in this view. ${reason}` : undefined}
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
      <span className={cn('ml-1', reason && 'line-through')}>{label}</span>
      {reason && <EyeOff className="ml-1 h-3.5 w-3.5 text-muted-foreground" />}
    </Button>
  );

  if (!reason) {
    return button;
  }

  return (
    <Tooltip delayDuration={200}>
      <Tooltip.Content className="max-w-[260px]">Not applied in this view. {reason}</Tooltip.Content>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
    </Tooltip>
  );
}

/** Date-range picker bound to the `when` / `from` / `to` URL params. */
function DateControl() {
  const [{ dateFrom, dateTo, whenPreset }, { setDateRange, setDatePreset }] = useDropdown();
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(
    () => whenPreset === 'custom' || (!isRollingDatePreset(whenPreset) && Boolean(dateFrom || dateTo)),
  );
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

  const activePreset: DatePresetSelection | null = isRollingDatePreset(whenPreset)
    ? whenPreset
    : dateFrom || dateTo
      ? 'custom'
      : null;

  const triggerLabel = isRollingDatePreset(whenPreset)
    ? datePresetLabel(whenPreset)
    : dateFrom || dateTo
      ? formatDateLabel(dateFrom, dateTo)
      : 'When';

  const showCustomPicker = customMode || activePreset === 'custom';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);

        if (next) {
          setCustomMode(
            whenPreset === 'custom' || (!isRollingDatePreset(whenPreset) && Boolean(dateFrom || dateTo)),
          );
        }
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="outline" className="group">
          <CalendarIcon className="mr-2 h-4 w-4 text-muted-foreground" />
          {triggerLabel}
          <ChevronDown className="ml-2 h-4 w-4 opacity-50 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </Popover.Trigger>
      <Popover.Content className="w-64 p-0" align="start">
        <div className="grid grid-cols-2 gap-2 p-2">
          {WHEN_PRESET_GRID.map(({ value, label }) => {
            const selected = activePreset === value;

            return (
              <Button
                key={value}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={selected}
                className={cn(
                  'h-10 justify-center rounded-md border bg-background px-2 text-sm font-medium shadow-sm transition-[box-shadow,border-color,background-color]',
                  selected
                    ? 'border-green-500 bg-green-50/90 shadow-md ring-1 ring-green-500/25 dark:bg-green-950/40'
                    : 'border-green-500/35 hover:border-green-500/70 hover:bg-green-50/40 hover:shadow-md dark:hover:bg-green-950/20',
                )}
                onClick={() => {
                  if (value === 'custom') {
                    setDatePreset('custom');
                    setCustomMode(true);
                  } else {
                    setDatePreset(value);
                    setCustomMode(false);
                    setOpen(false);
                  }
                }}
              >
                {label}
              </Button>
            );
          })}
        </div>

        {showCustomPicker && (
          <>
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
                  onClick={() => setTimeExpanded((expanded) => !expanded)}
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
                    setDatePreset(null);
                    setCustomMode(false);
                  }}
                >
                  Clear range
                </Button>
              )}
            </div>
          </>
        )}
      </Popover.Content>
    </Popover>
  );
}

/**
 * Sort preset selector bound to the `sortBy`/`sortOrder` URL params. The graph
 * has no result order to sort, so there the control says so instead of
 * accepting a choice that quietly does nothing.
 */
function SortControl() {
  const [{ sortBy, sortOrder }, { setSort }] = useDropdown();
  const [searchParams] = useSearchParams();
  const reason = unsupportedReason(readMemoryView(searchParams.get('view')), 'sort');

  const currentSort =
    SORT_OPTIONS.find((option) => option.sortBy === sortBy && option.sortOrder === sortOrder)?.value ??
    'default';

  const select = (
    <Select
      value={currentSort}
      onValueChange={(value) => {
        const option = SORT_OPTIONS.find((item) => item.value === value);

        setSort(option?.sortBy || undefined, option?.sortOrder || undefined);
      }}
    >
      <Select.Trigger className={cn('w-[150px]', reason && 'opacity-70')}>
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

  if (!reason) {
    return select;
  }

  // The marker sits beside the control rather than inside its trigger: the sort
  // choice is still a property of the query — it applies the moment you switch
  // back to a list-shaped view — so the control stays live and the marker
  // carries the explanation.
  return (
    <span className="inline-flex items-center gap-1">
      {select}
      <Tooltip delayDuration={200}>
        <Tooltip.Content className="max-w-[260px]">Not applied in this view. {reason}</Tooltip.Content>
        <Tooltip.Trigger asChild>
          <span
            role="note"
            tabIndex={0}
            aria-label={`Sort — not applied in this view. ${reason}`}
            className="rounded text-muted-foreground"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </span>
        </Tooltip.Trigger>
      </Tooltip>
    </span>
  );
}

/** When / How / toggles / sort — shared by the inline explorer toolbar and header panel. */
function FilterControlsRow({
  modal,
  includeEntityTypeFilter = false,
  showSave = true,
}: {
  modal: boolean;
  /** Off on `/memory` — entity types live in MemoryEntityTypeNav instead. */
  includeEntityTypeFilter?: boolean;
  /** Save sits with the filter chip row on `/memory`; stays here in the header panel. */
  showSave?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {includeEntityTypeFilter && <EntityTypeFilter modal={modal} label="What" />}
      <DateControl />

      <ConnectorFilter modal={modal} label="How" />

      <ToggleChip
        param="hasLocation"
        label="Has a location"
        icon={<MapPin className="h-4 w-4" />}
        dimension="hasLocation"
      />
      <ToggleChip
        param="semantic"
        label="Semantic"
        icon={<Sparkles className="h-4 w-4" />}
        dimension="semantic"
      />

      <SortControl />

      {showSave && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <FilterCountLabel />
          <SavedSearchPicker />
          <SaveSearchButton />
        </div>
      )}
    </div>
  );
}

/**
 * Advanced filters for the header search dropdown on non-`/memory` pages. Includes
 * the What picker here; the main Memory explorer uses MemoryEntityTypeNav instead.
 */
export function SearchPanelFilters({ modal }: { modal: boolean }) {
  return (
    <div className="p-3">
      <FilterControlsRow modal={modal} includeEntityTypeFilter />
    </div>
  );
}

/**
 * When / How / toggles / sort for the Memory explorer — rendered inline after
 * the What categories in MemoryEntityTypeNav.
 */
export function MemoryExplorerFilterControls() {
  return <FilterControlsRow modal={false} showSave={false} />;
}

/**
 * Inline explorer filters: applied-filter chip drop area with Save on the same
 * row. When / How / toggles / sort live in MemoryEntityTypeNav beside What.
 */
export function AdvancedFilters() {
  return <FilterDropArea />;
}

/**
 * "Save" — captures a name and persists the current query + selected
 * entity types + tags as a SavedSearch (shown on the Saved Searches page).
 */
function FilterCountLabel() {
  const [searchParams] = useSearchParams();
  const activeFilterCount = countActiveFilters(searchParams);
  const view = readMemoryView(searchParams.get('view'));
  // Filters that are set but which the current view can't apply. They still
  // count as active — they're in the URL and they bite in the other views — so
  // the label reports them alongside the total rather than deducting them.
  // Sort isn't part of `countActiveFilters` (it reorders rather than narrows),
  // so a graph with only a sort set still has something to report here.
  const dropped = droppedFilters(view, searchParams);

  if (activeFilterCount === 0 && dropped.length === 0) {
    return null;
  }

  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground">
      {activeFilterCount > 0 && `${activeFilterCount} ${activeFilterCount === 1 ? 'filter' : 'filters'}`}
      {dropped.length > 0 && (
        <Tooltip delayDuration={200}>
          <Tooltip.Content className="max-w-[260px]">
            {dropped.map((dimension) => unsupportedReason(view, dimension)).join(' ')}
          </Tooltip.Content>
          <Tooltip.Trigger asChild>
            <span
              tabIndex={0}
              className={cn(
                'rounded underline decoration-dotted underline-offset-2',
                activeFilterCount > 0 && 'ml-1',
              )}
            >
              {activeFilterCount > 0 ? '· ' : ''}
              {dropped.length} not applied here
            </span>
          </Tooltip.Trigger>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * "Save" — captures a name and persists the current query + selected
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
        <Button>
          <Save className="mr-2 h-4 w-4" />
          Save
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
 * The explorer toolbar body that sits under the unified header search:
 * the advanced-search drawer — the drag-and-drop filter area, then What /
 * When / How + located-only, semantic, sort, and save. `open` is controlled
 * by the page. Wrapped in DropdownProvider so the useDropdown URL-param
 * setters work.
 */
export function ExplorerToolbar({ open }: { open: boolean }) {
  if (!open) {
    return null;
  }

  return <AdvancedFilters />;
}

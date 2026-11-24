import { useState, type ReactNode } from 'react';

import { Input, Label, Select, Switch } from '@ci/shadcn';
import { Activity, Database, MapPin, Users } from '@ci/shadcn/icons';

import { DirectionToggle, readMessageDirection } from '@/components/SearchBox/DirectionToggle';
import { FilterValuePicker } from '@/components/SearchBox/FilterValuePicker';
import { MapAreaList } from '@/components/SearchBox/MapAreaList';
import { noNameSuggestions, type NameSuggestionHook } from '@/components/SearchBox/useNameSuggestions';
import { filterValueLabel, sourceFilterLabel } from '@/lib/sourceNames';
import { mapAreasLabel } from '@/pages/MemoryPage/bbox';
import { datePresetLabel } from '@/pages/MemoryPage/Components/ExplorerToolbar/datePresets';

import {
  addListValue,
  applySortPreset,
  clearWhere,
  editableAreas,
  removeArea,
  removeListValue,
  SAVED_SEARCH_SORT_PRESETS,
  sortPresetOf,
  type EditableFilters,
  type ListField,
} from './savedSearchFiltersEdit';

/**
 * What the editor may offer for each list dimension, matching what the memory
 * toolbar offers. Everything is optional so the editor stays presentational:
 * without a vocabulary it accepts free text everywhere (stories, tests).
 * The suggestion hooks are called as hooks, so they must be stable functions.
 */
export interface SavedSearchVocabulary {
  /** Every source system the search can match; when known, How refuses other text and flags stale values. */
  sources?: string[];
  /** Every event type the search can match; likewise for Activity. */
  eventTypes?: string[];
  usePersonSuggestions?: NameSuggestionHook;
  usePlaceSuggestions?: NameSuggestionHook;
}

interface Props {
  value: EditableFilters;
  onChange: (next: EditableFilters) => void;
  vocabulary?: SavedSearchVocabulary;
}

interface ListFieldHandlers {
  values: string[];
  onAdd: (value: string) => string | null;
  onRemove: (value: string) => void;
  onClear: () => void;
}

/** Who / Where: name patterns, with live suggestions when the host provides them. */
function NamePatternField({
  label,
  icon,
  useSuggestions,
  searchPlaceholder,
  emptyText,
  footer,
  extraSummary,
  field,
}: {
  label: string;
  icon: typeof Users;
  useSuggestions: NameSuggestionHook;
  searchPlaceholder: string;
  emptyText: string;
  footer?: ReactNode;
  extraSummary?: string;
  field: ListFieldHandlers;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { names, loading, hasMore, loadingMore, loadMore } = useSuggestions(query, open);

  return (
    <FilterValuePicker
      variant="field"
      label={label}
      extraSummary={extraSummary}
      icon={icon}
      options={names}
      loading={loading}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={loadMore}
      onSearch={setQuery}
      onOpenChange={setOpen}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      footer={footer}
      hint="Matches any name containing the text, like the memory page's drag-in filters."
      {...field}
    />
  );
}

/** How / Activity: exact values from the search's own vocabulary, once it is known. */
function ExactValueField({
  label,
  icon,
  options,
  searchPlaceholder,
  emptyText,
  unknownValueHint,
  formatValue,
  field,
}: {
  label: string;
  icon: typeof Users;
  options?: string[];
  /** How a value is shown; the stored filter keeps the value itself. */
  formatValue: (value: string) => string;
  searchPlaceholder: string;
  emptyText: string;
  unknownValueHint: string;
  field: ListFieldHandlers;
}) {
  return (
    <FilterValuePicker
      variant="field"
      label={label}
      icon={icon}
      options={options ?? []}
      optionsKnown={options != null}
      formatValue={formatValue}
      searchPlaceholder={searchPlaceholder}
      emptyText={options == null ? 'Type a value and press Enter' : emptyText}
      unknownValueHint={unknownValueHint}
      {...field}
    />
  );
}

/**
 * ISO timestamp -> the yyyy-mm-dd a <input type="date"> expects (local date).
 *
 * Local, because `setDate` builds the stored instant from the picked day in local
 * time (`T23:59:59.999` for To). Reading it back as the UTC date showed the NEXT day
 * for an evening end time west of Greenwich (a Pacific To of Sep 30 came back as
 * Oct 1), and the PREVIOUS day for a start of day east of it.
 */
function toDateInput(iso?: string | null): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const pad = (n: number) => String(n).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Edit the secondary explorer dimensions a saved search carries (who / where /
 * when / how / sort / semantic). Presentational: it owns no data, just edits the
 * passed `value` and reports changes — so it stories and unit-tests cleanly.
 */
export function SavedSearchFiltersEditor({ value, onChange, vocabulary = {} }: Props) {
  const areas = editableAreas(value);

  const listField = (field: ListField): ListFieldHandlers => ({
    values: value[field] ?? [],
    onAdd: (raw: string) => {
      const trimmed = raw.trim();

      if (!trimmed) {
        return 'Enter a value first.';
      }

      // How / sources travel in the explorer URL as CSV, so a comma would
      // split them; Who / Where are free text (a place is often a street
      // address) and travel one value per param, so a comma is ordinary.
      if (trimmed.includes(',') && (field === 'eventTypes' || field === 'connectors')) {
        return 'Values cannot include commas.';
      }

      onChange(addListValue(value, field, trimmed));

      return null;
    },
    onRemove: (item: string) => onChange(removeListValue(value, field, item)),
    onClear: () => onChange({ ...value, [field]: [] }),
  });

  // A rolling When ("Last month") is stored as `datePreset` and wins over any
  // dates when the search is opened, so a date set here has to replace it, or
  // the dates were saved and then ignored.
  const setDate = (field: 'startTime' | 'endTime', dateStr: string) => {
    if (!dateStr) {
      onChange({ ...value, [field]: undefined, datePreset: undefined });

      return;
    }

    const time = field === 'endTime' ? 'T23:59:59.999' : 'T00:00:00';
    const date = new Date(`${dateStr}${time}`);

    // A date input accepts years up to 275760, but a five- or six-digit year
    // is not an ISO date `Date` can read, and toISOString() would throw.
    if (Number.isNaN(date.getTime())) {
      return;
    }

    onChange({ ...value, [field]: date.toISOString(), datePreset: undefined });
  };

  // Null for anything but a rolling preset (no value, 'custom', unknown).
  const rollingWhen = datePresetLabel(value.datePreset);

  return (
    <div className="space-y-4">
      <NamePatternField
        label="Who"
        icon={Users}
        useSuggestions={vocabulary.usePersonSuggestions ?? noNameSuggestions}
        searchPlaceholder="Search people…"
        emptyText="No people match"
        footer={
          <DirectionToggle
            value={readMessageDirection(value.direction)}
            onChange={(next) => onChange({ ...value, direction: next ?? undefined })}
          />
        }
        field={listField('people')}
      />
      <NamePatternField
        label="Where"
        icon={MapPin}
        useSuggestions={vocabulary.usePlaceSuggestions ?? noNameSuggestions}
        searchPlaceholder="Search places…"
        emptyText="No places match"
        // The rectangles the search was drawn with, ORed with the names. New
        // ones can only be drawn on the map; here each can be read and
        // removed, so an edit never strips them by accident. Clear takes both.
        extraSummary={areas.length > 0 ? mapAreasLabel(areas.length) : undefined}
        footer={
          areas.length > 0 ? (
            <MapAreaList areas={areas} onRemove={(index) => onChange(removeArea(value, index))} />
          ) : undefined
        }
        field={{ ...listField('places'), onClear: () => onChange(clearWhere(value)) }}
      />
      <ExactValueField
        label="How"
        icon={Database}
        options={vocabulary.sources}
        searchPlaceholder="Search sources…"
        emptyText="No sources match"
        unknownValueHint="No connected source has this name, so this filter matches nothing."
        formatValue={sourceFilterLabel}
        field={listField('connectors')}
      />
      <ExactValueField
        label="Activity"
        icon={Activity}
        options={vocabulary.eventTypes}
        searchPlaceholder="Search activities…"
        emptyText="No activities match"
        unknownValueHint="No event has this activity type, so this filter matches nothing."
        formatValue={filterValueLabel}
        field={listField('eventTypes')}
      />

      {/* One date per row, each sized to its content: side by side, the
          modal's width on a phone left each field too narrow for its calendar
          button, which was cropped away; stretched to the full row, the
          button sat at the far right with a blank stretch before it. */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="filters-from">From</Label>
          <Input
            id="filters-from"
            className="w-auto"
            type="date"
            value={toDateInput(value.startTime)}
            onChange={(event) => setDate('startTime', event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filters-to">To</Label>
          <Input
            id="filters-to"
            className="w-auto"
            type="date"
            value={toDateInput(value.endTime)}
            onChange={(event) => setDate('endTime', event.target.value)}
          />
        </div>
        {rollingWhen && (
          <p className="text-xs text-muted-foreground" data-testid="filters-rolling-when">
            When: {rollingWhen}, counted from the day the search is opened. Picking a From or To date replaces
            it.{' '}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              aria-label={`Remove ${rollingWhen}`}
              onClick={() => onChange({ ...value, datePreset: undefined })}
            >
              Remove
            </button>
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>Sort</Label>
        <Select
          value={sortPresetOf(value)}
          onValueChange={(preset) => onChange(applySortPreset(value, preset as never))}
        >
          <Select.Trigger className="w-full">
            <Select.Value placeholder="Sort" />
          </Select.Trigger>
          <Select.Content>
            {SAVED_SEARCH_SORT_PRESETS.map((preset) => (
              <Select.Item key={preset.value} value={preset.value}>
                {preset.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="filters-located">Located only</Label>
        <Switch
          id="filters-located"
          checked={Boolean(value.hasLocation)}
          onCheckedChange={(checked) => onChange({ ...value, hasLocation: checked ? true : undefined })}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="filters-semantic">Semantic search</Label>
        <Switch
          id="filters-semantic"
          checked={Boolean(value.semantic)}
          onCheckedChange={(checked) => onChange({ ...value, semantic: checked ? true : undefined })}
        />
      </div>
    </div>
  );
}

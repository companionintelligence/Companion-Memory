import { useState, type ReactNode } from 'react';

import { Input, Label, Select, Switch } from '@ci/shadcn';
import { Activity, Database, MapPin, Users } from '@ci/shadcn/icons';

import { DirectionToggle, readMessageDirection } from '@/components/SearchBox/DirectionToggle';
import { FilterValuePicker } from '@/components/SearchBox/FilterValuePicker';
import { noNameSuggestions, type NameSuggestionHook } from '@/components/SearchBox/useNameSuggestions';

import {
  addListValue,
  applySortPreset,
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
  field,
}: {
  label: string;
  icon: typeof Users;
  useSuggestions: NameSuggestionHook;
  searchPlaceholder: string;
  emptyText: string;
  footer?: ReactNode;
  field: ListFieldHandlers;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { names, loading } = useSuggestions(query, open);

  return (
    <FilterValuePicker
      variant="field"
      label={label}
      icon={icon}
      options={names}
      loading={loading}
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
  field,
}: {
  label: string;
  icon: typeof Users;
  options?: string[];
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
      searchPlaceholder={searchPlaceholder}
      emptyText={options == null ? 'Type a value and press Enter' : emptyText}
      unknownValueHint={unknownValueHint}
      {...field}
    />
  );
}

/** ISO timestamp -> the yyyy-mm-dd a <input type="date"> expects (local date). */
function toDateInput(iso?: string | null): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/**
 * Edit the secondary explorer dimensions a saved search carries (who / where /
 * when / how / sort / semantic). Presentational: it owns no data, just edits the
 * passed `value` and reports changes — so it stories and unit-tests cleanly.
 */
export function SavedSearchFiltersEditor({ value, onChange, vocabulary = {} }: Props) {
  const listField = (field: ListField): ListFieldHandlers => ({
    values: value[field] ?? [],
    onAdd: (raw: string) => {
      const trimmed = raw.trim();

      if (!trimmed) {
        return 'Enter a value first.';
      }

      if (trimmed.includes(',')) {
        return 'Values cannot include commas.';
      }

      onChange(addListValue(value, field, trimmed));

      return null;
    },
    onRemove: (item: string) => onChange(removeListValue(value, field, item)),
    onClear: () => onChange({ ...value, [field]: [] }),
  });

  const setDate = (field: 'startTime' | 'endTime', dateStr: string) => {
    if (!dateStr) {
      onChange({ ...value, [field]: undefined });

      return;
    }

    const time = field === 'endTime' ? 'T23:59:59.999' : 'T00:00:00';

    onChange({ ...value, [field]: new Date(`${dateStr}${time}`).toISOString() });
  };

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
        field={listField('places')}
      />
      <ExactValueField
        label="How"
        icon={Database}
        options={vocabulary.sources}
        searchPlaceholder="Search sources…"
        emptyText="No sources match"
        unknownValueHint="No connected source has this name, so this filter matches nothing."
        field={listField('connectors')}
      />
      <ExactValueField
        label="Activity"
        icon={Activity}
        options={vocabulary.eventTypes}
        searchPlaceholder="Search activities…"
        emptyText="No activities match"
        unknownValueHint="No event has this activity type, so this filter matches nothing."
        field={listField('eventTypes')}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="filters-from">From</Label>
          <Input
            id="filters-from"
            type="date"
            value={toDateInput(value.startTime)}
            onChange={(event) => setDate('startTime', event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filters-to">To</Label>
          <Input
            id="filters-to"
            type="date"
            value={toDateInput(value.endTime)}
            onChange={(event) => setDate('endTime', event.target.value)}
          />
        </div>
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

      <div className="flex items-center justify-between">
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

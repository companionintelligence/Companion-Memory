import { useState } from 'react';

import { Badge, Button, Input, Label, Select, Switch } from '@ci/shadcn';
import { Plus, X } from '@ci/shadcn/icons';

import {
  addListValue,
  applySortPreset,
  removeListValue,
  SAVED_SEARCH_SORT_PRESETS,
  sortPresetOf,
  type EditableFilters,
  type ListField,
} from './savedSearchFiltersEdit';

interface Props {
  value: EditableFilters;
  onChange: (next: EditableFilters) => void;
}

/** ISO timestamp -> the yyyy-mm-dd a <input type="date"> expects (local date). */
function toDateInput(iso?: string | null): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** A removable-chip list with a free-text add — used for who/where/how/source. */
function ChipListField({
  label,
  items,
  placeholder,
  onAdd,
  onRemove,
}: {
  label: string;
  items: string[];
  placeholder: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    onAdd(draft);
    setDraft('');
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Badge key={item} variant="secondary" className="max-w-[220px] gap-1">
              <span className="truncate">{item}</span>
              <button
                type="button"
                onClick={() => onRemove(item)}
                aria-label={`Remove ${item}`}
                className="hover:bg-background/60 -mr-1 rounded p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
        <Button type="button" variant="outline" size="icon" aria-label={`Add ${label}`} onClick={commit}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Edit the secondary explorer dimensions a saved search carries (who / where /
 * when / how / sort / semantic). Presentational: it owns no data, just edits the
 * passed `value` and reports changes — so it stories and unit-tests cleanly.
 */
export function SavedSearchFiltersEditor({ value, onChange }: Props) {
  const listField = (field: ListField) => ({
    items: value[field] ?? [],
    onAdd: (raw: string) => onChange(addListValue(value, field, raw)),
    onRemove: (item: string) => onChange(removeListValue(value, field, item)),
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
      <ChipListField label="Who (people)" placeholder="Add a person name…" {...listField('people')} />
      <ChipListField label="Where (places)" placeholder="Add a place name…" {...listField('places')} />
      <ChipListField
        label="How (event types)"
        placeholder="e.g. visited, messaged…"
        {...listField('eventTypes')}
      />
      <ChipListField
        label="Source (connectors)"
        placeholder="e.g. gmail, imessage…"
        {...listField('connectors')}
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

import { Button, Calendar, Popover, Select } from '@ci/shadcn';
import { Calendar as CalendarIcon, Save } from '@ci/shadcn/icons';

import { useDropdown } from '@/components/SearchBox/useDropdown';
import { TagInput } from '@/components/TagInput';

import { EntityTypeFilter } from './EntityTypeFilter';
import { HowFilter } from './HowFilter';

interface Props {
  saveSupported?: boolean;
  onSave?: (entityTypes: string[]) => Promise<void>;
}

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

export function DropdownContent({ onSave, saveSupported = true }: Props) {
  const [
    { selectedEntityTypes, tags, dateFrom, dateTo, sortBy, sortOrder },
    { setTags, setDateRange, setSort },
  ] = useDropdown();

  const selectedRange =
    dateFrom || dateTo
      ? { from: dateFrom ? new Date(dateFrom) : undefined, to: dateTo ? new Date(dateTo) : undefined }
      : undefined;

  const currentSort =
    SORT_OPTIONS.find((option) => option.sortBy === sortBy && option.sortOrder === sortOrder)?.value ??
    'default';

  const handleSortChange = (value: string) => {
    const option = SORT_OPTIONS.find((item) => item.value === value);

    setSort(option?.sortBy || undefined, option?.sortOrder || undefined);
  };

  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-bold uppercase">Filters</h3>

        <div className="flex flex-wrap items-center gap-2">
          <EntityTypeFilter modal={false} />
          <HowFilter modal={false} />

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
                    // Make the end inclusive of the whole selected day.
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

          <Select value={currentSort} onValueChange={handleSortChange}>
            <Select.Trigger className="w-[160px]">
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
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Tags</p>
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

      {saveSupported && (
        <Button
          className="bg-green-600 hover:bg-green-700 text-white"
          onClick={() => onSave?.(selectedEntityTypes)}
        >
          <Save className="mr-2 h-4 w-4" />
          Save Search
        </Button>
      )}
    </div>
  );
}

import { Button } from '@ci/shadcn';
import { Save } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { useDropdown } from '@/components/SearchBox/useDropdown';

import { DateRangeFilter } from './DateRangeFilter';
import { EntityTypeFilter } from './EntityTypeFilter';
import { SortFilter } from './SortFilter';
import { TagFilter } from './TagFilter';

interface Props {
  saveSupported?: boolean;
  onSave?: (entityTypes: string[]) => Promise<void>;
}

// Every filter/sort dimension the explorer understands, surfaced in one panel so
// you can search who (People), what (types/tags/text), where (Places), and when
// (date) and order the results.
const FILTER_PARAMS = [
  'includedEntityTypes',
  'excludedEntityTypes',
  'tags',
  'from',
  'to',
  'sortBy',
  'sortOrder',
];

export function DropdownContent({ onSave, saveSupported = true }: Props) {
  const [{ selectedEntityTypes }] = useDropdown();
  const [searchParams, setSearchParams] = useSearchParams();

  const hasFilters = FILTER_PARAMS.some((param) => searchParams.has(param)) || searchParams.has('search');

  const clearAll = () => {
    const params = new URLSearchParams(searchParams);
    [...FILTER_PARAMS, 'search'].forEach((param) => params.delete(param));
    setSearchParams(params);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Filter &amp; sort</h3>
        <div className="flex items-center gap-2">
          {hasFilters && (
            <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
              Clear all
            </Button>
          )}
          {saveSupported && (
            <Button
              type="button"
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={() => onSave?.(selectedEntityTypes)}
            >
              <Save className="mr-2 h-4 w-4" />
              Save Search
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          {/* "Who / what / where" — People and Places are entity types. */}
          <span className="text-xs font-medium text-muted-foreground">Type</span>
          <EntityTypeFilter modal={false} />
        </div>
        <TagFilter />
        <SortFilter />
      </div>

      <DateRangeFilter />
    </div>
  );
}

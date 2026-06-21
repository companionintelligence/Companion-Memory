import { Button } from '@ci/shadcn';
import { Save } from '@ci/shadcn/icons';

import { useDropdown } from '@/components/SearchBox/useDropdown';

import { EntityTypeFilter } from './EntityTypeFilter';
import { HowFilter } from './HowFilter';

interface Props {
  saveSupported?: boolean;
  onSave?: (entityTypes: string[]) => Promise<void>;
}

export function DropdownContent({ onSave, saveSupported = true }: Props) {
  const [{ selectedEntityTypes }] = useDropdown();

  return (
    <div className="flex items-center justify-between mb-2">
      <div className="p-4">
        <h3 className="text-xs font-bold uppercase">Filters</h3>

        <div className="flex flex-wrap items-center gap-2">
          <EntityTypeFilter modal={false} />
          <HowFilter modal={false} />
        </div>
      </div>
      {saveSupported && (
        <Button
          className="bg-green-600 hover:bg-green-700 text-white mr-2"
          onClick={() => onSave?.(selectedEntityTypes)}
        >
          <Save className="mr-2 h-4 w-4" />
          Save Search
        </Button>
      )}
    </div>
  );
}

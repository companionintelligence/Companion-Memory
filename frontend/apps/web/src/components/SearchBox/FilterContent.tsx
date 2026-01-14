import { EntityTypeFilter } from './EntityTypeFilter';

export function FilterContent() {
  return (
    <div className="p-4">
      <h3 className="text-xs font-bold mb-2 uppercase">Filters</h3>

      <EntityTypeFilter />
    </div>
  );
}

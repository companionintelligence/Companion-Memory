import { Button } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';

import { describeBbox, type Bbox } from '@/pages/MemoryPage/bbox';

/**
 * The rectangles a Where filter carries, one row each, under the place names
 * in the Where popover — the same list on the memory page (read from `?areas`)
 * and in the saved-search editor (read from the row). A rectangle can only be
 * drawn on the map; here each can be read and removed, so neither popover
 * strips them by accident.
 */
export function MapAreaList({
  areas,
  onRemove,
}: {
  areas: readonly Bbox[];
  onRemove: (index: number) => void;
}) {
  if (areas.length === 0) {
    return null;
  }

  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {areas.map((area, index) => (
        <li key={`${index}:${area.join(',')}`} className="flex items-center justify-between gap-2">
          <span>Map area: {describeBbox(area)}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove map area ${index + 1}`}
            onClick={() => onRemove(index)}
          >
            <X className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

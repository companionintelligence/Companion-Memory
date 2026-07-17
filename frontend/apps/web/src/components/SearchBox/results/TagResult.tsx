import { TagIcon } from '@/components/icons';

import { startFilterDrag } from '../filterDrag';

interface Props {
  label: string;
}

/**
 * A tag row in the search dropdown, from the connection's `matchingTags`
 * sibling field (tags aren't part of the entity result union, so this takes
 * the label directly rather than a fragment).
 */
export function TagResult({ label }: Props) {
  return (
    // Draggable onto the Memory explorer's filter drop area to add this tag
    // as a filter; clicking opens the explorer filtered to the tag.
    <div
      draggable
      onDragStart={(event) => startFilterDrag(event, 'tag', label)}
      className="flex cursor-grab items-center justify-between gap-2 active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <TagIcon />
        <div className="font-medium">#{label}</div>
      </div>
      <div className="text-muted-foreground">Tag</div>
    </div>
  );
}

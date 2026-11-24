import { TagIcon } from '@/components/icons';

import { startFilterDrag } from '../filterDrag';

import { SearchResultRow } from './SearchResultRow';

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
    <SearchResultRow
      draggable
      onDragStart={(event) => startFilterDrag(event, 'tag', label)}
      className="cursor-grab active:cursor-grabbing"
      icon={<TagIcon />}
      title={`#${label}`}
      kind="Tag"
    />
  );
}

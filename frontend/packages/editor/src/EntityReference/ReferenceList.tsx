import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { cn } from '@ci/shadcn';

import type { EntityReferenceItem } from './types';

/** Readable names for the entity-type slugs a GlobalUID carries. */
const TYPE_LABELS: Record<string, string> = {
  communication: 'Message',
  concept: 'Concept',
  content: 'Content',
  event: 'Event',
  file: 'File',
  item: 'Item',
  note: 'Note',
  person: 'Person',
  place: 'Place',
  thread: 'Thread',
};

export interface ReferenceListHandle {
  /** Returns true when the key was consumed, so the editor leaves it alone. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export interface ReferenceListProps {
  items: EntityReferenceItem[];
  command: (item: EntityReferenceItem) => void;
}

/**
 * The `[[` autocomplete menu. Keyboard driven — the suggestion plugin forwards
 * keydowns through the imperative handle rather than the list taking focus,
 * because the editor selection has to stay put while the user is choosing.
 */
export const ReferenceList = forwardRef<ReferenceListHandle, ReferenceListProps>(function ReferenceList(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // A fresh result set invalidates the old highlight position.
  useEffect(() => setSelected(0), [items]);

  // Keep the highlighted row in view when arrowing past the scroll edge.
  useEffect(() => {
    itemRefs.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event: KeyboardEvent) => {
        if (items.length === 0) {
          return false;
        }

        if (event.key === 'ArrowUp') {
          setSelected((prev) => (prev + items.length - 1) % items.length);

          return true;
        }

        if (event.key === 'ArrowDown') {
          setSelected((prev) => (prev + 1) % items.length);

          return true;
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[selected];

          if (item) {
            command(item);
          }

          return true;
        }

        return false;
      },
    }),
    [items, selected, command],
  );

  if (items.length === 0) {
    return (
      <div className="w-72 rounded-md border border-border bg-popover p-3 text-xs text-muted-foreground shadow-md">
        No matches. Keep typing to search your notes and entities.
      </div>
    );
  }

  return (
    <div className="max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
      {items.map((item, index) => (
        <button
          key={item.uid}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          type="button"
          // Pointer-down rather than click: the editor would lose the suggestion
          // range to the blur before a click ever landed.
          onMouseDown={(event) => {
            event.preventDefault();
            command(item);
          }}
          onMouseEnter={() => setSelected(index)}
          className={cn(
            'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
            index === selected ? 'bg-accent text-accent-foreground' : 'text-foreground',
          )}
        >
          <span className="truncate">{item.label}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            {TYPE_LABELS[item.type] ?? item.type}
          </span>
        </button>
      ))}
    </div>
  );
});

import type { DragEventHandler, ReactNode } from 'react';

import { cn } from '@ci/shadcn';

interface Props {
  icon: ReactNode;
  title: ReactNode;
  /** Secondary text, such as a date. Sits under the title on a phone and beside it on desktop. */
  meta?: ReactNode;
  kind: string;
  className?: string;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
}

/**
 * One suggestion row. The title is the only part that may shrink: the icon and
 * the kind label stay fully inside the search panel, including on a phone where
 * the box is only as wide as the header leaves it.
 */
export function SearchResultRow({ icon, title, meta, kind, className, draggable, onDragStart }: Props) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      className={cn('flex min-w-0 items-center gap-2', className)}
    >
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="min-w-0 flex-1 truncate font-medium">{title}</div>
          {meta ? <div className="hidden shrink-0 text-muted-foreground device:block">{meta}</div> : null}
        </div>
        {meta ? <div className="truncate text-muted-foreground device:hidden">{meta}</div> : null}
      </div>
      <div className="shrink-0 text-muted-foreground">{kind}</div>
    </div>
  );
}

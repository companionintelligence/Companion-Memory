import type { CSSProperties, ReactNode } from 'react';

import type { ScrollOverflow } from '@ci/common';
import { cn } from '@ci/shadcn';
import { ChevronLeft, ChevronRight } from '@ci/shadcn/icons';

/**
 * Wraps a sideways-scrolling row of chips or buttons and marks each edge that
 * hides more of it with a faint chevron, so a row cut off by the screen reads
 * as "swipe for more".
 *
 * The row itself is the child, and the caller measures it with
 * `useScrollOverflow` and passes the result in as `more`. The wrapper takes
 * over the row's place in its parent's layout, so give it the sizing classes
 * the row had there (`flex-1`, `min-w-0`, …) through `className`, and any
 * custom properties those classes read through `style`.
 *
 * The chevrons are decoration: they take no pointer events, so a tap on the
 * chip under one still lands on the chip, and screen readers skip them — the
 * row's own items are all reachable by Tab and by swipe.
 */
export function ScrollMoreArrows({
  more,
  className,
  style,
  children,
}: {
  more: ScrollOverflow;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={cn('relative', className)} style={style}>
      {children}
      <MoreArrow side="left" shown={more.left} />
      <MoreArrow side="right" shown={more.right} />
    </div>
  );
}

function MoreArrow({ side, shown }: { side: 'left' | 'right'; shown: boolean }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;

  return (
    <span
      aria-hidden
      data-testid={`scroll-more-${side}`}
      data-shown={shown || undefined}
      className={cn(
        'pointer-events-none absolute inset-y-0 z-10 flex items-center opacity-0 transition-opacity duration-150 data-[shown]:opacity-100',
        side === 'left' ? 'left-0' : 'right-0',
      )}
    >
      <span className="flex size-5 items-center justify-center rounded-full bg-muted/70 text-muted-foreground/80 shadow-sm backdrop-blur-[2px]">
        <Icon className="size-3.5" strokeWidth={2.5} />
      </span>
    </span>
  );
}

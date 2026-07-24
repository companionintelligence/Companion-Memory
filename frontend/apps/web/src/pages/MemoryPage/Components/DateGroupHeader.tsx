import { cn } from '@ci/shadcn';

interface DateGroupHeaderProps {
  label: string;
  /** Optional count of items in this group, shown as a muted suffix. */
  count?: number;
  className?: string;
  /**
   * Which side the label sits on. `left` (default) keeps the label first with a
   * trailing rule (List view); `right` puts the rule first so the label is
   * aligned near the rail edge with breathing room — used by the Timeline rail.
   */
  align?: 'left' | 'right';
}

/**
 * Sticky date-group header shared by the List and Timeline views so both
 * segment chronological results identically (Today / Yesterday / This Week / …).
 */
export function DateGroupHeader({ label, count, className, align = 'left' }: DateGroupHeaderProps) {
  const rule = <div className="h-px flex-1 bg-border" />;
  const rightAligned = align === 'right';

  return (
    <div
      className={cn(
        'sticky top-0 z-10 flex items-center gap-2 bg-background/85 py-2 backdrop-blur-sm',
        // The negative margin lets the sticky backdrop bleed past the scroll
        // container's edge; the inner padding then places the label flush with
        // the rows' icon slot so headers and icons share one left edge.
        rightAligned ? 'px-3' : '-mx-1 px-3',
        className,
      )}
    >
      {rightAligned && rule}
      <div className="flex shrink-0 items-center gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
        {count != null && <span className="text-xs tabular-nums text-muted-foreground/70">{count}</span>}
      </div>
      {!rightAligned && rule}
    </div>
  );
}

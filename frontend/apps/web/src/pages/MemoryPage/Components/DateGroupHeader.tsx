import { cn } from '@ci/shadcn';

interface DateGroupHeaderProps {
  label: string;
  /** Optional count of items in this group, shown as a muted suffix. */
  count?: number;
  className?: string;
  /**
   * Which side the label sits on. `left` (default) keeps the label first with a
   * trailing rule (List view); `right` puts the rule first so the label hugs the
   * right edge — used by the Timeline rail.
   */
  align?: 'left' | 'right';
}

/**
 * Sticky date-group header shared by the List and Timeline views so both
 * segment chronological results identically (Today / Yesterday / This Week / …).
 */
export function DateGroupHeader({ label, count, className, align = 'left' }: DateGroupHeaderProps) {
  const rule = <div className="h-px flex-1 bg-border" />;

  return (
    <div
      className={cn(
        'sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-background/85 px-1 py-2 backdrop-blur-sm',
        className,
      )}
    >
      {align === 'right' && rule}
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      {count != null && <span className="text-xs tabular-nums text-muted-foreground/70">{count}</span>}
      {align === 'left' && rule}
    </div>
  );
}

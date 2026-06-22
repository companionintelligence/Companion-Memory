import { cn } from '@ci/shadcn';

interface DateGroupHeaderProps {
  label: string;
  /** Optional count of items in this group, shown as a muted suffix. */
  count?: number;
  className?: string;
}

/**
 * Sticky date-group header shared by the List and Timeline views so both
 * segment chronological results identically (Today / Yesterday / This Week / …).
 */
export function DateGroupHeader({ label, count, className }: DateGroupHeaderProps) {
  return (
    <div
      className={cn(
        'sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-background/85 px-1 py-2 backdrop-blur-sm',
        className,
      )}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      {count != null && <span className="text-xs tabular-nums text-muted-foreground/70">{count}</span>}
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

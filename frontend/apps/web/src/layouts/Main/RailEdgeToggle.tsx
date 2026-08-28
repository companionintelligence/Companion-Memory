import { cn } from '@ci/shadcn';
import { ChevronLeft, ChevronRight } from '@ci/shadcn/icons';

/**
 * Thick rounded chevron: points out of the edge to open, back in to close.
 */
export function RailEdgeToggle({
  open,
  onClick,
  className,
}: {
  open: boolean;
  onClick: () => void;
  className?: string;
}) {
  const label = open ? 'Close menu' : 'Open menu';
  const Icon = open ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-controls="power-rail"
      onClick={onClick}
      className={cn(
        'inline-flex size-10 items-center justify-center rounded-full border border-white/55 bg-white/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.7),0_1px_2px_rgba(0,0,0,0.08)] backdrop-blur-md hover:bg-white/45 dark:border-white/20 dark:bg-white/10 dark:hover:bg-white/20',
        className,
      )}
    >
      {/* Lucide's chevron sits left of optical center in a circle — the same
          1px nudge the logo disc uses, flipped with the direction. */}
      <Icon
        className={cn('h-5 w-5', open ? '-translate-x-px' : 'translate-x-px')}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </button>
  );
}

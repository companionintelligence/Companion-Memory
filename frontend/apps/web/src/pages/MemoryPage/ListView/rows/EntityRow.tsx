import { type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { cn } from '@ci/shadcn';

interface EntityRowProps {
  /** Type glyph or media thumbnail shown in the leading slot. */
  icon: ReactNode;
  /** Primary line — entity title/name. */
  title: ReactNode;
  /** Secondary line — source, preview, or description. */
  subtitle?: ReactNode;
  /** Trailing compact timestamp. */
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  className?: string;
}

/**
 * Dense, scannable memory row shared by every entity type in the List view:
 * a leading type glyph, a two-line title/source stack, and a right-aligned time.
 * Keeping the layout here (rather than per type) guarantees consistent density
 * and typography across all rows.
 */
export function EntityRow({ icon, title, subtitle, time, onClick, className }: EntityRowProps) {
  const interactive = onClick != null;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick(e as unknown as MouseEvent<HTMLDivElement>);
    }
  };

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
        interactive &&
          'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none',
        className,
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center [&>svg]:h-[18px] [&>svg]:w-[18px]">
        {icon}
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight text-foreground">{title}</div>
        {subtitle != null && subtitle !== '' && (
          <div className="mt-0.5 truncate text-xs leading-tight text-muted-foreground">{subtitle}</div>
        )}
      </div>

      {time != null && time !== '' && (
        <time className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{time}</time>
      )}
    </div>
  );
}

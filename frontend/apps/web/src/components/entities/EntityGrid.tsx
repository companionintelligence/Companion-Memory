import { type ReactNode } from 'react';

import { cn } from '@ci/shadcn';

interface Props {
  className?: string;
  children: ReactNode;
}

export function EntityGrid({ className, children }: Props) {
  return (
    <div
      className={cn(
        // Responsive masonry-ish grid: columns shrink to fit narrow viewports
        // and fill the available width instead of a fixed 300px track.
        'grid w-full gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] auto-rows-[260px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

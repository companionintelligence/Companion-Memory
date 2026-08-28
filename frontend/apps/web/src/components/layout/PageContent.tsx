import type { ReactNode, Ref } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';

interface Props {
  children?: ReactNode;
  className?: string;
  relativeBoundary?: boolean;
  /** This element is the page's scroll container — take a ref to observe it. */
  ref?: Ref<HTMLDivElement>;
}

/** `data-page-scroll` marks this as the page scroller so overlays can reset it, and so a status-bar tap can find it. */

export function PageContent({ children, className, relativeBoundary = true, ref }: Props) {
  const { isMobile } = useDeviceLayout();

  const spacing = isMobile ? 'p-2 gap-2' : 'p-6 gap-6 pt-[max(1.5rem,env(safe-area-inset-top))]';

  return (
    <div
      ref={ref}
      data-page-scroll=""
      className={cn(
        spacing,
        'flex flex-col texture-surface',
        className,
        relativeBoundary ? 'relative' : 'static',
        'w-full h-full overflow-auto',
      )}
    >
      {children}
    </div>
  );
}

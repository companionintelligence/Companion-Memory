import type { ReactNode, Ref } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';

interface Props {
  children?: ReactNode;
  className?: string;
  relativeBoundary?: boolean;
  /**
   * When false, this frame fills its parent and a child owns scrolling.
   * The calendar uses that so the day grid is the only scroller.
   */
  scroll?: boolean;
  /** This element is the page's scroll container — take a ref to observe it. */
  ref?: Ref<HTMLDivElement>;
}

/** `data-page-scroll` marks this as the page scroller so overlays can reset it, and so a status-bar tap can find it. */

export function PageContent({ children, className, relativeBoundary = true, scroll = true, ref }: Props) {
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
        scroll ? 'w-full h-full overflow-auto' : 'w-full h-full min-h-0 overflow-hidden',
      )}
    >
      {children}
    </div>
  );
}

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

export function PageContent({ children, className, relativeBoundary = true, ref }: Props) {
  const { isMobile } = useDeviceLayout();

  const spacing = isMobile
    ? 'p-2 gap-2 pt-[max(0.5rem,env(safe-area-inset-top))]'
    : 'p-6 gap-6 pt-[max(1.5rem,env(safe-area-inset-top))]';

  return (
    <div
      ref={ref}
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

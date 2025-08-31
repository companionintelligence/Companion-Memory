import type { ReactNode } from 'react';

import { cn } from '@ci/shadcn';

import { useDeviceLayout } from '@/hooks';

interface Props {
  children?: ReactNode;
  className?: string;
}

export function PageContent({ children, className }: Props) {
  const { isMobile } = useDeviceLayout();

  const spacing = isMobile ? 'p-4 gap-4' : 'p-6 gap-6';

  return (
    <div
      className={cn(
        spacing,
        'flex flex-col',
        className,
        'w-full h-full overflow-auto transition-all duration-300',
      )}
    >
      {children}
    </div>
  );
}

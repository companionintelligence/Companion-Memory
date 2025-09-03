import type { ReactNode } from 'react';

import { cn } from '@ci/shadcn';

import { useDeviceLayout } from '@/hooks';

interface Props {
  children?: ReactNode;
  className?: string;
}

export function PageContent({ children, className }: Props) {
  const { isMobile } = useDeviceLayout();

  const spacing = isMobile ? 'p-2 gap-2' : 'p-6 gap-6';

  return (
    <div className={cn(spacing, 'flex flex-col', className, 'w-full h-full overflow-auto')}>{children}</div>
  );
}

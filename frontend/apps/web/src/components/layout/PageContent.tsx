import type { ReactNode } from 'react';

import { cn } from '@ci/shadcn';

interface Props {
  children?: ReactNode;
  className?: string;
}

export function PageContent({ children, className }: Props) {
  return (
    <div className={cn('p-6 flex flex-col gap-6', className, 'w-full h-full overflow-auto')}>{children}</div>
  );
}

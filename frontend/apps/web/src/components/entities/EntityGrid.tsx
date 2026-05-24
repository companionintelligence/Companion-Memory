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
        'grid w-full gap-4 justify-center grid-cols-[repeat(auto-fill,300px)] auto-rows-[300px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

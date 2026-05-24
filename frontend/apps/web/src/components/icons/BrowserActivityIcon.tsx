import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { Globe } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof Globe> & {
  className?: string;
  colorized?: boolean;
};

export function BrowserActivityIcon({ className, colorized = true, ...props }: Props) {
  return (
    <Globe
      className={cn(colorized ? 'text-emerald-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { Package } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof Package> & {
  className?: string;
  colorized?: boolean;
};

export function ItemIcon({ className, colorized = true, ...props }: Props) {
  return (
    <Package
      className={cn(colorized ? 'text-yellow-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

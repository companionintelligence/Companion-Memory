import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { Zap } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof Zap> & {
  className?: string;
  colorized?: boolean;
};

export function ActionIcon({ className, colorized = true, ...props }: Props) {
  return (
    <Zap
      className={cn(colorized ? 'text-amber-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

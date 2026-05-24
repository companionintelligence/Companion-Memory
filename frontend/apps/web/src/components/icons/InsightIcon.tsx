import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { Lightbulb } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof Lightbulb> & {
  className?: string;
  colorized?: boolean;
};

export function InsightIcon({ className, colorized = true, ...props }: Props) {
  return (
    <Lightbulb
      className={cn(colorized ? 'text-purple-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

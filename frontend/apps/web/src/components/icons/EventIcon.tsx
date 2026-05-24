import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { CalendarFold } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof CalendarFold> & {
  className?: string;
  colorized?: boolean;
};

export function EventIcon({ className, colorized = true, ...props }: Props) {
  return (
    <CalendarFold
      className={cn(colorized ? 'text-orange-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

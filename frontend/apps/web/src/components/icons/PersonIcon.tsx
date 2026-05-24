import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { User } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof User> & {
  className?: string;
  colorized?: boolean;
};

export function PersonIcon({ className, colorized = true, ...props }: Props) {
  return (
    <User
      className={cn(colorized ? 'text-indigo-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

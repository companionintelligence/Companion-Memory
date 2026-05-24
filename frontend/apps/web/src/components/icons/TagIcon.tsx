import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { Tag } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof Tag> & {
  className?: string;
  colorized?: boolean;
};

export function TagIcon({ className, colorized = true, ...props }: Props) {
  return (
    <Tag
      className={cn(colorized ? 'text-orange-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

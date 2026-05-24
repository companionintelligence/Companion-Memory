import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { File } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof File> & {
  className?: string;
  colorized?: boolean;
};

export function FileIcon({ className, colorized = true, ...props }: Props) {
  return (
    <File
      className={cn(colorized ? 'text-gray-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

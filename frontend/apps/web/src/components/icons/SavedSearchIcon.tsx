import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { FolderSearch2 } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof FolderSearch2> & {
  className?: string;
  colorized?: boolean;
};

export function SavedSearchIcon({ className, colorized = true, ...props }: Props) {
  return (
    <FolderSearch2
      className={cn(colorized ? 'text-teal-600' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

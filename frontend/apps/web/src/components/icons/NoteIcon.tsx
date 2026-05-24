import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { NotebookPen } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof NotebookPen> & {
  className?: string;
  colorized?: boolean;
};

export function NoteIcon({ className, colorized = true, ...props }: Props) {
  return (
    <NotebookPen
      className={cn(colorized ? 'text-teal-600' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

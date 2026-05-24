import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { MessageSquare } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof MessageSquare> & {
  className?: string;
  colorized?: boolean;
};

export function CommunicationIcon({ className, colorized = true, ...props }: Props) {
  return (
    <MessageSquare
      className={cn(colorized ? 'text-green-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

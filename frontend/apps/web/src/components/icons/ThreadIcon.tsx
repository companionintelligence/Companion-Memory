import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { BotMessageSquare } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof BotMessageSquare> & {
  className?: string;
  colorized?: boolean;
};

export function ThreadIcon({ className, colorized = true, ...props }: Props) {
  return (
    <BotMessageSquare
      className={cn(colorized ? 'text-teal-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

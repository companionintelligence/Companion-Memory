import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { TvMinimal } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof TvMinimal> & {
  className?: string;
  colorized?: boolean;
};

export function ContentIcon({ className, colorized = true, ...props }: Props) {
  return (
    <TvMinimal
      className={cn(colorized ? 'text-pink-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

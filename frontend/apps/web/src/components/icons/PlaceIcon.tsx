import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { MapPin } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof MapPin> & {
  className?: string;
  colorized?: boolean;
};

export function PlaceIcon({ className, colorized = true, ...props }: Props) {
  return (
    <MapPin
      className={cn(colorized ? 'text-red-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

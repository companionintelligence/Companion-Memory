import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { Boxes } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof Boxes> & {
  className?: string;
  colorized?: boolean;
};

/**
 * A catalog MODEL, not an owned object — deliberately a different glyph from
 * ItemIcon's single package, because the whole point of the distinction is that
 * one model has many units.
 */
export function ProductIcon({ className, colorized = true, ...props }: Props) {
  return (
    <Boxes
      className={cn(colorized ? 'text-amber-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

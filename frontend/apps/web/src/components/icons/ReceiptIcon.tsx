import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { Receipt } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof Receipt> & {
  className?: string;
  colorized?: boolean;
};

export function ReceiptIcon({ className, colorized = true, ...props }: Props) {
  return (
    <Receipt
      className={cn(colorized ? 'text-lime-600' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

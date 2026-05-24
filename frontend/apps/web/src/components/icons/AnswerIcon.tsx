import { type ComponentProps } from 'react';

import { cn } from '@ci/shadcn';
import { BadgeQuestionMark } from '@ci/shadcn/icons';

type Props = ComponentProps<typeof BadgeQuestionMark> & {
  className?: string;
  colorized?: boolean;
};

export function AnswerIcon({ className, colorized = true, ...props }: Props) {
  return (
    <BadgeQuestionMark
      className={cn(colorized ? 'text-blue-500' : 'text-[rgb(6,108,128)]', className)}
      size={24}
      strokeWidth={1.5}
      {...props}
    />
  );
}

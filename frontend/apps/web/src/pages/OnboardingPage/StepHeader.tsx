import type { ReactNode } from 'react';

import { cn } from '@ci/shadcn';

interface StepHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  align?: 'center' | 'left';
}

/** Large Typeform-style question header used across onboarding steps. */
export function StepHeader({ title, description, className, align = 'center' }: StepHeaderProps) {
  return (
    <div className={cn('space-y-3 w-full', align === 'center' ? 'text-center' : 'text-left', className)}>
      <h1 className="text-[1.6rem] sm:text-4xl md:text-[2.75rem] font-semibold tracking-tight text-foreground leading-[1.12]">
        {title}
      </h1>
      {description != null && (
        <p
          className={cn(
            'text-base sm:text-xl text-muted-foreground leading-snug',
            align === 'center' && 'max-w-2xl mx-auto',
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}

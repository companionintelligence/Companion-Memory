import { useMemo } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';

export function ChatLoader() {
  const { isMobile } = useDeviceLayout();
  const topOffset = useMemo(() => (isMobile ? '-top-1' : 'top-0.5'), [isMobile]);

  const className =
    'w-1.5 h-1.5 bg-muted-foreground/30 rounded-full animate-bounce transform-gpu will-change-transform';

  return (
    <div className={cn('flex gap-2 absolute justify-center left-1/2 -translate-x-1/2', topOffset)}>
      <div className={className} style={{ animationDelay: '0ms' }} />
      <div className={className} style={{ animationDelay: '150ms' }} />
      <div className={className} style={{ animationDelay: '300ms' }} />
    </div>
  );
}

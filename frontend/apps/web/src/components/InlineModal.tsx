import { type ReactNode, useEffect } from 'react';

import { cn } from '@ci/shadcn';

interface Props {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}

export function InlineModal({ open, onClose, children, className }: Props) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className={cn('absolute flex flex-col inset-0 z-10 bg-background animate-in fade-in-0', className)}>
      {children}
    </div>
  );
}

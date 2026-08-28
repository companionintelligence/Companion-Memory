import { type ReactNode, useEffect, useRef } from 'react';

import { Portal } from '@ci/common';
import { cn } from '@ci/shadcn';

interface Props {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
  /**
   * Move the overlay into a layout portal (e.g. `content-modal` on `<main>`).
   * Without this, `absolute inset-0` anchors to the nearest positioned ancestor,
   * which on Today is the scrolling PageContent — so a dialog opened mid-scroll
   * paints at the top of the page, out of view.
   */
  portalId?: string;
  /** Focus the dialog when it opens so the chat is the active surface. */
  autoFocus?: boolean;
  'aria-label'?: string;
}

export function InlineModal({
  open,
  onClose,
  children,
  className,
  portalId,
  autoFocus = false,
  'aria-label': ariaLabel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open || !autoFocus) {
      return;
    }

    dialogRef.current?.focus();
  }, [open, autoFocus]);

  if (!open) {
    return null;
  }

  const dialog = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={autoFocus ? -1 : undefined}
      className={cn(
        'absolute flex flex-col inset-0 z-10 bg-background animate-in fade-in-0 outline-none',
        className,
      )}
    >
      {children}
    </div>
  );

  if (portalId) {
    return <Portal.Slot id={portalId}>{dialog}</Portal.Slot>;
  }

  return dialog;
}

import type { ReactNode } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Card, Collapsible, cn } from '@ci/shadcn';
import { ChevronDown } from '@ci/shadcn/icons';

import { COMPACT_CARD, PHONE_CARD, PHONE_PAD } from './layout';

/** True only after layout has resolved to the phone chrome (< 896px). */
export function usePhone(): boolean {
  const { isMobile } = useDeviceLayout();

  return isMobile === true;
}

/**
 * Card chrome for this page. On a phone the body can fold so a long stack
 * (history, schedules, dead letters) is a header until someone opens it.
 * Desktop is always expanded — fold is a no-op there.
 */
export function FoldCard({
  fold = false,
  defaultOpen = false,
  className,
  children,
}: {
  fold?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const phone = usePhone();
  const card = <Card className={cn(phone ? PHONE_CARD : COMPACT_CARD, className)}>{children}</Card>;

  if (!phone || !fold) {
    return card;
  }

  return <Collapsible defaultOpen={defaultOpen}>{card}</Collapsible>;
}

/** Title block that becomes the fold control on a phone. Desktop: a title cluster. */
export function FoldTrigger({ children, className }: { children: ReactNode; className?: string }) {
  const phone = usePhone();

  if (!phone) {
    return <div className={className}>{children}</div>;
  }

  return (
    <Collapsible.Trigger
      className={cn(
        'flex w-full min-w-0 items-start gap-2 text-left [&[data-state=open]>svg]:rotate-180',
        className,
      )}
    >
      <ChevronDown
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </Collapsible.Trigger>
  );
}

/** Body that hides when the phone fold is closed. Desktop: identity. */
export function FoldBody({ children }: { children: ReactNode }) {
  const phone = usePhone();

  if (!phone) {
    return <>{children}</>;
  }

  return <Collapsible.Content>{children}</Collapsible.Content>;
}

export function cardPad(phone: boolean): string {
  return phone ? PHONE_PAD : '';
}

import { type MouseEvent, type MouseEventHandler, type ReactNode, useCallback } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Button, cn, IconButton } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { Tag } from '@/components/Tag';

interface Props {
  title: string;
  description: ReactNode;
  tags?: string[];
  imageUrl?: string;
  className?: string;
  onClick?: MouseEventHandler;
  onDismiss?: MouseEventHandler<HTMLButtonElement>;
  dismissLabel?: string;
  showUnseenIndicator?: boolean;
}

export function BentoCard({
  title,
  tags = [],
  description,
  imageUrl,
  className,
  onClick,
  onDismiss,
  dismissLabel,
  showUnseenIndicator = false,
}: Props) {
  const { t } = useTranslation();
  const { isMobile } = useDeviceLayout();

  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      onClick?.(e);
    },
    [onClick],
  );

  const handleDismiss = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onDismiss?.(e);
    },
    [onDismiss],
  );

  // Dismiss hangs 1 off the card so it sits on the corner, mirroring the unseen
  // dot opposite. Chat is the card click itself — a second button under the X
  // was a duplicate. No deeper than 1: the carousel viewport clips at `pt-1`.
  const cardActions = onDismiss ? (
    <div className="absolute -right-1 -top-1 z-30">
      <IconButton
        type="button"
        variant="outline"
        className="h-7 w-7 rounded-full bg-background/80 backdrop-blur-sm"
        onClick={handleDismiss}
        label={dismissLabel ?? t('FEED_CARD_DISMISS')}
      >
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  ) : null;

  // The dismiss button is 7 wide and hangs 1 past the edge, so it reaches 6
  // back into the card; the extra 3 keeps a right-aligned tag from butting up
  // against it.
  const actionGutter = onDismiss ? 'pr-9' : undefined;

  const unseenIndicator = showUnseenIndicator ? (
    <>
      {/* The dot overhangs the card by a third of its size, so it must stay out
          of the hit test or it swallows clicks meant for the neighbouring card.
          That also rules out hovering it, hence the sr-only text rather than a
          tooltip: a decorative span carries no role, so aria-label on it would
          be ignored anyway. */}
      <span
        className="pointer-events-none absolute left-0 top-0 z-30 h-3 w-3 -translate-x-1/3 -translate-y-1/3 rounded-full bg-primary ring-2 ring-background"
        aria-hidden="true"
      />
      <span className="sr-only">{t('FEED_CARD_UNSEEN')}</span>
    </>
  ) : null;

  if (isMobile) {
    // Compact preview row — tap opens the existing write-up. Hover does not
    // exist on a phone, so dismiss is a 44px control in the layout, not a
    // corner affordance that only appears on mouseover.
    return (
      <div
        className={cn(
          'relative flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left',
          'cursor-pointer select-none text-card-foreground active:bg-accent/15',
          className,
        )}
        onClick={handleClick}
      >
        {unseenIndicator}
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover bg-muted" />
        ) : null}

        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-1 text-base font-semibold leading-snug text-foreground">{title}</h3>
          <div
            className={cn(
              'mt-0.5 line-clamp-2 text-sm leading-snug text-muted-foreground',
              '[&_p]:m-0 [&_p]:inline [&_p+p]:hidden',
              '[&_ul]:hidden [&_ol]:hidden [&_h1]:hidden [&_h2]:hidden [&_h3]:hidden',
              '[&_.inline-flex]:hidden [&_img]:hidden',
            )}
          >
            {description}
          </div>
        </div>

        {onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 text-muted-foreground"
            aria-label={dismissLabel ?? t('FEED_CARD_DISMISS')}
            onClick={handleDismiss}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    );
  }

  if (imageUrl == null) {
    return (
      <div
        className={cn(
          'w-[550px] h-[400px] relative flex flex-col border border-border bg-card text-card-foreground shadow-md rounded-lg cursor-pointer select-none gap-4 p-4',
          className,
        )}
        onClick={handleClick}
      >
        {unseenIndicator}
        {cardActions}
        <div className={cn('flex w-full justify-between content-start', actionGutter)}>
          <h1 className="text-2xl font-semibold">{title}</h1>

          {(tags?.length ?? 0) > 0 && (
            <div>
              <div className="flex flex-wrap gap-1 justify-end">
                {tags.map((tag) => (
                  <Tag key={tag} text={tag} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="relative flex-1 overflow-hidden">
          <div className="h-full overflow-hidden">{description}</div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-card" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'w-[550px] h-[400px] relative flex flex-row border border-border bg-card text-card-foreground shadow-md rounded-lg cursor-pointer select-none',
        className,
      )}
      onClick={handleClick}
    >
      {unseenIndicator}
      {cardActions}
      <div className="flex flex-col flex-1 gap-4 justify-between p-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
        </div>

        <div className="relative flex-1 overflow-hidden">
          <div className="h-full overflow-hidden">{description}</div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-card" />
        </div>
      </div>

      <div className="flex flex-col w-50 justify-between content-end text-right relative overflow-hidden rounded-tr-lg rounded-br-lg select-none">
        {(tags?.length ?? 0) > 0 && (
          <div
            className={cn(
              'flex flex-wrap gap-1 justify-end relative z-10 p-4 [background-image:radial-gradient(circle_at_top_right,_rgba(255,255,255,0.9),_rgba(255,255,255,0.1))]',
              actionGutter,
            )}
          >
            {tags.map((tag) => (
              <Tag key={tag} text={tag} />
            ))}
          </div>
        )}

        {/* We're relying on flexbox to space this correctly, so we need to render an empty div if there are no tags to render the button at the bottom. */}
        {tags?.length === 0 && <div></div>}

        <div className="relative z-10 p-4" />

        {/* We're passing in an `imageUrl` (at least for now) because we're adding these classes to make it look "right".
        We could use a ReactNode, but consider this a shortcut for now. Feel free to update if the same design goals can be met. */}
        <img
          className="absolute inset-0 h-full w-auto object-cover overflow-hidden will-change-transform"
          src={imageUrl}
        />
      </div>
    </div>
  );
}

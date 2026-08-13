import { type MouseEvent, type MouseEventHandler, type ReactNode, useCallback } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn, IconButton } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { Tag } from '@/components/Tag';
import type { AgentChatContext } from '@/lib/agentChat';

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
  chatContext?: AgentChatContext;
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
  chatContext,
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

  // The controls stack down the right edge rather than sitting side by side: two
  // buttons in a row ate enough of the header that a long title wrapped underneath
  // them. The whole stack hangs 1 off the card so the dismiss button sits on the
  // corner, mirroring the unseen dot opposite, with the chat button lined up under
  // it. No deeper than 1: the carousel viewport clips at `pt-1`, so a larger offset
  // would shave the top off the dismiss button.
  const cardActions =
    onDismiss || chatContext ? (
      <div className="absolute -right-1 -top-1 z-30 flex flex-col items-end gap-2">
        {onDismiss && (
          <IconButton
            type="button"
            variant="outline"
            className="h-7 w-7 rounded-full bg-background/80 backdrop-blur-sm"
            onClick={handleDismiss}
            label={dismissLabel ?? t('FEED_CARD_DISMISS')}
          >
            <X className="h-4 w-4" />
          </IconButton>
        )}
        {chatContext && (
          <ChatWithAgentMenu
            context={chatContext}
            className="h-7 w-7 rounded-full bg-background/80 backdrop-blur-sm"
          />
        )}
      </div>
    ) : null;

  // Gutter the header content has to leave clear so the stack never lands on top of
  // the title or the tags. Both buttons are 7 wide and hang 1 past the edge, so they
  // reach 6 back into the card whichever of them is rendered; the extra 3 keeps a
  // right-aligned tag from butting up against the chat button.
  const actionGutter = onDismiss || chatContext ? 'pr-9' : undefined;

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
    return (
      <div
        className={cn(
          'h-full w-full flex flex-col border border-border bg-card text-card-foreground rounded-lg cursor-pointer select-none p-4 gap-4',
          className,
          'relative',
        )}
        onClick={handleClick}
      >
        {unseenIndicator}
        {cardActions}
        {imageUrl && (
          <div
            className={cn(
              'relative top-0 left-0 right-0 min-h-42 bg-cover bg-center rounded-t-lg -mx-4 -mt-4 text-2xl font-bold text-center text-white p-4',
              // The action stack is pinned to the top-right; without a reserved gutter
              // a two-word title ("Weather update") runs straight underneath it.
              actionGutter,
            )}
            style={{
              backgroundImage: `
              linear-gradient(to bottom, rgba(0,0,0,0.75), rgba(0,0,0,0.15) 60%, rgba(0,0,0,0)),
              url(${imageUrl})
            `,
              // Bright imagery (the weather card's cloud cover) washed the title out
              // even through the scrim.
              textShadow: '0 1px 3px rgba(0,0,0,0.6)',
            }}
          >
            {title}
          </div>
        )}

        {/* Padded on both sides so the title stays optically centred while clearing
            the action stack on the right. */}
        {!imageUrl && (
          <div className={cn('text-4xl font-bold text-center', actionGutter && 'px-9')}>{title}</div>
        )}

        {(tags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 justify-center">
            {tags.map((tag) => (
              <Tag key={tag} text={tag} />
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <div>{description}</div>
        </div>
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

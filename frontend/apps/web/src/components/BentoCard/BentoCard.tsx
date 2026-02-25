import { type MouseEvent, type MouseEventHandler, type ReactNode, useCallback } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Button, cn } from '@ci/shadcn';
import { MessagesSquare, ThumbsDown, ThumbsUp, X } from '@ci/shadcn/icons';

import { Tag } from '@/components/Tag';

interface Props {
  title: string;
  description: ReactNode;
  tags?: string[];
  imageUrl?: string;
  className?: string;
  onClick?: MouseEventHandler;
  onLike?: MouseEventHandler;
  onDislike?: MouseEventHandler;
  onExpand?: MouseEventHandler;
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
  onLike,
  onDislike,
  onExpand,
  onDismiss,
  dismissLabel = 'Dismiss card',
  showUnseenIndicator = false,
}: Props) {
  const { isMobile } = useDeviceLayout();

  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      onClick?.(e);
    },
    [onClick],
  );

  const handleLike = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onLike?.(e);
    },
    [onLike],
  );

  const handleDislike = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onDislike?.(e);
    },
    [onDislike],
  );

  const handleExpand = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onExpand?.(e);
    },
    [onExpand],
  );

  const handleDismiss = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onDismiss?.(e);
    },
    [onDismiss],
  );

  const dismissButton = onDismiss ? (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="absolute right-3 top-3 z-30 h-7 w-7 bg-background/80 backdrop-blur-sm"
      onClick={handleDismiss}
      aria-label={dismissLabel}
      title={dismissLabel}
    >
      <X className="h-4 w-4" />
    </Button>
  ) : null;

  const unseenIndicator = showUnseenIndicator ? (
    <span
      className="pointer-events-none absolute left-0 top-0 z-30 h-3 w-3 -translate-x-1/3 -translate-y-1/3 rounded-full bg-primary ring-2 ring-background"
      aria-label="New item"
      title="New item"
    />
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
        {dismissButton}
        {imageUrl && (
          <div
            className="relative top-0 left-0 right-0 min-h-42 bg-cover bg-center rounded-t-lg -mx-4 -mt-4 text-4xl font-bold text-center text-white p-4"
            style={{
              backgroundImage: `
              linear-gradient(to bottom, rgba(0,0,0,0.6), rgba(0,0,0,0)),
              url(${imageUrl})
            `,
            }}
          >
            {title}
          </div>
        )}

        {!imageUrl && <div className="text-4xl font-bold text-center">{title}</div>}

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

        <div className="flex gap-4 justify-between">
          <div className="flex flex-row gap-3 content-between">
            <Button className="bg-stone-50 cursor-pointer w-12 h-12" variant="outline" onClick={handleLike}>
              <ThumbsUp className="w-12 h-12" />
            </Button>

            <Button
              className="bg-stone-50 cursor-pointer w-12 h-12"
              variant="outline"
              onClick={handleDislike}
            >
              <ThumbsDown className="w-12 h-12" />
            </Button>
          </div>

          <Button className="bg-stone-50 cursor-pointer w-12 h-12" variant="outline" onClick={handleExpand}>
            <MessagesSquare className="w-12 h-12" />
          </Button>
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
        {dismissButton}
        <div className="flex w-full justify-between content-start">
          <h1 className="text-2xl font-semibold">{title}</h1>

          {(tags?.length ?? 0) > 0 && (
            <div>
              <div className={cn('flex flex-wrap gap-1 justify-end', onDismiss && 'pr-10')}>
                {tags.map((tag) => (
                  <Tag key={tag} text={tag} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          <div>{description}</div>
        </div>

        <div className="flex gap-4 justify-between">
          <div className="flex flex-row gap-2 content-between">
            <Button className="bg-stone-50 cursor-pointer" variant="outline" size="icon" onClick={handleLike}>
              <ThumbsUp />
            </Button>

            <Button
              className="bg-stone-50 cursor-pointer"
              variant="outline"
              size="icon"
              onClick={handleDislike}
            >
              <ThumbsDown />
            </Button>
          </div>

          <Button className="bg-stone-50 cursor-pointer" size="icon" variant="outline" onClick={handleExpand}>
            <MessagesSquare />
          </Button>
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
      {dismissButton}
      <div className="flex flex-col flex-1 gap-4 justify-between p-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
        </div>

        <div className="flex-1 overflow-hidden">
          <div>{description}</div>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <Button className="bg-stone-50 cursor-pointer" variant="outline" size="icon" onClick={handleLike}>
              <ThumbsUp />
            </Button>

            <Button
              className="bg-stone-50 cursor-pointer"
              variant="outline"
              size="icon"
              onClick={handleDislike}
            >
              <ThumbsDown />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col w-50 justify-between content-end text-right relative overflow-hidden rounded-tr-lg rounded-br-lg select-none">
        {(tags?.length ?? 0) > 0 && (
          <div
            className={cn(
              'flex flex-wrap gap-1 justify-end relative z-10 p-4 [background-image:radial-gradient(circle_at_top_right,_rgba(255,255,255,0.9),_rgba(255,255,255,0.1))]',
              onDismiss && 'pr-12',
            )}
          >
            {tags.map((tag) => (
              <Tag key={tag} text={tag} />
            ))}
          </div>
        )}

        {/* We're relying on flexbox to space this correctly, so we need to render an empty div if there are no tags to render the button at the bottom. */}
        {tags?.length === 0 && <div></div>}

        <div className="relative z-10 text-right justify-end p-4">
          <Button className="bg-stone-50 cursor-pointer" size="icon" variant="outline" onClick={handleExpand}>
            <MessagesSquare />
          </Button>
        </div>

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

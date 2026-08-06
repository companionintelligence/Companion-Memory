import { type MouseEvent, type MouseEventHandler, type ReactNode, useCallback } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Button, cn } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';

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
            className={cn(
              'relative top-0 left-0 right-0 min-h-42 bg-cover bg-center rounded-t-lg -mx-4 -mt-4 text-2xl font-bold text-center text-white p-4',
              // The dismiss button is `absolute right-3 top-3`; without a reserved
              // gutter a two-word title ("Weather update") runs straight underneath it.
              onDismiss && 'pr-12',
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
      {dismissButton}
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

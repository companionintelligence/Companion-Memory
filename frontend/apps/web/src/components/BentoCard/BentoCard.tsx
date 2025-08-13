import { type MouseEvent, type MouseEventHandler, type ReactNode, useCallback } from 'react';

import { Badge, Button, cn } from '@ci/shadcn';
import { MessagesSquare, ThumbsDown, ThumbsUp } from '@ci/shadcn/icons';

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
}: Props) {
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

  if (imageUrl == null) {
    return (
      <div
        className={cn(
          'w-[550px] h-[400px] flex flex-col border shadow-md rounded-lg cursor-pointer select-none gap-4 p-4',
          className,
        )}
        onClick={handleClick}
      >
        <div className="flex w-full justify-between content-start">
          <h1 className="text-2xl font-semibold">{title}</h1>

          {tags && (
            <div>
              <div className="flex flex-wrap gap-1 justify-end">
                {tags.map((tag) => (
                  <Badge className="bg-teal-600">{tag}</Badge>
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
        'w-[550px] h-[400px] flex flex-row border shadow-md rounded-lg cursor-pointer select-none',
        className,
      )}
      onClick={handleClick}
    >
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
        {tags && (
          <div className="flex flex-wrap gap-1 justify-end relative z-10 p-4 [background-image:radial-gradient(circle_at_top_right,_rgba(255,255,255,0.9),_rgba(255,255,255,0.1))]">
            {tags.map((tag) => (
              <Badge className="bg-teal-600">{tag}</Badge>
            ))}
          </div>
        )}

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

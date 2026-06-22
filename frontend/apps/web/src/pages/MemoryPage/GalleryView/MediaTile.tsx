import { useState } from 'react';

import { cn } from '@ci/shadcn';
import { Play } from '@ci/shadcn/icons';

import { FileIcon } from '@/components/icons';

import type { EntityMedia } from './media';

interface Props {
  media: EntityMedia;
  onClick: () => void;
}

/**
 * A visual gallery tile backed by a real thumbnail. Lazy-loads the image, marks
 * video with a play badge, reveals the title on hover, and falls back to a file
 * glyph if the thumbnail fails to load.
 */
export function MediaTile({ media, onClick }: Props) {
  const [broken, setBroken] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      title={media.title}
      aria-label={media.title}
      className={cn(
        'group relative flex h-full w-full flex-col overflow-hidden rounded-lg border border-border',
        'bg-card text-card-foreground shadow-md cursor-pointer select-none',
        'transition-shadow duration-75 hover:shadow-lg',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {!broken ? (
        <img
          src={media.thumbUrl}
          alt={media.title}
          loading="lazy"
          decoding="async"
          // Intrinsic-size hints (≈ the grid track) let the browser reserve the
          // tile box and downscale to it — important when a thumbUrl is the
          // full-resolution source (e.g. ContentType has no resized preview).
          width={240}
          height={260}
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4">
          <FileIcon className="h-10 w-10 text-muted-foreground" />
        </div>
      )}

      {media.kind === 'video' && (
        <span className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
          <Play className="h-4 w-4 fill-current" />
        </span>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent p-2 px-3 text-left text-sm text-white opacity-0 transition-opacity group-hover:opacity-100">
        {media.title}
      </div>
    </button>
  );
}

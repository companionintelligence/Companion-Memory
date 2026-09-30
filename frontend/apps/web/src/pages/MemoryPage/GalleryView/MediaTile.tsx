import { useState } from 'react';

import { Tooltip, cn } from '@ci/shadcn';
import { Music, Play } from '@ci/shadcn/icons';

import { FileIcon } from '@/components/icons';
import { PendingImage } from '@/components/PendingImage';

import { providerLabel } from './EmbedPlayer';
import type { EntityMedia } from './media';

interface Props {
  media: EntityMedia;
  onClick: () => void;
}

/**
 * A visual gallery tile backed by a real thumbnail. Lazy-loads the image, marks
 * video with a play badge, reveals the title on hover, and falls back to a file
 * glyph if the thumbnail fails to load.
 *
 * `media.thumbUrl` is null when nothing cheap enough to render exists — a
 * preview-less video (whose source an `<img>` can never decode) or an original
 * too large to serve as a thumbnail. Those draw the glyph straight away rather
 * than downloading bytes only to fail; the full media still opens on click.
 */
export function MediaTile({ media, onClick }: Props) {
  const [broken, setBroken] = useState(false);
  const showThumb = media.thumbUrl != null && !broken;
  const embed = media.kind === 'embed' ? media.player : undefined;

  return (
    <Tooltip delayDuration={600}>
      <Tooltip.Content>{media.title}</Tooltip.Content>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={media.title}
          className={cn(
            'group relative flex h-full w-full flex-col overflow-hidden rounded-lg border border-border',
            'bg-card text-card-foreground shadow-md cursor-pointer select-none',
            'transition-shadow duration-75 hover:shadow-lg',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {showThumb && media.thumbUrl ? (
            <PendingImage src={media.thumbUrl} onError={() => setBroken(true)} />
          ) : embed ? (
            // Poster-less provider (Spotify publishes none at a predictable
            // address): a provider-badged placeholder, so the tile still reads
            // as "playable" rather than as a document.
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4">
              <Music className="h-10 w-10 text-muted-foreground" />
              <span className="line-clamp-2 text-center text-xs text-muted-foreground">{media.title}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                {providerLabel(embed.provider)}
              </span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4">
              <FileIcon className="h-10 w-10 text-muted-foreground" />
              <span className="line-clamp-2 text-center text-xs text-muted-foreground">{media.title}</span>
            </div>
          )}

          {(media.kind === 'video' || embed) && (
            <span className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
              <Play className="h-4 w-4 fill-current" />
            </span>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent p-2 px-3 text-left text-sm text-white opacity-0 transition-opacity group-hover:opacity-100">
            {media.title}
          </div>
        </button>
      </Tooltip.Trigger>
    </Tooltip>
  );
}

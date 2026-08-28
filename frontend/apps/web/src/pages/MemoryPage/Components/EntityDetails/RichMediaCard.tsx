import { useState } from 'react';

import { Button } from '@ci/shadcn';
import { ExternalLink, Play } from '@ci/shadcn/icons';

import { resolveMediaUrl } from '@/components/entities/resolveMediaUrl';
import { type FragmentType, gql, useFragment } from '@/graphql';

import { EmbedPlayer, providerLabel } from '../../GalleryView/EmbedPlayer';

/**
 * The rich-media fields of a content row: the tier-0 player (a pure function
 * of its URL) and the resolved preview the `enrich.unfurl` stage cached.
 * Shared by the content drawer, the event drawer (through `contents`) and
 * anything else that wants to show what a link IS rather than its address.
 */
export const RICH_MEDIA_FRAGMENT = gql(`
  fragment RichMediaData on ContentType {
    player {
      provider
      playerUrl
      posterUrl
      aspectRatio
      mediaKind
    }
    unfurl {
      status
      resolver
      title
      authorName
      siteName
      description
      canonicalUrl
      thumbnailUrl
      durationSeconds
      payload
    }
  }
`);

interface Props {
  content: FragmentType<typeof RICH_MEDIA_FRAGMENT>;
  /** The row's own title / URL, for the caption and the link-out. */
  title?: string | null;
  url?: string | null;
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) {
    return null;
  }

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  return h ? `${h}h ${m}m` : `${m} min`;
}

/** True when the row has anything richer than its address to show. */
export function hasRichMedia(content: FragmentType<typeof RICH_MEDIA_FRAGMENT> | null | undefined): boolean {
  if (!content) {
    return false;
  }

  // `useFragment` from the client preset is a pure unmask, not a React hook.
  const data = useFragment(RICH_MEDIA_FRAGMENT, content);

  return Boolean(data.player || (data.unfurl && data.unfurl.status === 'ok'));
}

/**
 * Poster + facts + click-to-play for one content row.
 *
 * Nothing here loads a provider frame until the user asks: the poster is an
 * `<img>` (the locally cached copy when the stage made one), and the iframe
 * mounts only after the play button is pressed.
 */
export function RichMediaCard({ content, title, url }: Props) {
  const data = useFragment(RICH_MEDIA_FRAGMENT, content);
  const [playing, setPlaying] = useState(false);
  const unfurl = data.unfurl?.status === 'ok' ? data.unfurl : null;
  const player = data.player ? { ...data.player, posterUrl: data.player.posterUrl ?? null } : null;

  if (!player && !unfurl) {
    return null;
  }

  const poster = resolveMediaUrl(unfurl?.thumbnailUrl) ?? player?.posterUrl ?? null;
  const heading = unfurl?.title ?? title ?? null;
  const payload = (unfurl?.payload ?? {}) as Record<string, unknown>;
  const year = typeof payload.year === 'number' ? payload.year : null;
  const season = typeof payload.season === 'number' ? payload.season : null;
  const episode = typeof payload.episode === 'number' ? payload.episode : null;
  const episodeTitle = typeof payload.episode_title === 'string' ? payload.episode_title : null;
  const pageUrl = url ?? unfurl?.canonicalUrl ?? null;
  const source = player ? providerLabel(player.provider) : (unfurl?.siteName ?? null);
  const facts = [
    unfurl?.authorName,
    year ? String(year) : null,
    season != null || episode != null ? `S${season ?? '?'}${episode != null ? ` E${episode}` : ''}` : null,
    formatDuration(unfurl?.durationSeconds),
  ].filter((f): f is string => Boolean(f));

  return (
    // `shrink-0` — the scaffold renders this inside a `min-h-0 flex-1 flex-col
    // overflow-y-auto` body; without it a short viewport squeezes the card
    // (poster and text alike) instead of scrolling, the same bug EntityMedia had.
    <div className="shrink-0 overflow-hidden rounded-lg border border-border bg-card">
      {player && playing ? (
        <EmbedPlayer player={player} title={heading ?? 'Player'} />
      ) : poster ? (
        <div
          className="relative bg-black/5"
          style={{ aspectRatio: player ? String(player.aspectRatio) : undefined }}
        >
          <img
            src={poster}
            alt={heading ?? ''}
            className="mx-auto max-h-72 w-full object-contain"
            loading="lazy"
            decoding="async"
          />
          {player && (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              aria-label={`Play on ${source ?? 'provider'}`}
              className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors hover:bg-black/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm">
                <Play className="h-5 w-5 fill-current" />
              </span>
            </button>
          )}
        </div>
      ) : player ? (
        <Button variant="secondary" className="m-3" onClick={() => setPlaying(true)}>
          <Play className="mr-2 h-4 w-4 fill-current" /> Play on {source}
        </Button>
      ) : null}

      <div className="space-y-1 p-3">
        {heading && <p className="text-sm font-medium leading-snug">{heading}</p>}
        {episodeTitle && <p className="text-xs text-muted-foreground">{episodeTitle}</p>}
        {facts.length > 0 && <p className="text-xs text-muted-foreground">{facts.join(' · ')}</p>}
        {unfurl?.description && (
          <p className="line-clamp-4 text-xs text-muted-foreground">{unfurl.description}</p>
        )}
        {pageUrl && (
          <a
            href={pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Open on {source ?? 'source'} <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

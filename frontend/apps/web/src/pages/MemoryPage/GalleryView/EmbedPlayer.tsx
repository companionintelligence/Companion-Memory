import type { EmbedPlayer as EmbedPlayerModel } from './media';

interface Props {
  player: EmbedPlayerModel;
  title: string;
  /**
   * Size the box to the viewport: as wide as 92vw allows, but never taller
   * than 82vh, so a square Spotify card and a 16:9 video both fit on the
   * lightbox stage without scrolling. Without it the box fills its parent.
   */
  fitViewport?: boolean;
  className?: string;
}

/**
 * Mounts a provider's own player in an iframe sized to its aspect ratio.
 *
 * Only ever rendered after an explicit user gesture (the lightbox opens on a
 * tile click) — this is what keeps the gallery free of provider requests until
 * the user asks for one. No `sandbox`: a cross-origin frame is already
 * origin-isolated, and `allow-scripts allow-same-origin` would only strip the
 * popup/storage access YouTube's and Spotify's controls rely on.
 * `referrerpolicy="origin"`: the provider sees only the scheme and host
 * (`https://<stack>.localhost/`), never the path, so which entity or page was
 * open stays private. NOT `no-referrer` — YouTube's player refuses to start
 * without a Referer to validate the embed against ("Error 153 – Video player
 * configuration error"), and the origin is the least it accepts.
 */
export function EmbedPlayer({ player, title, fitViewport = false, className }: Props) {
  const ar = player.aspectRatio;
  const style = fitViewport
    ? { aspectRatio: String(ar), width: `min(92vw, calc(82vh * ${ar}), 960px)` }
    : { aspectRatio: String(ar) };

  return (
    <div className={className} style={style}>
      <iframe
        key={player.playerUrl}
        src={player.playerUrl}
        title={title}
        loading="lazy"
        referrerPolicy="origin"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write"
        allowFullScreen
        className="h-full w-full rounded-lg border-0 bg-black"
      />
    </div>
  );
}

/** Human provider name for badges and captions. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case 'youtube':
      return 'YouTube';
    case 'spotify':
      return 'Spotify';
    case 'vimeo':
      return 'Vimeo';
    case 'soundcloud':
      return 'SoundCloud';
    case 'dailymotion':
      return 'Dailymotion';
    default:
      return provider;
  }
}

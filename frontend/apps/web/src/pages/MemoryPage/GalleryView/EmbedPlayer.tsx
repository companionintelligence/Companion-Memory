import { isNativePlatform, openLinkOutsideApp } from '@ci/common';
import { ExternalLink } from '@ci/shadcn/icons';

import type { EmbedPlayer as EmbedPlayerModel } from './media';

/**
 * Whether provider players open outside the app instead of in an iframe.
 *
 * True in the iOS and Android apps. Android runs Capacitor's legacy bridge
 * (`frontend/apps/android/capacitor.config.ts`, kept because background
 * location stalls without it), which hands every frame, cross-origin ones
 * included, the means to call the app's native plugins. A provider player is
 * script from YouTube, Spotify and the rest, plus whatever ads they load, so
 * the phone apps never mount one. iOS follows the same rule so the two apps
 * behave alike.
 */
export function embedsOpenExternally(): boolean {
  return isNativePlatform();
}

/**
 * Open a provider's player outside the app (the browser, or the provider's own app): the
 * content's own page when it is a plain http(s) address, otherwise the server-built player
 * URL. Not through the sign-in Auth Tab on Android; see {@link openLinkOutsideApp}.
 */
export function openEmbedExternally(player: EmbedPlayerModel, pageUrl?: string | null): void {
  const target = pageUrl && /^https?:\/\//i.test(pageUrl) ? pageUrl : player.playerUrl;

  void openLinkOutsideApp(target).catch(() => {
    // Nothing to fall back to inside the app; the tap simply does nothing.
  });
}

interface Props {
  player: EmbedPlayerModel;
  title: string;
  /** The content's own page, opened instead of the player on the phone apps. */
  pageUrl?: string | null;
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
 * In the phone apps it renders no iframe at all, only a button that opens the
 * provider outside the app; see {@link embedsOpenExternally}.
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
export function EmbedPlayer({ player, title, pageUrl, fitViewport = false, className }: Props) {
  const ar = player.aspectRatio;
  const style = fitViewport
    ? { aspectRatio: String(ar), width: `min(92vw, calc(82vh * ${ar}), 960px)` }
    : { aspectRatio: String(ar) };

  if (embedsOpenExternally()) {
    return (
      <div
        className={`${className ?? ''} relative flex items-center justify-center overflow-hidden rounded-lg bg-black`}
        style={style}
      >
        {player.posterUrl && (
          <img
            src={player.posterUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-60"
          />
        )}
        <button
          type="button"
          onClick={() => openEmbedExternally(player, pageUrl)}
          className="relative inline-flex items-center gap-2 rounded-md bg-black/70 px-4 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open in {providerLabel(player.provider)} <ExternalLink className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

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

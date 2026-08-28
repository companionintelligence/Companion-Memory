/**
 * Tier-0 embed derivation (docs/prd/unified-content-identity-lifecycle-embeds.md §6).
 *
 * A pure function of a provider handle — `youtube:video:ID`,
 * `spotify:track:ID` — to the provider's hosted player URL and, where the
 * provider publishes one at a predictable address, a poster image. Nothing
 * here touches the network or a table: the appliance makes zero requests on
 * the user's behalf, and the browser only loads the poster/player when the
 * gallery decides to (poster on view, player on click).
 *
 * Provider handles come from `domains/identity` (`canonicalizeUrl(url).providerRef`),
 * so a content row's `url` is all that is needed. Adding a provider means
 * adding a case here AND a rule in `identity/providers.ts` that mints its
 * handle — one without the other is dead code.
 */
import { canonicalizeUrl } from '../identity';

export interface StructuralPlayer {
  /** Extractor name, e.g. `youtube` — what the UI badges the tile with. */
  provider: string;
  /** Stable handle, e.g. `youtube:video:dQw4w9WgXcQ`. */
  providerRef: string;
  /** Iframe `src` for the provider's own player. */
  playerUrl: string;
  /** Remote poster image when the provider serves one at a predictable address. */
  posterUrl?: string;
  /** width / height the player expects; the UI reserves this box before load. */
  aspectRatio: number;
  /** Human label for the thing behind the handle (video, track, album…). */
  mediaKind: 'video' | 'audio' | 'playlist';
}

const SIXTEEN_NINE = 16 / 9;
/** Spotify's compact player is 352×152; its full card is square. */
const SPOTIFY_COMPACT = 352 / 152;

/** Audio-first Spotify types get the compact bar; collections get the card. */
const SPOTIFY_SINGLE = new Set(['track', 'episode']);
const SPOTIFY_COLLECTION = new Set(['album', 'playlist', 'artist', 'show']);

export function derivePlayerFromRef(providerRef: string | null | undefined): StructuralPlayer | null {
  if (!providerRef) {
    return null;
  }

  const firstColon = providerRef.indexOf(':');
  const secondColon = providerRef.indexOf(':', firstColon + 1);
  if (firstColon < 0 || secondColon < 0) {
    return null;
  }

  const provider = providerRef.slice(0, firstColon);
  const type = providerRef.slice(firstColon + 1, secondColon);
  const id = providerRef.slice(secondColon + 1);
  if (!id) {
    return null;
  }

  switch (provider) {
    case 'youtube': {
      if (type === 'video') {
        return {
          provider,
          providerRef,
          playerUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
          // hqdefault, NOT maxresdefault: maxres 404s for sub-720p uploads and
          // tier 0 cannot check. hqdefault exists for every video.
          posterUrl: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`,
          aspectRatio: SIXTEEN_NINE,
          mediaKind: 'video',
        };
      }

      if (type === 'playlist') {
        return {
          provider,
          providerRef,
          playerUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}`,
          aspectRatio: SIXTEEN_NINE,
          mediaKind: 'playlist',
        };
      }

      // Channels have no embeddable player.
      return null;
    }

    case 'spotify': {
      if (!SPOTIFY_SINGLE.has(type) && !SPOTIFY_COLLECTION.has(type)) {
        return null;
      }

      return {
        provider,
        providerRef,
        playerUrl: `https://open.spotify.com/embed/${type}/${encodeURIComponent(id)}`,
        aspectRatio: SPOTIFY_SINGLE.has(type) ? SPOTIFY_COMPACT : 1,
        mediaKind: SPOTIFY_SINGLE.has(type) ? 'audio' : 'playlist',
      };
    }

    case 'vimeo': {
      if (type !== 'video') {
        return null;
      }

      return {
        provider,
        providerRef,
        playerUrl: `https://player.vimeo.com/video/${encodeURIComponent(id)}?dnt=1`,
        aspectRatio: SIXTEEN_NINE,
        mediaKind: 'video',
      };
    }

    case 'dailymotion': {
      if (type !== 'video') {
        return null;
      }

      return {
        provider,
        providerRef,
        playerUrl: `https://www.dailymotion.com/embed/video/${encodeURIComponent(id)}`,
        aspectRatio: SIXTEEN_NINE,
        mediaKind: 'video',
      };
    }

    case 'soundcloud': {
      // The widget takes the public page URL; the handle is `artist/slug`
      // (track) or `artist/set-slug` (set), both path-shaped.
      if (type !== 'track' && type !== 'set') {
        return null;
      }

      const path = type === 'set' ? id.replace('/', '/sets/') : id;
      const page = `https://soundcloud.com/${path}`;

      return {
        provider,
        providerRef,
        playerUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(page)}&visual=true&show_teaser=false`,
        aspectRatio: 1,
        mediaKind: type === 'set' ? 'playlist' : 'audio',
      };
    }

    default:
      // x (tweets) and every unknown provider: no script-free iframe player.
      return null;
  }
}

/** The player for a content row's `url`, if its provider has one. */
export function derivePlayer(url: string | null | undefined): StructuralPlayer | null {
  const canonical = canonicalizeUrl(url);

  return derivePlayerFromRef(canonical?.providerRef);
}

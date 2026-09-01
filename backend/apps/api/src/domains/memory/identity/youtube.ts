import { platformIdentity } from './registry';
import type { SourceIdentity } from './types';

/**
 * YouTube platform-kind identities (docs/design/cross-pipeline-identity.md
 * §3.2): the id is `<kind>:<native id>` under the canonical `youtube` system,
 * minted here for BOTH pipelines. The YouTube Data API and a Takeout export
 * name the same videos and channels by the same native ids, so a like or
 * subscription converges whenever the id is actually present — which it is on
 * both sides (the API responds with ids; Takeout's My Activity carries the
 * watch URL and subscriptions.csv carries the channel id). A real run showed
 * 100% duplication of the overlap purely because the importer hashed the URL
 * instead of extracting the id, and the two sides used different prefixes
 * (`youtube:sub:` vs `subscription:`).
 */

/** The video id inside any of YouTube's URL shapes, or null when absent. */
export function youtubeVideoIdFromUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  const match =
    url.match(/[?&]v=([\w-]{6,})/) ?? url.match(/youtu\.be\/([\w-]{6,})/) ?? url.match(/\/shorts\/([\w-]{6,})/);

  return match ? match[1] : null;
}

/** A liked video — one identity per video, however many times it was (re)liked. */
export function youtubeLikeIdentity(videoId: string): SourceIdentity {
  return platformIdentity('youtube', 'like', videoId);
}

/** A channel subscription. */
export function youtubeSubscriptionIdentity(channelId: string): SourceIdentity {
  return platformIdentity('youtube', 'subscription', channelId);
}

/** An uploaded video (the user's own). */
export function youtubeUploadIdentity(videoId: string): SourceIdentity {
  return platformIdentity('youtube', 'upload', videoId);
}

/** A playlist. */
export function youtubePlaylistIdentity(playlistId: string): SourceIdentity {
  return platformIdentity('youtube', 'playlist', playlistId);
}

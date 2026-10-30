import * as crypto from 'crypto';

import { platformIdentity } from './registry';
import type { SourceIdentity } from './types';

/**
 * Facebook post identity — a fallback-tier TUPLE key, deliberately
 * (docs/design/cross-pipeline-identity.md §3.5): the Meta archive does not
 * carry Graph post ids, so no exact native key exists across the pipelines.
 * What both sides DO share is the posting instant (second precision in the
 * API's `created_time` and the export's timestamp) and the post text, so the
 * key is `post:<epoch-seconds>:<16 hex of sha1(normalized text)>`.
 *
 * Honest limits, all accepted: an edited post changes its hash (the copies
 * stop converging), and a link-share whose API `story` differs from the
 * export's rendering converges only when the visible text happens to match.
 * A same-second pair of DIFFERENT posts stays distinct — that is what the
 * text hash is for; the timestamp alone was rejected because bursts of posts
 * in one second are real (observed in this user's own 2018 share burst).
 */

/** Whitespace-insensitive text normalization shared by both pipelines. */
function normalizedPostText(text: string | null | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ');
}

export function facebookPostIdentity(postedAt: Date, text: string | null | undefined): SourceIdentity {
  const epochSeconds = Math.floor(postedAt.getTime() / 1000);
  const textHash = crypto.createHash('sha1').update(normalizedPostText(text)).digest('hex').slice(0, 16);

  return platformIdentity('facebook', 'post', String(epochSeconds), textHash);
}

/**
 * Liked-Page identity — `like:<page id>`, an exact native key. The Graph API's
 * `/me/likes` gives the Page id outright, and the Meta archive carries it as
 * the path of the Page's link (`https://www.facebook.com/<page id>`), so the
 * two pipelines converge on one row per liked Page.
 */
export function facebookPageLikeId(pageId: string): string {
  return `like:${pageId}`;
}

export function facebookPageLikeIdentity(pageId: string): SourceIdentity {
  return platformIdentity('facebook', facebookPageLikeId(pageId));
}

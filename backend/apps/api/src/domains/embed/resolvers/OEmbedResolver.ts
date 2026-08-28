import type { ResolveTarget } from '../resolveKey';
import { MAX_JSON_BYTES, type UnfurlFetcher } from '../services/UnfurlFetcher';

import {
  httpUrl,
  str,
  statusOutcome,
  type UnfurlData,
  type UnfurlOutcome,
  type UnfurlResolver,
} from './types';

/**
 * Public, unauthenticated oEmbed endpoints, keyed by the identity domain's
 * provider name. Each takes the page URL and answers title / author /
 * thumbnail (and, for some, duration and description) as JSON.
 */
export const OEMBED_ENDPOINTS: Readonly<Record<string, (pageUrl: string) => string>> = {
  youtube: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  spotify: (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}`,
  vimeo: (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`,
  soundcloud: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  dailymotion: (u) => `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent(u)}`,
  x: (u) => `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(u)}`,
};

/** The oEmbed fields worth keeping, from a parsed JSON body. */
export function dataFromOEmbed(json: Record<string, unknown>, pageUrl: string): UnfurlData {
  const duration = typeof json.duration === 'number' ? Math.round(json.duration) : undefined;
  const payload: Record<string, unknown> = {};
  for (const key of [
    'type',
    'provider_name',
    'thumbnail_width',
    'thumbnail_height',
    'width',
    'height',
    'upload_date',
  ]) {
    if (json[key] !== undefined) {
      payload[key] = json[key];
    }
  }

  return {
    title: str(json.title, 500),
    authorName: str(json.author_name, 200),
    authorUrl: httpUrl(json.author_url),
    siteName: str(json.provider_name, 100),
    description: str(json.description),
    canonicalUrl: pageUrl,
    thumbnailUrl: httpUrl(json.thumbnail_url),
    durationSeconds: duration && duration > 0 ? duration : undefined,
    payload,
  };
}

export class OEmbedResolver implements UnfurlResolver {
  async resolve(target: ResolveTarget, fetcher: UnfurlFetcher): Promise<UnfurlOutcome> {
    const provider = target.providerRef?.split(':')[0];
    const endpoint = provider ? OEMBED_ENDPOINTS[provider] : undefined;
    if (!endpoint || !target.url) {
      return { status: 'not_embeddable', detail: 'no_oembed_endpoint' };
    }

    const res = await fetcher.get(endpoint(target.url), {
      accept: 'application/json',
      maxBytes: MAX_JSON_BYTES,
    });
    switch (res.kind) {
      case 'blocked':
        return { status: 'blocked' };
      case 'timeout':
        return { status: 'transport_error', detail: 'timeout' };
      case 'transport':
        return { status: 'transport_error', detail: res.error };
      case 'too_large':
        return { status: 'transport_error', detail: 'too_large' };
      case 'status':
        return statusOutcome(res.status);
      case 'ok':
        break;
    }

    let json: unknown;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch {
      return { status: 'transport_error', detail: 'invalid_json' };
    }

    if (!json || typeof json !== 'object') {
      return { status: 'transport_error', detail: 'invalid_json' };
    }

    const data = dataFromOEmbed(json as Record<string, unknown>, target.url);
    if (!data.title && !data.thumbnailUrl) {
      // Spotify answers 200 with an empty title for a delisted track; YouTube
      // 404s. Both mean the same thing, and a hollow `ok` would be cached for
      // a month as if it were an answer.
      return { status: 'not_found', detail: 'empty_oembed' };
    }

    return { status: 'ok', data };
  }
}

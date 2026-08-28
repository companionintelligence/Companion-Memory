import type { ResolveTarget } from '../resolveKey';
import { MAX_HTML_BYTES, MAX_JSON_BYTES, type UnfurlFetcher } from '../services/UnfurlFetcher';

import { dataFromOEmbed } from './OEmbedResolver';
import {
  httpUrl,
  str,
  statusOutcome,
  type UnfurlData,
  type UnfurlOutcome,
  type UnfurlResolver,
} from './types';

const META_RE = /<meta\b[^>]*>/gi;
const LINK_RE = /<link\b[^>]*>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const ATTR_RE = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }

  return out;
}

export interface ParsedHead {
  meta: Map<string, string>;
  title?: string;
  oembedHref?: string;
}

/** Pulls OpenGraph / Twitter / standard meta out of the <head> of an HTML page. */
export function parseHead(html: string, baseUrl: string): ParsedHead {
  // Only the head matters, and a truncated body must not poison it.
  const headEnd = html.search(/<\/head>|<body\b/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html;
  const meta = new Map<string, string>();

  for (const tag of head.match(META_RE) ?? []) {
    const a = attrs(tag);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    const value = a.content;
    if (key && value && !meta.has(key)) {
      meta.set(key, value);
    }
  }

  let oembedHref: string | undefined;
  for (const tag of head.match(LINK_RE) ?? []) {
    const a = attrs(tag);
    if (
      (a.rel ?? '').toLowerCase() === 'alternate' &&
      (a.type ?? '').toLowerCase() === 'application/json+oembed' &&
      a.href
    ) {
      try {
        oembedHref = new URL(a.href, baseUrl).toString();
      } catch {
        /* ignore */
      }

      break;
    }
  }

  const titleMatch = TITLE_RE.exec(head);

  return { meta, title: titleMatch ? str(decode(titleMatch[1]), 500) : undefined, oembedHref };
}

export function dataFromHead(head: ParsedHead, pageUrl: string): UnfurlData {
  const m = head.meta;
  const get = (...keys: string[]) => keys.map((k) => m.get(k)).find((v) => v);
  const image = httpUrl(
    resolveMaybe(get('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'), pageUrl),
  );
  const durationRaw = get('og:video:duration', 'music:duration', 'video:duration');
  const duration = durationRaw ? Number.parseInt(durationRaw, 10) : NaN;

  return {
    title: str(get('og:title', 'twitter:title') ?? head.title, 500),
    description: str(get('og:description', 'twitter:description', 'description')),
    siteName: str(get('og:site_name'), 100),
    authorName: str(get('author', 'article:author', 'music:musician', 'twitter:creator'), 200),
    canonicalUrl: httpUrl(get('og:url')) ?? pageUrl,
    thumbnailUrl: image,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    payload: {
      og_type: get('og:type'),
      image_width: get('og:image:width'),
      image_height: get('og:image:height'),
    },
  };
}

function resolveMaybe(v: string | undefined, base: string): string | undefined {
  if (!v) {
    return undefined;
  }

  try {
    return new URL(v, base).toString();
  } catch {
    return undefined;
  }
}

export class OpenGraphResolver implements UnfurlResolver {
  async resolve(target: ResolveTarget, fetcher: UnfurlFetcher): Promise<UnfurlOutcome> {
    if (!target.url) {
      return { status: 'not_embeddable', detail: 'no_url' };
    }

    const res = await fetcher.get(target.url, { maxBytes: MAX_HTML_BYTES });
    switch (res.kind) {
      case 'blocked':
        return { status: 'blocked' };
      case 'timeout':
        return { status: 'transport_error', detail: 'timeout' };
      case 'transport':
        return { status: 'transport_error', detail: res.error };
      case 'too_large':
        return { status: 'not_embeddable', detail: 'too_large' };
      case 'status':
        return statusOutcome(res.status);
      case 'ok':
        break;
    }

    if (!res.contentType.includes('html') && !res.contentType.includes('xml')) {
      // A direct image/PDF/etc. — nothing to unfurl, but the URL itself is the media.
      return res.contentType.startsWith('image/')
        ? { status: 'ok', data: { thumbnailUrl: res.url, canonicalUrl: res.url } }
        : { status: 'not_embeddable', detail: `content_type:${res.contentType.split(';')[0]}` };
    }

    const head = parseHead(res.body.toString('utf8'), res.url);
    let data = dataFromHead(head, res.url);

    // oEmbed discovery: a site that advertises an endpoint usually answers
    // with a better title/author/thumbnail than its meta tags carry.
    if (head.oembedHref) {
      const oe = await fetcher.get(head.oembedHref, { accept: 'application/json', maxBytes: MAX_JSON_BYTES });
      if (oe.kind === 'ok') {
        try {
          const json = JSON.parse(oe.body.toString('utf8')) as Record<string, unknown>;
          const fromOEmbed = dataFromOEmbed(json, res.url);
          data = {
            ...data,
            ...Object.fromEntries(Object.entries(fromOEmbed).filter(([, v]) => v !== undefined && v !== '')),
            payload: { ...data.payload, ...fromOEmbed.payload, oembed_discovered: true },
          };
        } catch {
          /* keep the OG data */
        }
      }
    }

    if (!data.title && !data.thumbnailUrl && !data.description) {
      return { status: 'not_embeddable', detail: 'no_metadata' };
    }

    return { status: 'ok', data };
  }
}

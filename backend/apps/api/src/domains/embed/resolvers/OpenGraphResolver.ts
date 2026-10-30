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

/**
 * How much of a page the head scan reads, in characters.
 *
 * The fetch already stops at {@link MAX_HTML_BYTES}; this is the second bound,
 * on the parse, so its cost never depends on what a remote server chose to send.
 * The scans below are linear, so this is about a ceiling, not about speed. It
 * equals the fetch cap, so every page that got a card before still gets one: a
 * head with 150 KB of inline styles or JSON-LD before its og: tags is common.
 */
export const MAX_HEAD_SCAN_CHARS = MAX_HTML_BYTES;

/**
 * One `name=value` pair inside a tag.
 *
 * The lookbehind lets a match start only at the beginning of a run of name
 * characters. Without it, a long run with no `=` after it was retried from
 * every position inside it, each retry scanning to the end of the run: quadratic
 * in the length of one tag, and a tag can be the whole head. A match that starts
 * mid-run could only ever succeed where the run's own start succeeds, so this
 * changes no result.
 */
const ATTR_RE = /(?<![a-zA-Z:_-])([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** ASCII word characters, which is what `\b` tests in a non-unicode regex. */
function isWordCharCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
  );
}

/**
 * Every `<name …>` tag in `html`, in order: what `/<name\b[^>]*>/gi` matched,
 * found in one forward pass.
 *
 * That regex was quadratic on a page with many `<meta` openings and no `>`:
 * each opening scanned to the end of the input before failing, and the next
 * opening did it again. Here, an opening with no `>` after it ends the scan,
 * because no later opening can have one either.
 */
function tagsNamed(html: string, name: string): string[] {
  const opening = new RegExp(`<${name}`, 'gi');
  const tags: string[] = [];

  for (let match = opening.exec(html); match; match = opening.exec(html)) {
    const afterName = match.index + match[0].length;

    // `\b`: `<metadata>` is not a `<meta>` tag.
    if (afterName < html.length && isWordCharCode(html.charCodeAt(afterName))) {
      continue;
    }

    const close = html.indexOf('>', afterName);

    if (close === -1) {
      break;
    }

    tags.push(html.slice(match.index, close + 1));
    opening.lastIndex = close + 1;
  }

  return tags;
}

/**
 * The text of the first `<title>` element, as `/<title[^>]*>([\s\S]*?)<\/title>/i`
 * captured it, without retrying the lazy scan from every later `<title`. Only
 * the first opening can match: if it has no `>` or no `</title>` after it, no
 * later opening does either.
 */
function firstTitle(html: string): string | undefined {
  const opening = /<title/i.exec(html);

  if (!opening) {
    return undefined;
  }

  const textStart = html.indexOf('>', opening.index + opening[0].length) + 1;

  if (textStart === 0) {
    return undefined;
  }

  const closing = /<\/title>/gi;
  closing.lastIndex = textStart;
  const end = closing.exec(html);

  return end ? html.slice(textStart, end.index) : undefined;
}

/**
 * The character a numeric reference names. `String.fromCodePoint` throws a
 * RangeError past U+10FFFF, so one `&#99999999;` in a remote page's og:title
 * used to fail the whole unfurl; HTML reads such a reference as U+FFFD.
 */
function fromCodePoint(codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '�';
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => fromCodePoint(Number.parseInt(n, 16)));
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
  const scanned = html.length > MAX_HEAD_SCAN_CHARS ? html.slice(0, MAX_HEAD_SCAN_CHARS) : html;
  // Only the head matters, and a truncated body must not poison it.
  const headEnd = scanned.search(/<\/head>|<body\b/i);
  const head = headEnd > 0 ? scanned.slice(0, headEnd) : scanned;
  const meta = new Map<string, string>();

  for (const tag of tagsNamed(head, 'meta')) {
    const a = attrs(tag);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    const value = a.content;
    if (key && value && !meta.has(key)) {
      meta.set(key, value);
    }
  }

  let oembedHref: string | undefined;
  for (const tag of tagsNamed(head, 'link')) {
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

  const title = firstTitle(head);

  return { meta, title: title !== undefined ? str(decode(title), 500) : undefined, oembedHref };
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

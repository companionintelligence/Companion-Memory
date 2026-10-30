import { MAX_HEAD_SCAN_CHARS, parseHead, type ParsedHead } from '../resolvers/OpenGraphResolver';
import { str } from '../resolvers/types';
import { MAX_HTML_BYTES } from '../services/UnfurlFetcher';

/**
 * The head parser as it stood before the scan was made linear, kept verbatim as
 * the reference the new one must agree with. Its regexes are quadratic, so it is
 * only ever run on short inputs here.
 */
function referenceParseHead(html: string, baseUrl: string): ParsedHead {
  const META_RE = /<meta\b[^>]*>/gi;
  const LINK_RE = /<link\b[^>]*>/gi;
  const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
  const ATTR_RE = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  const decode = (s: string): string =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
  const attrs = (tag: string): Record<string, string> => {
    const out: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(tag)) !== null) {
      out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
    }

    return out;
  };

  const headEnd = html.search(/<\/head>|<body\b/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html;
  const meta = new Map<string, string>();

  for (const tag of head.match(META_RE) ?? []) {
    const a = attrs(tag);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content && !meta.has(key)) {
      meta.set(key, a.content);
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

/** Deterministic PRNG so a failure reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;

    return state / 2 ** 32;
  };
}

const PIECES = [
  '<meta',
  '<META',
  '<meta ',
  '<metadata ',
  '<link',
  '<LINK ',
  '<title>',
  '<TITLE x>',
  '</title>',
  '</TITLE>',
  '<head>',
  '</head>',
  '<body>',
  '>',
  ' ',
  '\n',
  '"',
  "'",
  '=',
  'property',
  'name',
  'content',
  'og:title',
  'og:image',
  'description',
  'rel',
  'alternate',
  'type',
  'application/json+oembed',
  'href',
  '/oembed',
  'Hello',
  '&amp;',
  '&#39;',
  'data-x',
  'a',
];

function randomHtml(next: () => number, pieces: number): string {
  return Array.from({ length: pieces }, () => PIECES[Math.floor(next() * PIECES.length)]).join('');
}

function elapsedMs(run: () => unknown): number {
  const started = process.hrtime.bigint();
  run();

  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** Enough to fill the fetch cap, which is what a hostile page sends. */
function fill(unit: string): string {
  return unit.repeat(Math.ceil(MAX_HTML_BYTES / unit.length)).slice(0, MAX_HTML_BYTES);
}

describe('parseHead', () => {
  it('reads exactly what the regex version read, on generated pages', () => {
    const next = prng(20_261_006);

    for (let i = 0; i < 4_000; i++) {
      const html = randomHtml(next, 1 + Math.floor(next() * 60));
      const expected = referenceParseHead(html, 'https://example.com/page');
      const actual = parseHead(html, 'https://example.com/page');

      expect({ html, meta: [...actual.meta], oembedHref: actual.oembedHref, title: actual.title }).toEqual({
        html,
        meta: [...expected.meta],
        oembedHref: expected.oembedHref,
        title: expected.title,
      });
    }
  });

  it('reads a real page the same way', () => {
    const page = `<!doctype html><html><head>
      <TITLE lang="en">Fallback &amp; Title</TITLE>
      <meta property="og:title" content="People running backwards" />
      <meta content='A gif' property='og:description'>
      <meta name=twitter:image content=/img/t.png>
      <metadata property="og:title" content="not a meta tag">
      <link rel="alternate" type="application/json+oembed" href="/oembed?x=1">
      </head><body><meta property="og:image" content="BODY"></body></html>`;

    expect(parseHead(page, 'https://example.com/a')).toEqual(
      referenceParseHead(page, 'https://example.com/a'),
    );
    expect(parseHead(page, 'https://example.com/a').meta.get('twitter:image')).toBe('/img/t.png');
  });

  it('stays linear on pages built to make the old regexes backtrack', () => {
    const hostile = [
      fill('<meta '),
      fill('<link '),
      fill('<title>'),
      fill('<TiTlE '),
      `<meta ${fill('a')}`,
      `<meta ${fill('a ')}>`,
      `<meta ${fill('a="')}>`,
      // One closed tag holding a long attribute name with no `=`: quadratic in
      // the old attribute pattern (about 2 s at this size), linear now.
      `<meta ${'a'.repeat(40_000)}>`,
      `<meta a="${fill("b='")}>`,
    ];

    for (const html of hostile) {
      // The regex version took 6 to 15 s on the first four. Linear work over
      // 256 KB is a few milliseconds; the bound only has to separate the two.
      expect(elapsedMs(() => parseHead(html, 'https://example.com/'))).toBeLessThan(500);
    }
  });

  it('ignores whatever comes after the scan limit', () => {
    const padding = `<meta name="filler" content="${'x'.repeat(MAX_HEAD_SCAN_CHARS)}">`;
    const html = `<html><head>${padding}<meta property="og:title" content="Too late"></head></html>`;

    expect(parseHead(html, 'https://example.com/').meta.has('og:title')).toBe(false);
  });

  it('reads a numeric reference past U+10FFFF as U+FFFD instead of throwing', () => {
    const html =
      '<head><meta property="og:title" content="A&#99999999;B&#x110000;C&#x41;"><title>&#9999999999;</title></head>';
    const head = parseHead(html, 'https://example.com/');

    expect(head.meta.get('og:title')).toBe('A�B�CA');
    expect(head.title).toBe('�');
  });
});

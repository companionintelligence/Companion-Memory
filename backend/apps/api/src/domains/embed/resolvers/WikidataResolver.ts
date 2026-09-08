import type { ResolveTarget } from '../resolveKey';
import { MAX_JSON_BYTES, type FetchOutcome, type UnfurlFetcher } from '../services/UnfurlFetcher';
import { normalizeWorkTitle, type StreamingWork } from '../streamingTitle';
import { watchLinksFor } from '../watchLinks';

import { str, statusOutcome, type UnfurlData, type UnfurlOutcome, type UnfurlResolver } from './types';

/**
 * Netflix / Prime Video titles → the work on Wikidata (CC0) + its English
 * Wikipedia article (CC BY-SA text, linked as attribution).
 *
 * No key, no licence fee, commercially clean — the trade is poster coverage:
 * only freely licensed images on Wikimedia Commons are used (`P3383` poster,
 * `P18` image, `P154` logo). Wikipedia's own article posters are mostly
 * fair-use uploads under `/wikipedia/en/`, and those are deliberately NOT
 * taken, so many works resolve with metadata and no picture.
 *
 * Finding the work is the hard part. Wikidata's own search is a label-prefix
 * match ranked by popularity ("Dark" → a surname, a video game, a nebula…),
 * so the lookup goes through English Wikipedia's naming convention first —
 * `Title (TV series)`, `Title (miniseries)`, `Title (film)`, bare `Title` —
 * then its full-text search, and every candidate is gated on Wikidata's
 * `instance of` (P31) so a disambiguation page or a novel never wins.
 */

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_FILE = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const POSTER_WIDTH = 500;

/** P31 values that make an item a television work. */
const TV_CLASSES = new Set([
  'Q5398426', // television series
  'Q1259759', // miniseries
  'Q15416', // television program
  'Q63952888', // animated television series
  'Q117467246', // anime television series
  'Q581714', // animated series
  'Q7725310', // series of creative works
  'Q21188110', // web series
  'Q24856', // film series (a boxed set watched as one "show")
  'Q1366112', // television special
]);

/** P31 values that make an item a film or special. */
const FILM_CLASSES = new Set([
  'Q11424', // film
  'Q24862', // short film
  'Q93204', // documentary film
  'Q506240', // television film
  'Q202866', // animated film
  'Q29168811', // animated feature film
  'Q1261214', // comedy special
  'Q226730', // silent film
  'Q20667187', // concert film
  'Q24869', // feature film
  'Q1366112', // television special
]);

const DISAMBIGUATION = 'Q4167410';

interface WikipediaPage {
  title: string;
  qid?: string;
  missing?: boolean;
}

interface WikidataEntity {
  id: string;
  label?: string;
  description?: string;
  enwiki?: string;
  classes: string[];
  image?: string;
  poster?: string;
  logo?: string;
  start?: string;
  imdb?: string;
  episodes?: number;
  seasons?: number;
  durationMinutes?: number;
  /** Streaming providers' catalogue ids (see ../watchLinks.ts). */
  huluSeries?: string;
  huluMovie?: string;
  netflix?: string;
  primeVideo?: string;
  disneyPlusBrowse?: string;
  disneyPlusSeries?: string;
  disneyPlusMovie?: string;
}

type Fail = Exclude<UnfurlOutcome, { status: 'ok' }>;

type OkFetch = Extract<FetchOutcome, { kind: 'ok' }>;

function failFrom(res: FetchOutcome): Fail | null {
  switch (res.kind) {
    case 'ok':
      return null;
    case 'blocked':
      return { status: 'blocked' };
    case 'timeout':
      return { status: 'transport_error', detail: 'timeout' };
    case 'transport':
      return { status: 'transport_error', detail: res.error };
    case 'too_large':
      return { status: 'transport_error', detail: 'too_large' };
    case 'status':
      return statusOutcome(res.status) as Fail;
  }
}

/** Wikipedia article titles the naming convention would give this work. */
export function candidateTitles(work: StreamingWork): string[] {
  const t = work.title;
  const tv = [`${t} (TV series)`, `${t} (miniseries)`, `${t} (television series)`, `${t} (web series)`];
  const film = [`${t} (film)`, `${t} (special)`];

  return [...(work.kind === 'tv' ? tv : film), t, ...(work.kind === 'tv' ? film : tv)];
}

export function classifyEntity(e: WikidataEntity): 'tv' | 'movie' | 'other' | 'disambiguation' {
  if (e.classes.includes(DISAMBIGUATION)) {
    return 'disambiguation';
  }

  if (e.classes.some((c) => TV_CLASSES.has(c))) {
    return 'tv';
  }

  if (e.classes.some((c) => FILM_CLASSES.has(c))) {
    return 'movie';
  }

  // Sparse items carry a description but few claims; let the prose decide.
  const d = (e.description ?? '').toLowerCase();
  if (/\b(tv|television|web|animated) (series|show|program|programme)\b|\bminiseries\b|\bsitcom\b/.test(d)) {
    return 'tv';
  }

  if (/\bfilm\b|\bmovie\b|\bspecial\b|\bdocumentary\b/.test(d)) {
    return 'movie';
  }

  return 'other';
}

/**
 * The best entity for a work: right kind, exact label first, else the first
 * gated candidate (caller order = naming-convention then search rank).
 */
export function pickEntity(entities: WikidataEntity[], work: StreamingWork): WikidataEntity | undefined {
  const norm = normalizeWorkTitle(work.title);
  const isWork = (e: WikidataEntity) => {
    const k = classifyEntity(e);

    return k === 'tv' || k === 'movie';
  };

  const exactTitle = (e: WikidataEntity) =>
    normalizeWorkTitle(e.label ?? '') === norm || normalizeWorkTitle(stripParen(e.enwiki ?? '')) === norm;
  const sameKind = entities.filter((e) => classifyEntity(e) === work.kind);

  // Exact title of the right kind, then exact title of the other kind (a
  // special filed as a film that Wikidata calls a TV program, or vice versa)
  // — an exact name beats a same-kind partial like "The Dark Knight" for
  // "Dark" — and only then the best-ranked same-kind candidate whose name at
  // least resembles the work's. Search rank alone is not evidence: an obscure
  // special's first "film" hit is usually some other film its subject was in.
  return (
    sameKind.find(exactTitle) ??
    entities.find((e) => isWork(e) && exactTitle(e)) ??
    sameKind.find((e) => titlesResemble(e.label ?? stripParen(e.enwiki ?? ''), work.title))
  );
}

/** Token overlap ≥ ½ either way, or one name contained in the other. */
export function titlesResemble(a: string, b: string): boolean {
  const na = normalizeWorkTitle(a);
  const nb = normalizeWorkTitle(b);
  if (!na || !nb) {
    return false;
  }

  if (na.includes(nb) || nb.includes(na)) {
    return true;
  }

  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const shared = [...ta].filter((t) => tb.has(t)).length;

  return shared / Math.min(ta.size, tb.size) >= 0.5 && shared >= 2;
}

function stripParen(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, '');
}

export function commonsImageUrl(filename: string | undefined): string | undefined {
  if (!filename) {
    return undefined;
  }

  return `${COMMONS_FILE}${encodeURIComponent(filename.replace(/ /g, '_'))}?width=${POSTER_WIDTH}`;
}

/** Flattens the parts of a wbgetentities item this resolver reads. */
export function parseEntity(raw: Record<string, unknown>): WikidataEntity {
  const claims = (raw.claims ?? {}) as Record<
    string,
    Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>
  >;
  const values = (p: string): unknown[] =>
    (claims[p] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v !== undefined);
  const first = (p: string): unknown => values(p)[0];
  const text = (p: string): string | undefined => {
    const v = first(p);

    return typeof v === 'string' ? v : undefined;
  };

  const quantity = (p: string): number | undefined => {
    const v = first(p) as { amount?: string } | undefined;
    const n = v?.amount ? Number.parseFloat(v.amount) : NaN;

    return Number.isFinite(n) ? n : undefined;
  };

  const time = (p: string): string | undefined => {
    const v = first(p) as { time?: string } | undefined;

    return v?.time;
  };

  const labels = (raw.labels ?? {}) as Record<string, { value?: string }>;
  const descriptions = (raw.descriptions ?? {}) as Record<string, { value?: string }>;
  const sitelinks = (raw.sitelinks ?? {}) as Record<string, { title?: string }>;

  return {
    id: String(raw.id),
    label: labels.en?.value,
    description: descriptions.en?.value,
    enwiki: sitelinks.enwiki?.title,
    classes: values('P31')
      .map((v) => (v as { id?: string }).id ?? '')
      .filter(Boolean),
    poster: text('P3383'),
    image: text('P18'),
    logo: text('P154'),
    start: time('P580') ?? time('P577'),
    imdb: text('P345'),
    episodes: quantity('P1113'),
    seasons: quantity('P2437'),
    durationMinutes: quantity('P2047'),
    huluSeries: text('P6467'),
    huluMovie: text('P6466'),
    netflix: text('P1874'),
    primeVideo: text('P8055'),
    disneyPlusBrowse: text('P13902'),
    disneyPlusSeries: text('P7596'),
    disneyPlusMovie: text('P7595'),
  };
}

export function dataFromEntity(
  e: WikidataEntity,
  summary?: { extract?: string; description?: string },
): UnfurlData {
  const kind = classifyEntity(e) === 'tv' ? 'tv' : 'movie';
  const watchLinks = watchLinksFor(e);
  const year = e.start ? Number.parseInt(e.start.replace(/^\+/, '').slice(0, 4), 10) : NaN;
  const page = e.enwiki
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(e.enwiki.replace(/ /g, '_'))}`
    : undefined;

  return {
    title: str(e.label ?? stripParen(e.enwiki ?? ''), 500),
    description: str(summary?.extract ?? e.description),
    siteName: page ? 'Wikipedia' : 'Wikidata',
    canonicalUrl: page ?? `https://www.wikidata.org/wiki/${e.id}`,
    thumbnailUrl: commonsImageUrl(e.poster ?? e.image ?? e.logo),
    durationSeconds: e.durationMinutes && kind === 'movie' ? Math.round(e.durationMinutes * 60) : undefined,
    externalRef: `wikidata:${e.id}`,
    payload: {
      wikidata_id: e.id,
      media_type: kind,
      year: Number.isFinite(year) ? year : undefined,
      short_description: summary?.description ?? e.description,
      imdb_id: e.imdb,
      episodes: e.episodes,
      seasons: e.seasons,
      image_source: e.poster ? 'P3383' : e.image ? 'P18' : e.logo ? 'P154' : undefined,
      // Every provider's page for the work, keyed by source_system. The row is
      // shared across sources, so the per-row read picks its own
      // (ContentResolver.unfurl via watchLinkFor).
      ...(watchLinks ? { watch_links: watchLinks } : {}),
      // NO season / episode here: this row is shared by every episode of the
      // work (that is the point of the key), so per-row coordinates are
      // re-derived from each content row's own title at read time
      // (ContentResolver.unfurl). Storing the first episode's here made all
      // eight episodes of a series read "S1 E3".
    },
  };
}

export class WikidataResolver implements UnfurlResolver {
  async resolve(target: ResolveTarget, fetcher: UnfurlFetcher): Promise<UnfurlOutcome> {
    const work = target.work;
    if (!work) {
      return { status: 'not_embeddable', detail: 'no_work' };
    }

    // 1. Naming-convention titles, one request.
    const direct = await this.pages(
      fetcher,
      `titles=${encodeURIComponent(candidateTitles(work).join('|'))}&redirects=1`,
    );
    if ('status' in direct) {
      return direct;
    }

    let qids = direct.filter((p) => p.qid).map((p) => p.qid!);
    let entities = qids.length ? await this.entities(fetcher, qids) : [];
    if ('status' in entities) {
      return entities;
    }

    let picked = pickEntity(entities, work);

    // 2. Full-text search, for works whose article title does not follow the
    //    convention ("Patriot Act with Hasan Minhaj", "Unbreakable Kimmy Schmidt").
    if (!picked) {
      const hint = work.kind === 'tv' ? 'television series' : 'film';
      const found = await this.pages(
        fetcher,
        `generator=search&gsrlimit=6&gsrsearch=${encodeURIComponent(`${work.title} ${hint}`)}`,
      );
      if ('status' in found) {
        return found;
      }

      qids = found.filter((p) => p.qid && !qids.includes(p.qid)).map((p) => p.qid!);
      if (qids.length) {
        const more = await this.entities(fetcher, qids);
        if ('status' in more) {
          return more;
        }

        entities = [...entities, ...more];
        picked = pickEntity(more, work);
      }
    }

    if (!picked) {
      return { status: 'not_found' };
    }

    // 3. The article's lead paragraph makes a far better description than
    //    Wikidata's one-liner; best effort, never fatal.
    let summary: { extract?: string; description?: string } | undefined;
    if (picked.enwiki) {
      const res = await fetcher.get(
        `${WIKIPEDIA_SUMMARY}${encodeURIComponent(picked.enwiki.replace(/ /g, '_'))}`,
        {
          accept: 'application/json',
          maxBytes: MAX_JSON_BYTES,
        },
      );
      if (res.kind === 'ok') {
        try {
          const json = JSON.parse(res.body.toString('utf8')) as { extract?: string; description?: string };
          summary = { extract: json.extract, description: json.description };
        } catch {
          /* keep the Wikidata description */
        }
      }
    }

    return { status: 'ok', data: dataFromEntity(picked, summary) };
  }

  private async pages(fetcher: UnfurlFetcher, query: string): Promise<WikipediaPage[] | Fail> {
    const res = await fetcher.get(
      `${WIKIPEDIA_API}?action=query&prop=pageprops&ppprop=wikibase_item&format=json&${query}`,
      {
        accept: 'application/json',
        maxBytes: MAX_JSON_BYTES,
      },
    );
    const fail = failFrom(res);
    if (fail) {
      return fail;
    }

    try {
      const json = JSON.parse((res as OkFetch).body.toString('utf8')) as {
        query?: {
          pages?: Record<
            string,
            { title?: string; index?: number; missing?: string; pageprops?: { wikibase_item?: string } }
          >;
        };
      };
      const pages = Object.values(json.query?.pages ?? {});
      // Search results carry an `index` (rank); title lookups keep request order loosely.
      pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

      return pages.map((p) => ({
        title: p.title ?? '',
        qid: p.pageprops?.wikibase_item,
        missing: p.missing !== undefined,
      }));
    } catch {
      return { status: 'transport_error', detail: 'invalid_json' };
    }
  }

  private async entities(fetcher: UnfurlFetcher, qids: string[]): Promise<WikidataEntity[] | Fail> {
    const res = await fetcher.get(
      `${WIKIDATA_API}?action=wbgetentities&props=claims|sitelinks|labels|descriptions&languages=en&sitefilter=enwiki&format=json&ids=${qids
        .slice(0, 20)
        .join('|')}`,
      { accept: 'application/json', maxBytes: 4 * MAX_JSON_BYTES },
    );
    const fail = failFrom(res);
    if (fail) {
      return fail;
    }

    try {
      const json = JSON.parse((res as OkFetch).body.toString('utf8')) as {
        entities?: Record<string, Record<string, unknown>>;
      };
      const byId = new Map(Object.values(json.entities ?? {}).map((e) => [String(e.id), parseEntity(e)]));

      // Preserve the caller's order: it encodes naming-convention / search rank.
      return qids.map((q) => byId.get(q)).filter((e): e is WikidataEntity => !!e && !('missing' in e));
    } catch {
      return { status: 'transport_error', detail: 'invalid_json' };
    }
  }
}

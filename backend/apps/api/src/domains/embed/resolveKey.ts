/**
 * Which resolver a content row gets, and the cache key it shares with every
 * other row that would resolve to the same thing.
 *
 * The key is what makes enrichment cheap: 33k Spotify plays of 5k tracks are
 * 5k lookups, 3.5k Netflix episodes of ~300 shows are ~300 Wikidata lookups.
 *
 *   oembed:<providerRef>         provider has an oEmbed endpoint (Spotify, Vimeo, …; NOT YouTube — see OEMBED_PROVIDERS)
 *   wd:<tv|movie>:<norm title>   Netflix / Prime rows — title only, no URL → Wikidata + Wikipedia
 *   og:<canonical url>           any other http(s) URL → OpenGraph / <title>
 */
import { classifyExternalId } from '@ci/domains/memory';

import { canonicalizeUrl } from '../identity';

import { normalizeWorkTitle, parseStreamingTitle, type StreamingWork } from './streamingTitle';

export type Resolver = 'oembed' | 'wikidata' | 'opengraph';

export interface ResolveTarget {
  resolver: Resolver;
  key: string;
  /** What the resolver fetches: the canonical page URL, or the parsed work. */
  url?: string;
  providerRef?: string;
  work?: StreamingWork;
}

/**
 * Providers whose oEmbed endpoint is public and unauthenticated AND whose
 * answer tells the tile something it cannot work out for itself.
 *
 * YouTube is deliberately absent. Everything the grid and lightbox need for a
 * video is a function of its id — the player URL and the poster
 * (`i.ytimg.com/vi/<id>/hqdefault.jpg`) both come from `derivePlayer` with no
 * request — and the import already carries the title. What oEmbed would add
 * (the channel name) is not worth one request per video across a 70k-row
 * watch history at 2/s.
 */
export const OEMBED_PROVIDERS: ReadonlySet<string> = new Set([
  'spotify',
  'vimeo',
  'soundcloud',
  'dailymotion',
  'x',
]);

/**
 * Providers whose rows are fully described by `derivePlayer` and must NOT fall
 * through to OpenGraph: a watch-page fetch per video is the very request the
 * template exists to avoid.
 */
export const TEMPLATED_PROVIDERS: ReadonlySet<string> = new Set(['youtube']);

export interface ResolveSource {
  sourceSystem?: string | null;
  url?: string | null;
  sourceUrl?: string | null;
  externalId?: string | null;
  externalIdKind?: string | null;
  /** The export's own title (source_data.Title), for title-only sources. */
  sourceTitle?: string | null;
}

const STREAMING_SOURCES = new Set(['netflix', 'prime_video', 'hulu', 'disney_plus']);

export function resolveTargetFor(row: ResolveSource): ResolveTarget | null {
  const kind = row.externalIdKind ?? classifyExternalId(row.externalId);
  const candidates = [kind === 'external_uri' ? row.externalId : null, row.url, row.sourceUrl];

  for (const candidate of candidates) {
    const canonical = canonicalizeUrl(candidate);
    if (!canonical) {
      continue;
    }

    if (canonical.provider && TEMPLATED_PROVIDERS.has(canonical.provider)) {
      return null;
    }

    if (canonical.provider && canonical.providerRef && OEMBED_PROVIDERS.has(canonical.provider)) {
      return {
        resolver: 'oembed',
        key: `oembed:${canonical.providerRef}`,
        url: canonical.canonical,
        providerRef: canonical.providerRef,
      };
    }

    if (/^https?:\/\//i.test(canonical.canonical)) {
      return { resolver: 'opengraph', key: `og:${canonical.canonical}`, url: canonical.canonical };
    }
  }

  if (row.sourceSystem && STREAMING_SOURCES.has(row.sourceSystem) && row.sourceTitle) {
    const work = parseStreamingTitle(row.sourceSystem, row.sourceTitle);
    if (work) {
      const norm = normalizeWorkTitle(work.title);
      if (norm) {
        return { resolver: 'wikidata', key: `wd:${work.kind}:${norm}`, work };
      }
    }
  }

  return null;
}

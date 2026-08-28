/**
 * Netflix and Prime Video exports carry a title string and nothing else — no
 * id, no URL. Turning that into a Wikidata lookup means recovering the WORK
 * (the series or the film) from the per-episode string, because that is what
 * has a page and, sometimes, a picture.
 *
 *   Netflix  "Dark: Season 1: Alpha and Omega (Episode 10)"       → tv    "Dark"
 *            "Patriot Act with Hasan Minhaj: Volume 5: … (Episode 7)" → tv "Patriot Act with Hasan Minhaj"
 *            "The Keepers: Limited Series: The Murder (Episode 1)" → tv    "The Keepers"
 *            "The Ballad of Buster Scruggs"                        → movie "The Ballad of Buster Scruggs"
 *   Prime    "The Flame of Tar Valon-The Wheel of Time - Season 1" → tv    "The Wheel of Time"
 *            "Ready, Aim, Marry Me!-Arrested Development Season 2" → tv    "Arrested Development"
 *            "Sam Smith: Dreams Come True"                         → movie "Sam Smith: Dreams Come True"
 *
 * "movie" here means "not recognisably an episode": specials and films both
 * look for a film article first, then fall back to a television one.
 */

export interface StreamingWork {
  kind: 'tv' | 'movie';
  /** Series or film title, as the export spells it. */
  title: string;
  season?: number;
  episode?: number;
  /** The episode's own title when the string carried one. */
  episodeTitle?: string;
}

const NETFLIX_SEASON_WORDS =
  /^(?:season|series|volume|part|chapter|book|collection|limited series|miniseries|the complete series)\b/i;
const NETFLIX_EPISODE_SUFFIX = /\s*\(Episode\s+(\d+)\)\s*$/i;
const PRIME_SEASON_SUFFIX = /\s*[-–:]?\s*Season\s+(\d+)\s*$/i;

function num(s: string | undefined): number | undefined {
  if (!s) {
    return undefined;
  }

  const n = Number.parseInt(s, 10);

  return Number.isFinite(n) ? n : undefined;
}

export function parseNetflixTitle(raw: string): StreamingWork | null {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) {
    return null;
  }

  const episodeMatch = NETFLIX_EPISODE_SUFFIX.exec(title);
  const body = episodeMatch ? title.slice(0, episodeMatch.index) : title;
  const parts = body.split(/:\s+/);

  // "Show: Season N: Episode" — the season word in the SECOND segment is the
  // tell. Show names with their own colon ("Star Trek: Discovery: Season 1")
  // push the season word to the third segment, so scan for it.
  const seasonIdx = parts.findIndex((p, i) => i > 0 && NETFLIX_SEASON_WORDS.test(p));
  if (seasonIdx > 0) {
    const seasonNum = num(/\d+/.exec(parts[seasonIdx])?.[0]);
    const episodeTitle = parts.slice(seasonIdx + 1).join(': ') || undefined;

    return {
      kind: 'tv',
      title: parts.slice(0, seasonIdx).join(': '),
      season: seasonNum,
      episode: num(episodeMatch?.[1]),
      episodeTitle,
    };
  }

  // "(Episode N)" with no season segment — still an episode of parts[0].
  if (episodeMatch && parts.length > 1) {
    return {
      kind: 'tv',
      title: parts[0],
      episode: num(episodeMatch[1]),
      episodeTitle: parts.slice(1).join(': ') || undefined,
    };
  }

  return { kind: 'movie', title };
}

export function parsePrimeVideoTitle(raw: string): StreamingWork | null {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) {
    return null;
  }

  const seasonMatch = PRIME_SEASON_SUFFIX.exec(title);
  const season = num(seasonMatch?.[1]);
  const body = seasonMatch ? title.slice(0, seasonMatch.index).trim() : title;

  // "Episode Title-Show" — Prime joins them with a hyphen. Film titles carry
  // hyphens too ("Spider-Man"), so the split is only trusted when the season
  // suffix proves the string is an episode; otherwise the whole string is the
  // work.
  const dash = body.lastIndexOf('-');
  if (seasonMatch && dash > 0) {
    const episodeTitle = body.slice(0, dash).trim();
    const show = body.slice(dash + 1).trim();
    if (show) {
      return { kind: 'tv', title: show, season, episodeTitle: episodeTitle || undefined };
    }
  }

  if (seasonMatch) {
    return { kind: 'tv', title: body, season };
  }

  return { kind: 'movie', title };
}

/** The work named by a streaming export's title string, per source. */
export function parseStreamingTitle(sourceSystem: string, raw: string): StreamingWork | null {
  switch (sourceSystem) {
    case 'netflix':
      return parseNetflixTitle(raw);
    case 'prime_video':
      return parsePrimeVideoTitle(raw);
    default:
      return null;
  }
}

/** Case/space/punctuation-insensitive form of a title, for the resolve key. */
export function normalizeWorkTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

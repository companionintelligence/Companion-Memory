import config from '@ci/configuration';

/**
 * Trivial, high-volume phrases that carry no searchable signal. These are the
 * canonical "reaction" / system rows that dominate chat/social imports — a user
 * would never search for them, and embedding millions of them is pure cost.
 *
 * Matched case-insensitively against the *whole* trimmed text (after stripping a
 * trailing period / emoji-ish punctuation), so we only drop the text when it is
 * EXACTLY one of these — never when it merely contains the phrase. This keeps the
 * default conservative: real messages that happen to include "liked" stay.
 */
const TRIVIAL_PHRASES: ReadonlySet<string> = new Set(
  [
    'loved an image',
    'liked an image',
    'laughed at an image',
    'emphasized an image',
    'questioned an image',
    'disliked an image',
    'loved a message',
    'liked a message',
    'laughed at a message',
    'emphasized a message',
    'questioned a message',
    'disliked a message',
    'reacted to a message',
    'liked',
    'loved',
    'disliked',
    'ok',
    'okay',
    'k',
    'yes',
    'no',
    'thanks',
    'thank you',
    'ty',
    'lol',
    'haha',
    '👍',
    '❤️',
  ].map((phrase) => phrase.toLowerCase()),
);

/**
 * Normalises text for the trivial-phrase comparison: lower-cases, collapses
 * internal whitespace, and strips trailing sentence punctuation so "Loved an
 * image." and "loved an image" both match.
 */
function normalizeForTriviality(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/u, '')
    .trim();
}

/**
 * Matches text that is EXACTLY a single bare URL — an http/https/ftp link, a
 * `www.`-prefixed host, or a bare domain — with no surrounding words. These
 * "URL-only" messages (a shared link with no commentary) are part of the tiny /
 * link-only slice of chat imports (~13% of communications are tiny or URL-only)
 * and carry no natural-language signal a user would semantically search for: the
 * embedding of a raw URL is noise. The link itself is still recoverable via the
 * tsvector / keyword path (which is NOT gated by embeddability) and via the
 * source row, so dropping only the dense embedding is conservative.
 *
 * Anchored (^…$) so it never matches text that merely CONTAINS a URL — "check
 * out https://… it's great" keeps its embedding.
 */
const URL_ONLY_REGEX =
  /^(?:(?:https?|ftp):\/\/|www\.)\S+$|^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?:\/\S*)?$/i;

/**
 * Whether the whole trimmed text is a single bare URL / link with no other words.
 * Requires the text to be a single token (no internal whitespace) AND match the
 * URL shape — so a sentence that happens to start with a domain is not caught.
 */
function isUrlOnly(trimmed: string): boolean {
  if (/\s/.test(trimmed)) {
    return false;
  }

  return URL_ONLY_REGEX.test(trimmed);
}

export interface EmbeddableOptions {
  /** Override the configured minimum length (chars, post-trim). */
  minLength?: number;
}

export type SkipReason = 'empty' | 'too-short' | 'trivial' | 'url-only';

/**
 * Decides whether a text is worth embedding. Conservative by design: it only
 * skips content that is empty, below the configured minimum length, an exact
 * trivial/reaction phrase, or a single bare URL with no other words. Anything a
 * user might plausibly search for is kept.
 *
 * Returns `null` when the text SHOULD be embedded, or a {@link SkipReason} when
 * it should be skipped (so callers can log/count what was dropped).
 */
export function embedSkipReason(
  text: string | null | undefined,
  options?: EmbeddableOptions,
): SkipReason | null {
  if (text == null) {
    return 'empty';
  }

  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return 'empty';
  }

  const minLength = options?.minLength ?? config.embedding.minTextLength;

  if (trimmed.length < minLength) {
    return 'too-short';
  }

  if (TRIVIAL_PHRASES.has(normalizeForTriviality(trimmed))) {
    return 'trivial';
  }

  if (isUrlOnly(trimmed)) {
    return 'url-only';
  }

  return null;
}

/**
 * Convenience boolean wrapper around {@link embedSkipReason}.
 */
export function isEmbeddable(text: string | null | undefined, options?: EmbeddableOptions): boolean {
  return embedSkipReason(text, options) === null;
}

/**
 * Whether a given entity type is eligible for dense embedding, per the
 * configurable allowlist (CI_EMBED_TYPES). An empty allowlist means "embed all
 * types" — the conservative default, so nothing is dropped by type unless an
 * operator explicitly opts into a restricted set.
 *
 * Keyword/tsvector indexing is NOT gated by this — only dense embeddings are.
 */
export function shouldEmbedType(entityType: string, allowlist?: readonly string[]): boolean {
  const types = allowlist ?? config.embedding.types;

  if (types.length === 0) {
    return true;
  }

  return types.includes(entityType);
}

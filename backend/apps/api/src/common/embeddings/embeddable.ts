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

export interface EmbeddableOptions {
  /** Override the configured minimum length (chars, post-trim). */
  minLength?: number;
}

export type SkipReason = 'empty' | 'too-short' | 'trivial';

/**
 * Decides whether a text is worth embedding. Conservative by design: it only
 * skips content that is empty, below the configured minimum length, or an exact
 * trivial/reaction phrase. Anything a user might plausibly search for is kept.
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

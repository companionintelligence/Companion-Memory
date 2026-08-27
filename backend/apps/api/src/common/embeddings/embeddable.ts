import config from '@ci/configuration';

/**
 * This module is the single decision point for *whether* a thing is worth a
 * dense embedding. Two orthogonal concerns live here and intentionally share a
 * file:
 *
 *  1. **Content quality** — given a piece of TEXT, is it substantive enough to
 *     embed? Empty / too-short / a bare trivial reaction / a single bare URL all
 *     carry no searchable signal. Entry points: {@link embedSkipReason},
 *     {@link isEmbeddable}. Callers: the per-domain `*SearchIndexListener`s,
 *     which derive a search document and pass it as text.
 *
 *  2. **Entity type** — given an entity TYPE, is that type embeddable at all,
 *     and (for graph producers) which canonical search-vocabulary type does it
 *     map onto? Entry points: {@link normalizeEmbeddableType},
 *     {@link isEmbeddableType} and {@link shouldEmbedType} (the operator
 *     allowlist).
 *
 * Keyword/tsvector indexing is NOT gated by anything here — only dense
 * embeddings are. Both concerns are conservative: they only drop what is
 * provably low value.
 */

// ---------------------------------------------------------------------------
// Concern 1: content quality (text-based)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Concern 2: entity type (vocabulary + operator allowlist)
// ---------------------------------------------------------------------------

/**
 * Canonical search-vocabulary entity types that have a dense embedding in
 * `ci_search.embeddings`. Kept as plain literals (rather than imported from the
 * search domain) so this module stays dependency-free — the search domain
 * already depends on `@ci/common/embeddings`. Keep in sync with
 * search-next's `INDEXABLE_ENTITIES`.
 */
const EMBEDDABLE_SEARCH_TYPES = new Set<string>([
  'answer',
  'browser-activity',
  'communication',
  'concept',
  'content',
  'event',
  'file',
  'item',
  'message',
  'note',
  'person',
  'place',
  'position',
  // Catalog models (ci.product_models) and purchase evidence (ci.receipts).
  'product',
  'receipt',
  'thread',
]);

/**
 * Graph NER `entity_type` values mapped onto the search vocabulary. Anything not
 * listed falls back to a lowercase comparison, so a source that already speaks
 * the search vocabulary (e.g. `person`) passes through unchanged. Mirrors the
 * explorer bridge in `domains/memory/graph.types.ts`
 * (`EXPLORER_TO_GRAPH_ENTITY_TYPES`).
 */
const GRAPH_TYPE_ALIASES: Record<string, string> = {
  Person: 'person',
  Contact: 'person',
  Concept: 'concept',
  Location: 'place',
  Place: 'place',
  Object: 'item',
  Thing: 'item',
  Item: 'item',
  // The graph mirror of a catalog model (ci.entities, entity_type 'Product',
  // pointed at by ci.product_models.product_entity_id). It maps to 'product',
  // NOT to 'item': a model is what a thing IS, an item is a thing the user
  // OWNS, and collapsing the two would file every catalog row into the
  // the object slice of the embedding space.
  Product: 'product',
  Event: 'event',
  Content: 'content',
  File: 'file',
};

/**
 * Resolve a source/graph entity type onto the canonical (lowercase) search
 * vocabulary, or `null` when the type has no embeddable representation. This is
 * how graph producers (Person/Concept/Location pushed by GraphEventService) land
 * in the same embedding space the search queries hit.
 */
export function normalizeEmbeddableType(entityType: string | null | undefined): string | null {
  if (entityType == null) {
    return null;
  }

  const candidate = GRAPH_TYPE_ALIASES[entityType] ?? entityType.toLowerCase();

  return EMBEDDABLE_SEARCH_TYPES.has(candidate) ? candidate : null;
}

/**
 * Whether the given entity type has any embeddable representation in the search
 * vocabulary (in either the graph or search vocabulary). Pure vocabulary check —
 * does NOT consult the operator allowlist (see {@link shouldEmbedType}).
 */
export function isEmbeddableType(entityType: string | null | undefined): boolean {
  return normalizeEmbeddableType(entityType) !== null;
}

/**
 * Whether a given entity type is eligible for dense embedding, per the
 * configurable operator allowlist (CI_EMBED_TYPES). An empty allowlist means
 * "embed all types" — the conservative default, so nothing is dropped by type
 * unless an operator explicitly opts into a restricted set.
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

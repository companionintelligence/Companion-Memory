/**
 * Sidebar labels for chat threads. The model is asked for ~three words; this
 * strips thinking traces, quotes, and extra punctuation so the list stays short.
 */
export function sidebarTitleFromModel(raw: string): string {
  const withoutThink = withoutThinking(raw);
  const cleaned = withoutThink
    .replace(/["'`]/g, '')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  const words = cleaned.split(' ').slice(0, 6);

  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

/**
 * `text` without its thinking: every `<think>…</think>` block, and a trailing `<think>` that never
 * closed (a reply cut off while still reasoning).
 */
function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ');
}

/**
 * A stored chat message as the title model should read it: the words that were said, without the
 * reasoning they were stored with.
 *
 * Assistant replies are stored as `<think>reasoning</think>answer` (see persistedAssistantContent).
 * Handed to the title call as they are, a thinking model continued that pattern and reasoned about
 * the conversation instead of naming it, even with thinking switched off, and its reply held no
 * title. A reply that was only reasoning (a tool-calling step) comes back empty.
 */
export function titleExcerptFromMessage(content: string): string {
  return withoutThinking(content).replace(/\s+/g, ' ').trim();
}

export const THREAD_TITLE_SYSTEM_PROMPT =
  'Name this conversation for a sidebar label. Reply with three words, plus or minus a few. No punctuation, no quotes, no explanation.';

/** Longest stand-in title: about one sidebar line. */
export const PROVISIONAL_TITLE_MAX_LENGTH = 60;

/**
 * A stand-in title for a thread the model could not name: the person's own first words.
 *
 * Cut at the last word boundary that fits, and left bare — an ellipsis on a label reads as a label that was
 * truncated, and the sidebar truncates visually anyway. A single unbroken token longer than the limit is cut at the
 * limit rather than returning nothing. Returns '' when there is nothing usable.
 */
export function provisionalTitleFromMessage(
  text: string | null | undefined,
  maxLength: number = PROVISIONAL_TITLE_MAX_LENGTH,
): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();

  if (flat.length <= maxLength) {
    return flat;
  }

  // One character past the limit, so a word that ends exactly on it is kept whole.
  const window = flat.slice(0, maxLength + 1);
  const boundary = window.lastIndexOf(' ');
  const clipped = boundary > 0 ? window.slice(0, boundary) : flat.slice(0, maxLength);

  // Punctuation stranded by the cut ("…and," / "…and -") is not part of a title.
  return clipped.replace(/[\s,;:\-–—]+$/u, '');
}

/**
 * Depth-correct `<div>` block extent, for sources that scan a large HTML
 * export with a regex instead of building a DOM (some of these files run to
 * hundreds of MB, so a full parse per file is not free).
 *
 * A non-greedy `<div ...>([\s\S]*?)<\/div>` stops at the FIRST `</div>` —
 * correct only as long as nothing inside the block is itself a `<div>`. A real
 * Google Voice MMS wraps every attachment in its own sibling div INSIDE the
 * message block, so that pattern captured only the first attachment and
 * silently dropped 2..N: 274 rows on a real corpus, every one an attachment
 * whose per-message index was >= 2 and NOT ONE at index 1 — the exact
 * signature of "stopped at the first nested close". Google's own "My
 * Activity" export nests divs for icons/thumbnails in some product types, so
 * a source scanning ITS content cells the same non-greedy way carries the
 * same exposure even on a fixture that does not happen to trigger it today.
 *
 * Counting `<div` / `</div>` finds the real close in one linear pass over the
 * text — no slower than the non-greedy regex it replaces, and still no DOM.
 */

/**
 * Index of the `</div>` closing the div whose body starts at `from`.
 *
 * Returns the end of the string when the markup is unbalanced, so truncated
 * input still yields its final block instead of silently dropping it — the
 * lazy regex this replaces used to "recover" from bad markup by ending the
 * block early, and ending it late loses nothing that was ever parsed out of
 * it.
 */
export function matchingDivCloseIndex(raw: string, from: number): number {
  const tagRegex = /<(\/?)div\b[^>]*>/gi;
  tagRegex.lastIndex = from;
  let depth = 0;
  let tag: RegExpExecArray | null;

  while ((tag = tagRegex.exec(raw)) !== null) {
    if (!tag[1]) {
      depth++;
      continue;
    }

    if (depth === 0) {
      return tag.index;
    }

    depth--;
  }

  return raw.length;
}

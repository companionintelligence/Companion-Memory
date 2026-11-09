import { sanitizeAskerText } from './promptSafety';

interface Props {
  /**
   * The app's own words introducing the text, e.g. "They say this is for:".
   * Fixed copy: never built from anything the asker sent.
   */
  attribution: string;
  /** The raw, asker-supplied text. Sanitized here — callers pass it unmodified. */
  text: string;
}

/**
 * A short run of somebody else's words, inline, set apart from the app's own.
 *
 * The inline sibling of `AskerQuote`, for the peer-supplied values that
 * sit inside a line of app copy rather than in a block of their own: the stated
 * purpose, the name delegated software gives itself, and the kind of ask and
 * data class on the scope line. The same rules travel with the text, for the
 * same reasons:
 *
 *  1. AN ATTRIBUTION in the markup, before the text, so the sentence around it
 *     is fixed copy and the peer's words are announced as theirs.
 *  2. NO WRAPPING QUOTE MARKS. `“{purpose}”` let a purpose containing `”` end
 *     the quotation and finish the line in the app's voice. A bordered chip
 *     needs no delimiter the text can contain.
 *  3. `dir="ltr"` WITH `unicode-bidi: isolate`, so right-to-left text cannot
 *     reorder the app's words around it — and {@link sanitizeAskerText} strips
 *     the bidi controls and invisibles first, and collapses line breaks.
 *
 * When characters were removed, or the text was shortened, the line says so:
 * the owner needs to know they are not seeing exactly what was sent.
 */
export function PeerText({ attribution, text }: Props) {
  const { text: shown, removedHiddenCharacters, truncated } = sanitizeAskerText(text);

  return (
    <span>
      <span>{attribution}</span>{' '}
      <span
        dir="ltr"
        // Isolation, not just direction: see rule 3 above.
        style={{ unicodeBidi: 'isolate' }}
        data-peer-text=""
        className="border-muted-foreground/30 text-foreground rounded-sm border px-1 break-words"
      >
        {shown}
      </span>
      {truncated ? <span> (shortened — not all of what they sent)</span> : null}
      {removedHiddenCharacters ? <span> (characters that render as nothing were removed)</span> : null}
    </span>
  );
}

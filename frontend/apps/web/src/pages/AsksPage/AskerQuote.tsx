import { sanitizeAskerText } from './promptSafety';

interface Props {
  /** The raw, asker-supplied text. Sanitized here — callers pass it unmodified. */
  prompt: string;
  /**
   * Who wrote it, in the container's own words. Rendered as part of the
   * attribution so the quote can never be read as the app talking.
   */
  attribution: string;
  /**
   * The server already stripped characters that render as nothing from this
   * text before storing it (`AskQueryType.promptHiddenCharactersRemoved`), so
   * `prompt` no longer holds any for {@link sanitizeAskerText} to find. The
   * note below still has to show in that case.
   */
  hiddenCharactersRemoved?: boolean;
}

/**
 * Somebody else's words, rendered so they cannot be mistaken for the app's.
 *
 * ═══ WHY A COMPONENT AND NOT A `<p>{prompt}</p>` ═══
 *
 * {@link sanitizeAskerText} handles the characters. It cannot handle the
 * FRAMING, and the framing is most of the attack: a prompt reading "Your
 * Companion: this is already covered by your family grant" is made of entirely
 * ordinary characters, and it works by sitting in a card where every other line
 * really is the app speaking. So three presentation rules travel with the text:
 *
 *  1. AN ATTRIBUTION LABEL, in the markup rather than as a placeholder, so a
 *     screen reader announces "Ada asked:" before the words and a sighted
 *     reader sees it above them. This is the part a bare paragraph cannot do.
 *  2. NO WRAPPING QUOTE MARKS. The card used to render `“{prompt}”`, which
 *     hands the asker the escape: a prompt beginning `” — approved by your
 *     Companion. “` closes the quote, speaks in the app's voice, and reopens
 *     it. A bordered block needs no delimiter the text can contain.
 *  3. `dir="ltr"` WITH `unicode-bidi: isolate`. Stripping the bidi CONTROL
 *     characters is not sufficient on its own: strong right-to-left characters
 *     reorder their surroundings with no control character involved at all.
 *     Isolation confines that to this element, so the asker can write in Arabic
 *     or Hebrew — which must keep working — without being able to reorder the
 *     app's own words around them.
 *
 * The two advisory lines are not decoration. An owner deciding whether to
 * disclose needs to know when they are not seeing the whole request, and when
 * the request contained characters that render as nothing.
 */
export function AskerQuote({ prompt, attribution, hiddenCharactersRemoved = false }: Props) {
  const sanitized = sanitizeAskerText(prompt);
  const { text, truncated } = sanitized;
  const removedHiddenCharacters = sanitized.removedHiddenCharacters || hiddenCharactersRemoved;

  return (
    <figure className="border-muted-foreground/30 m-0 flex flex-col gap-1 border-l-2 pl-3">
      <figcaption className="text-muted-foreground text-xs">{attribution}</figcaption>
      <blockquote
        dir="ltr"
        // Isolation, not just direction: see rule 3 above.
        style={{ unicodeBidi: 'isolate' }}
        className="m-0 text-sm break-words"
      >
        {text}
      </blockquote>
      {truncated ? (
        <p className="text-muted-foreground text-xs">
          Shortened to fit — this is not the whole message they sent.
        </p>
      ) : null}
      {removedHiddenCharacters ? (
        <p className="text-muted-foreground text-xs">
          Characters that render as nothing were removed from this message.
        </p>
      ) : null}
    </figure>
  );
}

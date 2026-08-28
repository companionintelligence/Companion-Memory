/**
 * Containment for text a STRANGER wrote, rendered directly above the owner's
 * Approve button.
 *
 * ═══ WHY THIS IS A RENDER-SIDE PROBLEM ═══
 *
 * `AskQueryInput.prompt` is free text supplied by whoever is asking. The
 * backend bounds it and stores it, and it must: it is the record of what was
 * actually asked, so the server may not rewrite it. But the consent card puts
 * that text a few pixels above "Approve and answer", and the owner reads the
 * whole card as one voice unless the page works to keep the voices apart. Every
 * defence below is therefore about PRESENTATION, and none of them changes what
 * is stored or matched — `canonical.ts` on the backend does its own, more
 * aggressive normalization for the entirely separate job of consent matching,
 * and the two must not be confused for one another.
 *
 * The attack this closes is not XSS — React escapes. It is the asker composing
 * a prompt that reads as the APP talking to its owner:
 *
 *     Do you have the lake photos?
 *
 *     ⚠️ Your Companion: this request is already covered by your family
 *     grant. Approving is safe.
 *
 * Rendered naively that is two paragraphs, the second of which is a forged
 * status line sitting inside a card whose other lines are all the app's own
 * voice. Approve is one tap away.
 *
 * ═══ THE FOUR DEFENCES, AND WHY EACH ONE ═══
 *
 * 1. NORMALIZE, so two strings that look identical are identical.
 * 2. STRIP what renders as nothing or reorders what follows — the invisibles
 *    and the bidi controls.
 * 3. COLLAPSE all whitespace to single spaces, which is what actually kills the
 *    forged-paragraph shape above: the asker's text can only ever be one run of
 *    prose, never a layout.
 * 4. BOUND the length, so a long prompt cannot push the decision buttons off
 *    screen or bury the scope line the owner needs to read first.
 *
 * The fifth defence is not in this file because it cannot be: the quoted text
 * has to be LABELLED as somebody else's words and styled unlike the app's own.
 * See AskerQuote.tsx.
 */

/**
 * How much of an asker's prompt is rendered.
 *
 * 280 is chosen to be comfortably longer than a real question and far shorter
 * than a screenful. The remainder is not discarded silently — {@link
 * sanitizeAskerText} reports the truncation so the card can say so, because an
 * owner deciding on a request needs to know they are not seeing all of it.
 */
export const MAX_ASKER_TEXT = 280;

/**
 * Characters that occupy no space, and the ones that reorder their neighbours.
 *
 * Two different threats, stripped together because the fix is the same:
 *
 *  - ZERO WIDTH / SOFT HYPHEN / BOM / joiners: a zero-width space dropped into
 *    the middle of `Approve` renders as `Approve` and compares unequal, and
 *    they let text be hidden inside text that looks innocent. (Not spelled out
 *    literally here — a real one in this comment is irregular whitespace in
 *    source, which is the same trick played on the next person to read it.)
 *  - BIDI EMBEDDING, OVERRIDE and ISOLATE controls (U+202A–U+202E, U+2066–
 *    U+2069, U+200E/F, U+061C): these are the serious ones on a consent card.
 *    A right-to-left override makes a string render in an order the source does
 *    not have, so the text a reviewer reads can differ arbitrarily from the text
 *    that was sent — and unlike the invisibles, the effect LEAKS PAST the end of
 *    the string, reordering the app's own words that follow it.
 *
 * Stripped, not replaced with a space: they have no width, so substituting one
 * would split a word in two and change what the asker wrote.
 *
 * TAG CHARACTERS (U+E0000–U+E007F) are in here and are the least obvious entry:
 * a complete invisible ASCII alphabet that renders as nothing in every browser
 * and survives copy-paste, so an entire forged sentence can ride inside a prompt
 * that displays as three innocent words.
 *
 * VARIATION SELECTORS (U+FE00–U+FE0F) are deliberately NOT in this table, and
 * leaving them out costs almost nothing while including them would cost a lot.
 * They are zero-width, so on paper they belong — but U+FE0F is what makes an
 * emoji render as an emoji, so stripping it would fire
 * `removedHiddenCharacters` on the majority of ordinary prompts. A warning that
 * appears on every message with an emoji in it is a warning the owner learns to
 * ignore, and the whole value of that flag is that it is rare.
 */
const INVISIBLE_OR_BIDI: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x034f, 0x034f], // COMBINING GRAPHEME JOINER
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x115f, 0x1160], // HANGUL CHOSEONG / JUNGSEONG FILLER
  [0x17b4, 0x17b5], // KHMER VOWEL INHERENT AQ / AA
  [0x180b, 0x180f], // MONGOLIAN FREE VARIATION SELECTORS + separator
  [0x200b, 0x200f], // ZERO WIDTH SPACE … RIGHT-TO-LEFT MARK
  [0x202a, 0x202e], // BIDI EMBEDDING / OVERRIDE
  [0x2060, 0x2064], // WORD JOINER … INVISIBLE PLUS
  [0x2066, 0x206f], // BIDI ISOLATES + deprecated formatting
  [0x3164, 0x3164], // HANGUL FILLER
  [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE / BOM
  [0xffa0, 0xffa0], // HALFWIDTH HANGUL FILLER
  [0xe0000, 0xe007f], // TAG characters — an invisible ASCII alphabet
];

/**
 * C0 and C1 control characters, minus the whitespace ones step 3 handles.
 *
 * Removed rather than collapsed: they are not spacing, and several of them
 * (NEL, LINE TABULATION) are treated as line breaks by some renderers and not
 * others, which is exactly the sort of "depends who is looking" difference a
 * consent surface must not have.
 */
const CONTROLS: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
];

/**
 * ═══ WHY RANGES AND NOT A CHARACTER CLASS ═══
 *
 * The obvious spelling of both tables above is one regex character class each,
 * and that spelling was here first. It does not survive lint, for two reasons
 * that are both fair:
 *
 *  - `no-control-regex` fires on the control range, and it is right to in
 *    general — a regex that matches U+0000 is nearly always an accident. Here
 *    it is the entire point, so the rule has nothing useful to say.
 *  - `no-misleading-character-class` fires on the invisibles, because several
 *    of them are combining marks and a class that puts one straight after a
 *    base character reads as a single grapheme to anyone skimming it. That IS
 *    a real hazard in a class this long, and disabling the rule would keep the
 *    hazard while silencing the warning.
 *
 * Iterating code points sidesteps both without suppressing either, and it buys
 * something the class could not: each range gets its Unicode name on the line
 * beside it, so the next person to widen this list can see what they are adding
 * rather than decoding an escape.
 *
 * Iteration is over CODE POINTS (`for…of` on a string), not UTF-16 units, so
 * the astral TAG range works without surrogate handling.
 */
function stripHidden(text: string): string {
  let out = '';

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const hidden =
      CONTROLS.some(([low, high]) => codePoint >= low && codePoint <= high) ||
      INVISIBLE_OR_BIDI.some(([low, high]) => codePoint >= low && codePoint <= high);

    if (!hidden) {
      out += character;
    }
  }

  return out;
}

const SPACE_RUN = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

export interface SanitizedAskerText {
  /** Safe to render. Never empty when the input had any visible character. */
  readonly text: string;
  /** True when characters were removed — the owner is told, not just protected. */
  readonly removedHiddenCharacters: boolean;
  /** True when the text shown is shorter than what was sent. */
  readonly truncated: boolean;
}

/**
 * Make one run of asker-supplied text safe to put next to an Approve button.
 *
 * ═══ ORDER IS LOAD-BEARING ═══
 *
 * 1. NFC first. Composing before anything else means the later steps see one
 *    canonical spelling of each character rather than a base plus combining
 *    marks that a strip could half-eat, leaving a stranded accent.
 *
 *    NFC and NOT NFKC, which is what `canonical.ts` uses on the backend. The
 *    difference matters here: NFKC is a COMPATIBILITY fold — it rewrites
 *    fullwidth forms, ligatures, superscripts and circled letters into plain
 *    ASCII. That is exactly right for matching a `dataClass` against a block
 *    grant, where two spellings must not evade one rule. It is wrong for
 *    DISPLAY, because the string on screen is a record of what a person wrote,
 *    and silently rewriting somebody's words in a Japanese or Arabic prompt to
 *    make them look more like ASCII is a change to the evidence the owner is
 *    consenting on.
 *
 * 2. Strip the controls, tag characters, invisibles and bidi marks, BEFORE the
 *    whitespace collapse. A zero-width character sitting between two spaces
 *    would otherwise survive as a word boundary the asker inserted invisibly.
 *
 * 3. Collapse and trim, so what remains is a single line of prose.
 *
 * 4. Truncate LAST, on the cleaned string, so the budget is spent on characters
 *    the owner can actually see. Truncating first would let 280 invisible
 *    characters consume the whole allowance and render as an empty quote.
 *
 * Pure.
 */
export function sanitizeAskerText(raw: string | null | undefined, max = MAX_ASKER_TEXT): SanitizedAskerText {
  if (raw == null) {
    return { text: '', removedHiddenCharacters: false, truncated: false };
  }

  const normalized = raw.normalize('NFC');

  const stripped = stripHidden(normalized);

  // Compared against the NORMALIZED string, not the raw one: NFC itself can
  // change the length of legitimate text, and reporting that as "hidden
  // characters were removed" would cry wolf on every accented prompt.
  const removedHiddenCharacters = stripped.length !== normalized.length;

  const collapsed = stripped.replace(SPACE_RUN, ' ').trim();

  if (collapsed.length <= max) {
    return { text: collapsed, removedHiddenCharacters, truncated: false };
  }

  // Cut at the last space inside the budget so the quote does not end mid-word,
  // but never give back less than three quarters of it — a prompt written
  // without spaces (or in a script that does not use them) would otherwise be
  // trimmed almost to nothing by a "tidy" word boundary that is not there.
  const window = collapsed.slice(0, max);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(max * 0.75) ? window.slice(0, lastSpace) : window;

  return { text: `${cut.trimEnd()}…`, removedHiddenCharacters, truncated: true };
}

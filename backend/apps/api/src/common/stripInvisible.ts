/**
 * Stripping the characters that render as nothing, shared by the ask consent gate
 * (`domains/asks/canonical.ts`) and the Local.Pub profile reader (`domains/peers/localPubProfile.ts`).
 * It lives outside both domains because importing one domain's barrel from the other pulls the user and
 * files modules into the peers domain at load time.
 */

/** A surrogate code unit that is not half of a pair (with the `u` flag a proper pair is one code point). */
const LONE_SURROGATE = /\p{Surrogate}/gu;

/** U+FFFD, built from its code point so that no escape sequence has to survive an editor. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * Characters that render as NOTHING and therefore let two visually identical
 * strings compare unequal. `pho<U+200B>tos` renders as `photos` in the owner's
 * Grant Manager and in the asker's client, and compares unequal to it — which
 * is a block-evasion primitive, not a typo. Stripped rather than treated as
 * whitespace: they have no width, so collapsing them to a space would split one
 * word into two.
 *
 * The whole Unicode `Default_Ignorable_Code_Point` set, not a hand-picked list.
 * The list this replaced (zero-width space / non-joiner / joiner, word joiner,
 * soft hyphen, BOM, the bidi marks, embeddings, overrides and isolates) left
 * out the combining grapheme joiner U+034F, the Mongolian vowel separator
 * U+180E and free variation selectors, the variation selectors U+FE00 to U+FE0F
 * and U+E0100 to U+E01EF, the tag characters U+E0000 to U+E007F, the Hangul
 * fillers U+115F, U+1160, U+3164 and U+FFA0, and the musical formatting
 * characters U+1D173 to U+1D17A — and `pho<any of those>tos` got a blocked
 * asker's ask into the owner's review queue. NFKC removes none of them. The
 * bidi marks are named again explicitly (they are all in the set) because they
 * are the ones the review card's `promptSafety.ts` warns about by name.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Default-ignorable characters that are part of how an EMOJI is drawn, and so
 * are kept in that one position: the zero-width joiner between two pictographs
 * (`👩‍💻`), a variation selector after a pictograph (`❤️`), and the tag run of a
 * subdivision flag (`🏴` + tags). Stripping them there changes no word — a
 * pictograph is not a letter — but rewrites what the asker typed and flags every
 * such prompt as altered on the owner's review card. Anywhere else (between two
 * letters, at a word edge) they are stripped like the rest.
 */
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const BLACK_FLAG = 0x1f3f4;
const TAG_CANCEL = 0xe007f;

function isPictograph(codePoint: number | undefined): boolean {
  return codePoint != null && EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint));
}

/** A tag character that spells a subdivision (`gbsct`), not the cancel tag. */
function isSpellingTag(codePoint: number | undefined): boolean {
  return codePoint != null && codePoint >= 0xe0020 && codePoint <= 0xe007e;
}

/** What an emoji's ZWJ may follow: the pictograph, its VS16, or a skin-tone modifier. */
function endsEmoji(codePoint: number | undefined): boolean {
  return (
    isPictograph(codePoint) ||
    codePoint === VS16 ||
    (codePoint != null && codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  );
}

/** Whether the invisible `cp` sits where an emoji sequence puts it — see above. */
function isEmojiSequencePart(cp: number, previous: number | undefined, next: number | undefined): boolean {
  if (cp === ZWJ) {
    return endsEmoji(previous) && isPictograph(next);
  }

  if (cp === VS15 || cp === VS16) {
    return isPictograph(previous);
  }

  if (isSpellingTag(cp)) {
    return previous === BLACK_FLAG || isSpellingTag(previous);
  }

  return cp === TAG_CANCEL && isSpellingTag(previous);
}

/**
 * Strip {@link INVISIBLE} except where it is part of an emoji sequence. Walks
 * code points, so a surrogate pair is never split, and reads each character
 * against the previous one KEPT, so a tag run is judged as a chain.
 *
 * Shared so the consent gate's normalizer (`domains/asks/canonical.ts`) and the other text a stranger
 * supplies that an owner reads (a Local.Pub display name, in `domains/peers/localPubProfile.ts`) strip by
 * THIS rule and not by a second hand-picked list, which is the drift `canonical.ts`'s header warns about. Unlike {@link normalizeText} it does not apply NFKC or
 * collapse spaces: the text keeps the characters the person wrote.
 */
export function stripInvisible(input: string): string {
  // A LONE surrogate half is replaced before anything else. JSON.parse accepts `"\ud800"`, and removing an
  // invisible character that sits BETWEEN a high and a low half would otherwise glue the halves into a
  // valid pair this function never examined: a supplementary invisible character (a tag, a variation
  // selector, a musical formatting character) would walk through a filter that "removes" it.
  const value = input.replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
  if (value.search(INVISIBLE) === -1) {
    return value;
  }

  const chars = Array.from(value);
  const kept: string[] = [];
  let previous: number | undefined;

  for (let i = 0; i < chars.length; i += 1) {
    const cp = chars[i].codePointAt(0) as number;

    if (
      chars[i].search(INVISIBLE) === -1 ||
      isEmojiSequencePart(cp, previous, chars[i + 1]?.codePointAt(0))
    ) {
      kept.push(chars[i]);
      previous = cp;
    }
  }

  return kept.join('');
}

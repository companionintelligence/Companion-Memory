/**
 * Canonical form of the two asker-supplied strings the consent gate matches on:
 * a query's `dataClass` and its `queryType`.
 *
 * These must agree exactly with every consumer. The executor resolves its
 * entity-type hints through {@link canonicalDataClass}, so if grant matching
 * compared raw strings a peer could send `dataClass: 'Photos'` — evading a
 * `block` grant pinned to `photos` while still resolving to the photo entity
 * types downstream. Any normalization added here MUST be mirrored by every
 * consumer of `dataClass` / `queryType`.
 *
 * WHICH DIRECTION IS SAFE TO DRIFT IN. The mirror rule above is about the
 * dangerous direction: a consumer that normalizes MORE than this function does
 * would resolve (and therefore search) a string the gate never matched a block
 * against. Normalizing more HERE than a consumer does is the safe direction —
 * a block covers strings the executor cannot resolve at all, and a sensitive
 * class is recognised in more spellings than the search index answers to. That
 * asymmetry is why this is deliberately aggressive.
 *
 * Lives in its own module because both the consent evaluator (grantMatch) and
 * the policy engine (policy) need it, and importing it from either would create
 * a cycle between them.
 */

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
 */
function stripInvisible(value: string): string {
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

/**
 * Every Unicode character that reads as a space, mapped onto the ASCII one.
 *
 * `\s` in JavaScript already covers most of these, but writing the class out
 * makes the intent explicit and pins the confusable pair that matters:
 * U+00A0 NO-BREAK SPACE is what a copy-paste out of a document produces, and
 * `photos<U+00A0>` evades a class-pinned block the same way a trailing ASCII
 * space would if this did not trim.
 */
const UNICODE_SPACE = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

/**
 * The shared normalizer, CASE PRESERVED.
 *
 * ORDER MATTERS, and each step is here for a reason:
 *
 * 1. NFKC first — it folds the compatibility forms (fullwidth `ｐｈｏｔｏｓ`,
 *    ligatures) onto their plain equivalents. Run after case folding it would
 *    miss the forms whose folding changes case.
 * 2. Strip the invisibles, so a zero-width character cannot survive as a
 *    word-splitting space in step 3.
 * 3. Collapse every flavour of space to a single ASCII one, then trim.
 *
 * Case folding is deliberately NOT one of the steps; {@link canonicalToken}
 * adds it. The split exists because the ask's PROMPT needs steps 1–3 and must
 * not have step 4: it is free text shown back to both sides and to the owner's
 * review inbox, so lowercasing it would rewrite the asker's own words in the
 * one place a human reads them before consenting. Everything that makes two
 * strings compare equal — and therefore everything a block grant is keyed on —
 * still goes through `canonicalToken`.
 *
 * Exported so the ask input layer strips invisibles with THIS function rather
 * than a second copy of the character classes. A prompt normalizer that
 * disagreed with the class/archetype normalizer about what a zero-width space
 * is would be exactly the drift the note at the top of this file warns about.
 *
 * An empty result is `null`, never `''` — see {@link canonicalToken}.
 */
export function normalizeText(value: unknown): string | null {
  // NOT `value == null`. `dataClass` and `queryType` reach here from jsonb
  // (`ask_grants.scope.dataClasses`, `asks.query`) and from service callers that
  // bypass the GraphQL/zod schemas, so the declared `string` type is a claim,
  // not a guarantee — a row written by a migration, a fixture, or a peer that
  // predates the schema can hold a number, an object, or an array. This used to
  // call `.normalize()` on whatever it was handed, which throws a TypeError on
  // every non-string, and that throw surfaces as a 500 from deep inside consent
  // evaluation (`AskService.submit` has already inserted the ask row by then, so
  // the failure also strands it).
  //
  // A non-string is NOT coerced to its `String()` form: `42` is not a class the
  // owner wrote down, and coercing would invent one — and an attacker-supplied
  // object with a `toString` would get to choose it. It reads as "no class
  // named", which both call sites already resolve toward denial: a block covers
  // an ask that names no class, and (see `autoGrantNamesQueryClass`) an `auto`
  // grant does not.
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = stripInvisible(value.normalize('NFKC')).replace(UNICODE_SPACE, ' ').trim();

  return normalized ? normalized : null;
}

/**
 * Whether {@link normalizeText} would strip anything from this string as a
 * character that renders as nothing.
 *
 * The ask input layer stores the prompt without them, so by the time the
 * owner's review card renders it there is nothing left to detect. This is
 * what lets the card still say the text was altered (see
 * `AskQuery.promptHiddenCharactersRemoved`). Same strip as
 * {@link normalizeText}, so the two cannot disagree about what counts: an
 * emoji's own joiner or variation selector is not a hidden character.
 */
export function hasInvisibleCharacters(value: unknown): boolean {
  return typeof value === 'string' && stripInvisible(value.normalize('NFKC')) !== value.normalize('NFKC');
}

/**
 * The shared normalizer plus case folding — the COMPARISON form.
 *
 * Lowercasing is last, so it applies to whatever NFKC produced.
 *
 * An empty result is `null`, never `''`: the callers read "no class named" off
 * a nullish value, and an empty string is not a class the owner wrote down.
 */
function canonicalToken(value: unknown): string | null {
  return normalizeText(value)?.toLowerCase() ?? null;
}

/**
 * Canonical form of a data class, for BOTH grant matching and query execution.
 *
 * Accepts `unknown` deliberately — see {@link canonicalToken}. The parameter is
 * widened rather than the callers being asked to pre-validate, because there are
 * three of them on the security path and the one that forgets is the one that
 * 500s.
 */
export function canonicalDataClass(value: unknown): string | null {
  return canonicalToken(value);
}

/**
 * Canonical form of a query type — the ask's ARCHETYPE, and the other half of
 * the grant-matching key.
 *
 * This did not exist, and `grantMatch` compared `grant.queryType` to
 * `query.queryType` RAW while routing `dataClass` through the canonicalizer
 * next door. The result was a block that a peer could walk straight past:
 * a block on `photos` denied `photos` and let `Photos`, `PHOTOS` and
 * `'photos '` through to owner review, from where a broad `auto` grant or an
 * inattentive tap answers them. The warning at the top of this file — mirror
 * the normalization everywhere — was written for `dataClass` and simply was
 * not honoured for the field beside it.
 */
export function canonicalQueryType(value: unknown): string | null {
  return canonicalToken(value);
}

/**
 * Canonical form of a stated PURPOSE, for the one place a purpose is matched:
 * a purpose-limited grant against the ask that claims the same purpose.
 *
 * ═══ WHY IT IS ITS OWN FUNCTION AND NOT `canonicalDataClass` ═══
 *
 * `scopeCoversQuery` compared purposes by running both through
 * `canonicalDataClass`. That works today only because the three canonicalizers
 * happen to share one implementation — and the whole reason this file exists is
 * that they must not be assumed to. A data class is a token from a closed
 * vocabulary and may one day be singularized, aliased or mapped; a purpose is a
 * short human phrase and must not be. Borrowing the wrong one is how "photos"
 * and "photo" would start meaning the same purpose.
 *
 * Same normalizer TODAY, different contract, and the contract is what a future
 * change will read.
 */
export function canonicalPurpose(value: unknown): string | null {
  return canonicalToken(value);
}

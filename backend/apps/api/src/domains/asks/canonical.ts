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
 * Zero-width space / non-joiner / joiner, word joiner, soft hyphen, the
 * bidi/isolate formatting marks, and the BOM.
 */
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060-\u2064\u206a-\u206f\ufeff]/gu;

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

  const normalized = value.normalize('NFKC').replace(INVISIBLE, '').replace(UNICODE_SPACE, ' ').trim();

  return normalized ? normalized : null;
}

/**
 * Whether {@link normalizeText} would strip anything from this string as a
 * character that renders as nothing.
 *
 * The ask input layer stores the prompt without them, so by the time the
 * owner's review card renders it there is nothing left to detect. This is
 * what lets the card still say the text was altered (see
 * `AskQuery.promptHiddenCharactersRemoved`). Same character class as the
 * strip, so the two cannot disagree about what counts.
 */
export function hasInvisibleCharacters(value: unknown): boolean {
  return typeof value === 'string' && value.search(INVISIBLE) !== -1;
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

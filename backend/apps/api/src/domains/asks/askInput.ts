import { BadRequestException } from '@nestjs/common';

import { ASK_ARCHETYPES, type AskArchetype } from './askGrammar';
import { canonicalQueryType, normalizeText } from './canonical';
import { DISCLOSURE_RUNGS } from './policy';
import type { AskActor, AskActorKind, AskQuery, DisclosureRung } from './types';

/**
 * The boundary where an asker's raw strings become an {@link AskQuery}.
 *
 * ═══ WHY THIS IS A MODULE AND NOT THREE LINES IN THE RESOLVER ═══
 *
 * `AskQueryInput` declares `queryType: String` and `prompt: String` and nothing
 * else, which meant the two attacker-controlled fields on the whole consent
 * surface arrived unbounded and un-normalized: a prompt of any length in any
 * spelling, and an archetype that could be any word at all. Both are stored in
 * `ci.asks.query` (jsonb), replayed into `ci.ask_audit.query`, and rendered in
 * the owner's review inbox — so they are read by a human who is about to
 * consent, and matched against the owner's standing grants by a machine that
 * is about to consent for them.
 *
 * Keeping the rules here rather than in the resolver body buys three things:
 * they are unit-testable without Nest, they apply to every caller of the
 * resolver (including tests and any future controller, which is where a
 * GraphQL-schema-only constraint would not reach), and there is ONE statement
 * of "what an ask may say" instead of one per mutation.
 *
 * REJECT, NEVER TRUNCATE. A silently shortened prompt is a different question
 * from the one the asker wrote, shown to the owner as though it were theirs,
 * and consented to on that basis. A 400 is the only honest answer.
 */

/**
 * The longest prompt an ask may carry, matching `askGrammarSchema.prompt`.
 *
 * The same number in both places on purpose: the DCQL grammar
 * ({@link askGrammarSchema}) is the shape this input is a flat projection of,
 * and a cap that differed would mean an ask expressible through one door and
 * not the other.
 */
export const MAX_ASK_PROMPT_LENGTH = 500;

/**
 * The most raw input we will normalize, before anything is measured.
 *
 * NFKC normalization is O(n) but allocates, and the invisible/space passes are
 * two more scans — so an unbounded string reaches three full passes before the
 * length check that was supposed to stop it. This bound is checked FIRST, on
 * the raw value, purely so that work is never done. It is deliberately far
 * above {@link MAX_ASK_PROMPT_LENGTH}: stripping invisibles can only shorten a
 * string, and a prompt padded with legitimate combining marks must still be
 * judged on its normalized length, not its byte count.
 */
export const MAX_RAW_ASK_PROMPT_LENGTH = MAX_ASK_PROMPT_LENGTH * 8;

/** The longest data class an ask may name, matching `askQuerySpecSchema.dataClass`. */
export const MAX_ASK_DATA_CLASS_LENGTH = 60;

/** {@link MAX_RAW_ASK_PROMPT_LENGTH}, for the class field. Same argument. */
export const MAX_RAW_ASK_DATA_CLASS_LENGTH = MAX_ASK_DATA_CLASS_LENGTH * 8;

/**
 * The ask's archetype, constrained to the vocabulary the rest of the domain
 * actually speaks.
 *
 * ═══ AN OPEN VOCABULARY DEFEATS EVERY BLOCK GRANT ═══
 *
 * Standing grants are keyed on (grantee, queryType) and matched by canonical
 * string equality (`classMatchesQuery`). While `queryType` was a free string,
 * that key was chosen by the ASKER: an owner who blocked `photos` was evaded by
 * an asker who wrote `pictures`, `snaps`, or `photos-2` — the block did not
 * match, the evaluation fell through to the review default, and the prompt
 * landed in the owner's inbox again. Canonicalizing the comparison (which
 * `canonical.ts` does) closes the SPELLING variants of one word; it cannot
 * close the choice of a different word. Only a closed vocabulary can.
 *
 * {@link ASK_ARCHETYPES} is that vocabulary and is not invented here — it is
 * what `askGrammarSchema` already accepts, what `toAskQuery` already projects
 * into `queryType`, and what the peer protocol already puts on the wire. This
 * makes the flat GraphQL input agree with the two doors that were already
 * closed.
 *
 * WHAT IT COSTS, STATED PLAINLY: a grant row whose `query_type` is not an
 * archetype can no longer match any ask, because no ask can name one. For a
 * `review` or `auto` grant that is a tightening (it stops authorizing).
 * For a `block` it is a LOOSENING relative to the owner's intent — the block
 * stops firing — which is why {@link parseGrantQueryType} closes the writing
 * end too, and why any pre-existing rows want migrating to an archetype plus a
 * `data_class`. Note the ask does not become answerable: an unmatched ask is
 * `review`, the documented floor of this gate, not `auto`.
 *
 * NOT a GraphQL enum, though the schema-level check would be stronger. Two
 * reasons: the checked-in `__generated__/schema.graphql` is what the web app's
 * codegen reads, so turning a String field into an enum desynchronizes a
 * generated artifact this change does not own; and a schema enum is enforced by
 * the GraphQL layer only, so every caller that reaches the resolver directly —
 * including every unit test — would be unprotected and the control would be
 * un-mutation-testable. A checked value is enforced for all of them.
 */
export function parseAskQueryType(raw: unknown): AskArchetype {
  const canonical = canonicalQueryType(raw);

  if (canonical == null || !(ASK_ARCHETYPES as readonly string[]).includes(canonical)) {
    throw new BadRequestException(`queryType must be one of: ${ASK_ARCHETYPES.join(', ')}`);
  }

  return canonical as AskArchetype;
}

/**
 * The same vocabulary, on the WRITING end of the consent matrix.
 *
 * An owner writing `block` on a word no ask can ever carry has written nothing,
 * and the Grant Manager would show it to them as live protection. Constraining
 * the grant input is what keeps "I blocked this" and "this is blocked" the same
 * statement — see {@link parseAskQueryType} for the direction that matters.
 */
export function parseGrantQueryType(raw: unknown): AskArchetype {
  return parseAskQueryType(raw);
}

/**
 * The asker's natural-language question: normalized, bounded, never truncated.
 *
 * Normalization is {@link normalizeText} — the SAME function `canonicalDataClass`
 * and `canonicalQueryType` are built on, minus the case fold. Reusing it rather
 * than writing a second normalizer is the point: the prompt is displayed
 * beside the class and the archetype in the owner's review inbox, and a prompt
 * that could still carry `pho<U+200B>tos` while the class beside it could not
 * would let an asker write two different questions that render identically —
 * one for the human reading the inbox, one for anything that later reads the
 * stored jsonb.
 *
 * Case is preserved. The prompt is the asker's own sentence and the owner reads
 * it before consenting; `inferAnswerForm` lowercases its own copy for matching
 * and does not need this one folded.
 */
export function parseAskPrompt(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('prompt must be a string');
  }

  // Before normalizing, not after — see {@link MAX_RAW_ASK_PROMPT_LENGTH}.
  if (raw.length > MAX_RAW_ASK_PROMPT_LENGTH) {
    throw new BadRequestException(`prompt must be at most ${MAX_ASK_PROMPT_LENGTH} characters`);
  }

  const prompt = normalizeText(raw);

  // Nullish covers both "not a string" and "nothing but whitespace and
  // invisibles" — a prompt made entirely of zero-width characters renders as an
  // empty question in the owner's inbox, which is not something to consent to.
  if (prompt == null) {
    throw new BadRequestException('prompt must not be empty');
  }

  if (prompt.length > MAX_ASK_PROMPT_LENGTH) {
    throw new BadRequestException(`prompt must be at most ${MAX_ASK_PROMPT_LENGTH} characters`);
  }

  return prompt;
}

/**
 * The optional data class, bounded and normalized.
 *
 * Left as free text rather than an enum: the class vocabulary is genuinely open
 * (`SENSITIVE_CLASSES`, `CLASS_TYPE_HINTS` and the tier table each name their
 * own members and treat everything else as "some ordinary class"), and every
 * consumer already routes it through `canonicalDataClass`. What it did not have
 * was a LENGTH, so a megabyte of text could be stored in `ci.asks.query` and
 * replayed into every audit row for that ask.
 *
 * Stored in normalized-but-not-folded form for the same reason the prompt is:
 * this string is rendered to the owner. The comparison form is still derived by
 * `canonicalDataClass` at every consumer, so a class that reaches here as
 * `Photos` still matches a `photos` block.
 */
export function parseAskDataClass(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }

  if (typeof raw !== 'string') {
    throw new BadRequestException('dataClass must be a string');
  }

  if (raw.length > MAX_RAW_ASK_DATA_CLASS_LENGTH) {
    throw new BadRequestException(`dataClass must be at most ${MAX_ASK_DATA_CLASS_LENGTH} characters`);
  }

  const dataClass = normalizeText(raw);

  // An empty class is the ABSENCE of one, not a class named "". Both readings
  // resolve toward denial downstream (a block covers a class-less ask; an
  // `auto` grant does not cover one — see `autoGrantNamesQueryClass`), so
  // folding whitespace to `undefined` here is the fail-closed direction.
  if (dataClass == null) {
    return undefined;
  }

  if (dataClass.length > MAX_ASK_DATA_CLASS_LENGTH) {
    throw new BadRequestException(`dataClass must be at most ${MAX_ASK_DATA_CLASS_LENGTH} characters`);
  }

  return dataClass;
}

/**
 * Parse the whole asker-supplied query. The only shape allowed downstream.
 *
 * ORDER: the archetype is checked first, so an ask with an unusable queryType
 * is refused before a 4KB prompt is normalized. That is a denial-of-service
 * nicety, not a security property — every field is checked regardless.
 */
export function parseAskQueryInput(raw: {
  queryType: unknown;
  dataClass?: unknown;
  prompt: unknown;
  actor?: unknown;
}): AskQuery {
  const queryType = parseAskQueryType(raw.queryType);
  const dataClass = parseAskDataClass(raw.dataClass);
  const prompt = parseAskPrompt(raw.prompt);
  const actor = parseAskActor(raw.actor);

  // Built field by field rather than spread from `raw`: the input object is
  // attacker-shaped, and spreading it would carry unknown keys straight into
  // the `ci.asks.query` jsonb column and from there into the audit replay.
  return {
    queryType,
    prompt,
    ...(dataClass == null ? {} : { dataClass }),
    ...(actor == null ? {} : { actor }),
  };
}

/** The actor kinds an ask may declare. Anything else is not an actor. */
export const ASK_ACTOR_KINDS: readonly AskActorKind[] = ['person', 'first-party-agent', 'third-party-agent'];

/** The longest label an acting agent may carry. Shown to a human, so bounded like a prompt. */
export const MAX_ACTOR_LABEL_LENGTH = 80;

/**
 * Parse a declared actor.
 *
 * ═══ AN UNPARSEABLE ACTOR IS NO ACTOR, NOT A DEFAULTED ONE ═══
 *
 * Returns `undefined` for anything off-contract rather than throwing, and
 * rather than defaulting to `person`. Both alternatives are wrong in the same
 * direction:
 *
 * - defaulting to `person` would let an agent satisfy a `delegation: 'none'`
 *   grant by sending a malformed actor, which is strictly easier than sending
 *   an honest one;
 * - throwing would make a field nobody sends today into a hard error on every
 *   legacy client.
 *
 * `undefined` satisfies no delegation restriction at all (see
 * `actorSatisfiesDelegation`), so the failure mode is owner review — the
 * documented floor of this gate.
 *
 * The LABEL is truncated rather than rejected, unlike a prompt. A prompt is the
 * question being consented to and must never be silently altered; a label is
 * decoration beside it, and an over-long one should not cost the asker their
 * ask.
 */
export function parseAskActor(raw: unknown): AskActor | undefined {
  if (raw == null || typeof raw !== 'object') {
    return undefined;
  }

  const candidate = raw as { kind?: unknown; label?: unknown };
  const kind = typeof candidate.kind === 'string' ? candidate.kind.trim().toLowerCase() : '';

  if (!(ASK_ACTOR_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }

  // `normalizeText` is total over `unknown` and answers null for anything it
  // cannot normalize, so the null check is the one that matters here — not the
  // typeof above it.
  const normalized = normalizeText(candidate.label)?.slice(0, MAX_ACTOR_LABEL_LENGTH) ?? '';
  const label = normalized.trim() ? normalized : undefined;

  return label == null ? { kind: kind as AskActorKind } : { kind: kind as AskActorKind, label };
}

/**
 * Parse an owner-supplied disclosure rung at the API boundary.
 *
 * REJECTS rather than coercing, which is the opposite direction from
 * `grantMatch.ceilingOf` and `ceilingForShare` — and both are right for where
 * they sit. Those two READ a value that is already stored and must fail closed,
 * because the alternative is disclosing more than the owner asked for. This one
 * WRITES, and an owner who typed `summry` meant a restriction: silently storing
 * `none` would hand them a share that discloses nothing and no explanation, so
 * a 400 they can act on is the honest answer.
 *
 * `null`/`undefined` pass through as "no ceiling declared", which is a real and
 * intentional posture (the pre-existing behaviour of every share).
 */
export function parseDisclosureRung(raw: unknown, field = 'maxDisclosure'): DisclosureRung | null {
  if (raw == null) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }

  const canonical = raw.trim().toLowerCase();
  if (!(DISCLOSURE_RUNGS as readonly string[]).includes(canonical)) {
    throw new BadRequestException(`${field} must be one of: ${DISCLOSURE_RUNGS.join(', ')}`);
  }

  return canonical as DisclosureRung;
}

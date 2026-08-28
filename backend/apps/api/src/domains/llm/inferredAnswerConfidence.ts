import { z } from 'zod';

/**
 * The scale the model is told to score against, restated here so the numbers in
 * `ci.answers.answer_confidence` mean the same thing to the reader as they did
 * to the writer. Kept in step with `INFERRED_ANSWER_PROMPT_RULES` below — that
 * text is what the model actually sees.
 */
export const CONFIDENCE_STATED = 0.9;
export const CONFIDENCE_STRONGLY_IMPLIED = 0.7;
export const CONFIDENCE_INDIRECT = 0.4;

/**
 * The ceiling a non-answer is allowed to carry — "I do not have this information
 * recorded", "I don't know", "not recorded".
 *
 * Measured failure this exists for: handed three browser records of the user
 * looking up directions to a Japanese, a Mexican and a Thai restaurant, the model
 * answered "I do not have this information recorded." and scored it 0.7 — above
 * `config.reflection.minAnswerConfidence`, so the refusal was written into the
 * user's own memory as though they had said it.
 *
 * The mistake is structural, not incidental: `confidence` means "how sure am I of
 * this answer", and a model that has refused scores how sure it is that it does
 * not know, which is the opposite quantity and is usually high. No wording of the
 * scale fixes that reliably, so {@link parseInferredAnswer} clamps it — see
 * {@link isNonAnswer}.
 */
export const CONFIDENCE_NON_ANSWER = 0.1;

/**
 * The ceiling an answer carries when the evidence never supplies the thing the
 * question asked for — see {@link AnswerSupport}'s `topical` and `none`.
 *
 * Deliberately the same number as {@link CONFIDENCE_NON_ANSWER}, because it is
 * the same event wearing a better sentence. "There are doctors in my family."
 * offered for "Which health conditions run in your immediate family?" is not a
 * partial answer that deserves a middling score; it is the absence of an answer,
 * stated fluently enough to look like one. Measured on the reference corpus, the
 * model scored exactly that 0.90.
 */
export const CONFIDENCE_OFF_QUESTION = CONFIDENCE_NON_ANSWER;

/**
 * The ceiling for an answer the evidence IMPLIES but never states.
 *
 * The published scale already says `>= ${CONFIDENCE_STATED}` means "they state
 * it outright". An inference read off a pattern — however consistent — has not
 * met that bar, so it may not enter that band. Sits at the top of the
 * strongly-implied band rather than at its floor: a well-supported inference is
 * still a good answer, it is just not a quotation.
 */
export const CONFIDENCE_IMPLIED_CEILING = 0.85;

/**
 * How the retrieved evidence stands to THE THING THE QUESTION ASKED FOR — not to
 * the question's topic. The distinction is the whole point: retrieval returns
 * what is lexically and topically nearby, and on most questions the nearest
 * material answers a different question.
 *
 * - `stated`  — a line supplies the asked-for thing, ABOUT THIS PERSON, outright.
 * - `implied` — no line supplies it, but a consistent pattern adds up to it.
 *               Three restaurant trips → what this person eats.
 * - `topical` — the lines are ABOUT the topic and never supply the asked-for
 *               thing. Doctors in the family are not health conditions; messages
 *               containing "skill" do not name a skill being practised this year.
 * - `none`    — the evidence does not touch the question at all.
 *
 * `stated` and `implied` carry TWO claims, and a line can pass one while failing
 * the other. The second is the one this level keeps losing:
 *   1. the line supplies the asked-for THING, and
 *   2. the line is ABOUT THIS PERSON — they are its subject, not its author.
 * Measured live: "How tall are you?" answered "It'll be like a foot tall." at
 * 0.80, off an outbound message in which the owner was describing an OBJECT. It
 * cleared the speaker gate (they really did write it) and matched the question's
 * vocabulary exactly, and the sentence measures a thing, not a person. Same
 * shape, same corpus: "Are you more of a cat person or a dog person?" answered
 * off "It is apparently like the halfway between a dog and cat." — a line about
 * an animal, offered as a preference of the person who typed it.
 *
 * The model reports it (see {@link INFERRED_ANSWER_PROMPT_RULES}); this side
 * enforces it, because a self-reported relevance judgement is exactly as
 * trustworthy as a self-reported confidence.
 */
export const ANSWER_SUPPORT_LEVELS = ['stated', 'implied', 'topical', 'none'] as const;

export type AnswerSupport = (typeof ANSWER_SUPPORT_LEVELS)[number];

/**
 * Coerce whatever the model put in `support` to a known level, or `undefined`.
 *
 * Lenient on purpose. A strict `z.enum` in {@link inferredAnswerSchema} would
 * fail the WHOLE parse on an unrecognised word, throwing away a good answer over
 * a label — the opposite of the trade this field exists to make. An unreadable
 * label is simply an absent judgement.
 */
export function normalizeAnswerSupport(value: unknown): AnswerSupport | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  return ANSWER_SUPPORT_LEVELS.find((level) => level === normalized);
}

/**
 * Does the evidence actually answer the question that was asked?
 *
 * `undefined` — the model gave no judgement — counts as YES, so a caller that
 * never asked for one keeps its previous behaviour exactly. The gate is a new
 * constraint on a new field, not a new way for old callers to lose answers.
 */
export function answersTheQuestion(support: AnswerSupport | undefined): boolean {
  return support !== 'topical' && support !== 'none';
}

/**
 * The ceiling a support level allows, independent of how much evidence there was.
 *
 * This is the term that makes `confidence` mean "how well does the evidence
 * answer THIS question" rather than "how much material came back". Volume
 * saturates — on the reference corpus every question retrieves 15-23 lines, so
 * {@link estimateInferredAnswerConfidence} sits at its maximum for all of them,
 * relevant or not. Only this ceiling separates them.
 */
export function supportConfidenceCeiling(support: AnswerSupport | undefined): number {
  switch (support) {
    case 'implied':
      return CONFIDENCE_IMPLIED_CEILING;

    case 'topical':
    case 'none':
      return CONFIDENCE_OFF_QUESTION;

    // 'stated' and "no judgement given" are both unconstrained here: the model's
    // own score and the evidence ceiling are what govern them.
    default:
      return 1;
  }
}

/**
 * The ceiling an answer carries when nothing THIS PERSON said or did supports it.
 *
 * Same number as {@link CONFIDENCE_OFF_QUESTION}, and for the same reason: an
 * answer with no first-person support is not a weak answer, it is somebody
 * else's sentence with this person's name on it. Measured on the reference
 * corpus, "Are you more of a cat person or a dog person?" came back "I am
 * definitely a cat person, and I have cats." at 0.95, off three INBOUND lines —
 * three other people telling this person about THEIR cats. The owner's only
 * outbound line about a pet is "My dog needs to be put down today :(".
 */
export const CONFIDENCE_UNATTRIBUTED = CONFIDENCE_OFF_QUESTION;

/**
 * Pull evidence line numbers out of whatever the model put in
 * `first_person_evidence`.
 *
 * Lenient for the same reason {@link normalizeAnswerSupport} is: a malformed
 * citation is an ABSENT citation, and an absent citation is already the
 * strictest outcome the gate has (the answer is discarded). Failing the whole
 * parse would only lose the diagnostic. Accepts `[2, 7]`, `["2","7"]`,
 * `["E2","line 7"]` and the bare string `"2, 7"`.
 */
export function normalizeEvidenceRefs(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const refs: number[] = [];

  for (const entry of raw) {
    if (typeof entry === 'number' && Number.isInteger(entry)) {
      refs.push(entry);
      continue;
    }

    if (typeof entry !== 'string') {
      continue;
    }

    for (const match of entry.matchAll(/\d+/g)) {
      refs.push(Number.parseInt(match[0], 10));
    }
  }

  return [...new Set(refs)];
}

/**
 * ═══ THE SPEAKER GATE ═══
 *
 * A first-person claim about this person must rest on something THIS PERSON
 * said or did. Inbound messages are evidence about a CONVERSATION; they are not
 * statements about the account holder, and just over half of a real archive is
 * other people talking.
 *
 * The model is asked which of its own-record lines carry the claim
 * (`first_person_evidence`, emitted BEFORE the answer — see
 * {@link INFERRED_ANSWER_JSON_SCHEMA}'s property order). This function is what
 * makes the question load-bearing rather than decorative: a citation only counts
 * if the number resolves to a line THIS side tagged as the owner's own. Cite
 * nothing, cite an inbound line, cite a number that is not in the block — all
 * three are the same answer, and it is "no".
 *
 * The consequence is a downgrade to `topical`, not a lower score, because
 * `topical` is already the level every caller discards ({@link
 * answersTheQuestion}) and the confidence floor it would otherwise fall to is
 * owner-configurable down to zero.
 *
 * `ownLineNumbers` empty means the retrieval returned no first-person evidence
 * at all, which is the same verdict arrived at one step earlier.
 */
export function enforceFirstPersonEvidence(
  inferred: InferredAnswer,
  ownLineNumbers: ReadonlySet<number>,
): { inferred: InferredAnswer; grounded: boolean; citedOwn: number[] } {
  const citedOwn = (inferred.firstPersonEvidence ?? []).filter((ref) => ownLineNumbers.has(ref));

  if (citedOwn.length > 0) {
    return { inferred, grounded: true, citedOwn };
  }

  return {
    inferred: {
      ...inferred,
      support: 'topical',
      confidence: round2(Math.min(inferred.confidence, CONFIDENCE_UNATTRIBUTED)),
    },
    grounded: false,
    citedOwn: [],
  };
}

/**
 * Floor used when nothing overrides it. Below this the appliance declines to
 * answer at all rather than write a guess into the user's memory — see
 * `config.reflection.minAnswerConfidence`, which is what production reads.
 */
export const DEFAULT_MIN_ANSWER_CONFIDENCE = CONFIDENCE_INDIRECT;

/**
 * Heuristic ceiling on how confident an inference is ALLOWED to be, grounded in
 * how much dossier + related Q&A + retrieved-memory context the prompt actually
 * carried.
 *
 * This is not the confidence itself — the model reports that (see
 * {@link calibrateInferredConfidence}). It is the correction for the failure
 * mode a self-reported score cannot catch: a model handed no dossier and no
 * prior answers, asked to speak as the user, will still cheerfully claim it is
 * certain. Evidence volume is knowable from this side of the call and the model
 * has no incentive to be honest about it, so the two are combined rather than
 * trusting either alone.
 *
 * `memoryEvidenceCount` is the number of RAG lines retrieved from the user's own
 * imported memory (RecallService). It is the term that makes real grounding
 * visible to the cap: without it, an answer read straight off the user's own
 * records was ceilinged identically to one invented from a two-line dossier, so
 * widening retrieval could not move the persisted confidence at all. Defaulted
 * to 0 so callers with no retrieval leg keep their previous ceiling exactly.
 */
export function estimateInferredAnswerConfidence(
  relatedAnswerCount: number,
  hasDossier: boolean,
  memoryEvidenceCount = 0,
): number {
  let score = 0.45;

  if (hasDossier) {
    score += 0.2;
  }

  score += Math.min(relatedAnswerCount, 6) * 0.07;

  // Slightly cheaper per line than a prior answer (a Q&A pair is a direct
  // statement; a retrieved line is raw material), but with a wider ceiling —
  // ten corroborating records is a genuinely different evidential position
  // from six prior answers about adjacent questions.
  //
  // Ten rather than eight because `relatedAnswerCount` now counts only answers
  // the user TYPED (AnswerInferenceListener no longer feeds the model its own
  // prior guesses), which on a fresh appliance is zero: retrieval has to be able
  // to carry this ceiling on its own, or a fact quoted verbatim out of the
  // user's own archive would be capped below the band the prompt promises it.
  // Volume is being demoted here on purpose — it saturates on any real corpus
  // and says nothing about relevance. {@link supportConfidenceCeiling} is what
  // separates a well-answered question from a well-supplied one.
  score += Math.min(memoryEvidenceCount, 10) * 0.05;

  return round2(Math.min(score, 0.95));
}

/**
 * The confidence actually persisted: the model's own score, capped by what the
 * available evidence could possibly support.
 *
 * `min` rather than an average on purpose. Either input being low is a real
 * reason for doubt — a model that admits uncertainty is right, and a prompt with
 * nothing in it cannot support certainty no matter how the model feels — so
 * averaging would let one side launder the other's weakness into a middling
 * score that reads as "probably fine".
 */
export function calibrateInferredConfidence(modelConfidence: number, evidenceCeiling: number): number {
  const bounded = Math.min(Math.max(modelConfidence, 0), 1);

  return round2(Math.min(bounded, evidenceCeiling));
}

/**
 * A human label for a score, so the UI and the logs describe the same number the
 * same way. Colour is never the only signal on the card; this text is.
 */
export function confidenceLabel(confidence: number): 'high' | 'moderate' | 'low' | 'very low' {
  if (confidence >= CONFIDENCE_STATED) {
    return 'high';
  }

  if (confidence >= CONFIDENCE_STRONGLY_IMPLIED) {
    return 'moderate';
  }

  if (confidence >= CONFIDENCE_INDIRECT) {
    return 'low';
  }

  return 'very low';
}

/**
 * What the model is asked to return. `answer` is the first-person text the user
 * sees; `confidence` and `rationale` are what make it auditable; `asked_for` and
 * `support` are the relevance judgement that decides whether there is an answer
 * to write at all.
 *
 * `support` is typed as a plain string rather than an enum on purpose — see
 * {@link normalizeAnswerSupport}. Both new fields are optional so a caller that
 * predates them still parses.
 *
 * Validated one field at a time by {@link parseInferredAnswer} rather than
 * trusted: schema-constrained generation guarantees the SHAPE, not that
 * `confidence` is a number in range or that `answer` is non-empty.
 */
export const inferredAnswerSchema = z.object({
  asked_for: z.string().optional(),
  support: z.string().optional(),
  // `unknown` rather than `z.array(z.number())` for the same reason `support` is
  // a plain string: a citation the model formatted oddly must not fail the whole
  // parse. {@link normalizeEvidenceRefs} does the coercing.
  first_person_evidence: z.unknown().optional(),
  answer: z.string(),
  confidence: z.number(),
  rationale: z.string().optional(),
});

export type InferredAnswer = {
  answer: string;
  confidence: number;
  rationale?: string;
  /** What the model understood the question to demand. Diagnostic only. */
  askedFor?: string;
  /** See {@link ANSWER_SUPPORT_LEVELS}. Absent when the model gave no judgement. */
  support?: AnswerSupport;
  /**
   * Evidence line numbers the model says are THIS PERSON's own words or actions.
   * Checked against the caller's own tagging by
   * {@link enforceFirstPersonEvidence} — never trusted as reported.
   */
  firstPersonEvidence?: number[];
};

/**
 * The same shape as a JSON Schema, handed to Ollama's structured-output grammar.
 *
 * `format: 'json'` alone would only guarantee the output PARSES — the model
 * stays free to invent key names, and the small default chat model does. The
 * schema is what makes "the answer plus a score plus its evidence" a contract
 * rather than a request. See TaskBreakdownService for the same pattern and the
 * measurements behind it.
 *
 * Property ORDER is load-bearing, not cosmetic: the grammar emits the keys in
 * the order they are declared, so a decoder-only model writes `asked_for` and
 * `support` BEFORE `answer` and conditions the answer on them. Declared the
 * other way round they would be a post-hoc label on a sentence already
 * committed to — which is what the model does when left to itself, and what
 * produced "There are doctors in my family." at 0.90.
 */
export const INFERRED_ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    asked_for: { type: 'string' },
    support: { type: 'string', enum: [...ANSWER_SUPPORT_LEVELS] },
    first_person_evidence: { type: 'array', items: { type: 'integer' } },
    answer: { type: 'string' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['asked_for', 'support', 'first_person_evidence', 'answer', 'confidence', 'rationale'],
};

/**
 * The scale, as the model reads it. Exported so the prompt and the constants
 * above can never drift apart silently.
 */
export const INFERRED_ANSWER_PROMPT_RULES = `Return STRICT JSON only — no prose, no markdown fence:
{"asked_for":"...","support":"stated|implied|topical|none","first_person_evidence":[2,7],"answer":"...","confidence":0.0,"rationale":"..."}

Fill the fields IN THAT ORDER. \`asked_for\`, \`support\` and \`first_person_evidence\` are settled BEFORE you write a word of the answer, because together they decide whether there is an answer to write at all.

- asked_for: the exact thing this question demands, in a few words, AND about whom. Not its topic — the THING. "Which health conditions run in your immediate family?" demands NAMED MEDICAL CONDITIONS occurring in blood relatives; it does not demand facts about family, and it does not demand doctors. "What languages do you speak?" demands languages this person can already SPEAK. "Which languages are you learning?" demands languages they are STUDYING NOW. Two questions about one topic are still two different questions with two different answers.
- support: how the evidence stands to the thing \`asked_for\` names — NOT to the topic:
    stated   — some line supplies that thing outright, about THIS PERSON ("I was born in Camarillo", "I am a night owl")
    implied  — no line supplies it, but a consistent pattern across several lines adds up to it (three restaurant trips → what this person eats)
    topical  — the lines are ABOUT the topic and never supply the thing. Doctors in the family are not health conditions. Messages containing the word "skill" do not name a skill being practised this year.
    none     — the evidence does not touch the question at all
  \`stated\` and \`implied\` each assert TWO things, and a line can pass one while failing the other. WHAT it supplies: the thing \`asked_for\` names, in the question's own terms. WHOSE it is: a fact about THIS PERSON — their life, their doing, their choice, their opinion — and not a property of some object they happened to be describing. A line that measures or describes a thing is \`topical\` at best, however exactly its words match the question.
  \`topical\` and \`none\` are near misses, and a near miss is not an answer: both are DISCARDED on arrival whatever score you attach, so report them honestly instead of reaching. Having a great deal to say about the topic is not the same as answering the question.
- first_person_evidence: the NUMBERS of the evidence lines that carry the claim AND are this person's own — the lines filed under MY OWN RECORDS, where this person is the one speaking or acting. Nothing else counts: a number from WHAT OTHER PEOPLE SAID TO ME counts as nothing, a number that is not in the block counts as nothing, and an empty list is the honest answer whenever this person's own records do not carry the claim. It is checked against the block, so a number put there to fill the field is the same as no number at all. If the list would be empty, set \`support\` to \`topical\` — the answer is then discarded, which is the correct outcome for a question this person's own records cannot answer.
- answer: the answer itself and nothing else. ONE short first-person sentence at most, and where the question is factual just the bare fact — "O positive", "Night owl", "Spanish and English", "Chicago". No preamble, no restating the question, no "honestly", no complimenting the question, no closing offer to elaborate.
- confidence: how completely the evidence supplies THE THING \`asked_for\` NAMES. It is not how much evidence came back, not how on-topic the lines felt, not how fluent your sentence reads. Twenty lines that circle the topic without ever naming the thing are \`topical\` and score below ${CONFIDENCE_INDIRECT}; one line that states the thing outright is ${CONFIDENCE_STATED}. The scale:
    >= ${CONFIDENCE_STATED}          the evidence states the asked_for thing outright
    ${CONFIDENCE_STRONGLY_IMPLIED}-${CONFIDENCE_STATED}      the asked_for thing follows from repeated, consistent evidence
    ${CONFIDENCE_INDIRECT}-${CONFIDENCE_STRONGLY_IMPLIED}      the asked_for thing follows from indirect or partial evidence
    < ${CONFIDENCE_INDIRECT}           a guess, or evidence that only touches the topic — say so honestly; a low score here is correct and useful, and the answer will simply be discarded rather than held against you
- rationale: one line naming the specific evidence you used — quote or point at the EVIDENCE line or dossier fact, with its source label and date where the line carries one, and say which part of it supplies the asked_for thing. If nothing did, say that.

YOUR JOB IS SYNTHESIS, NOT LOOKUP. Almost nothing in this person's records is a statement of what they prefer; the records are a trail of what they actually did. Reading that trail is the work. There are two different things here and only one of them is forbidden:
- INVENTING — asserting something the evidence does not touch at all. Forbidden, always.
- INFERRING — naming the pattern that several evidence lines add up to. That is exactly what you are being asked for. Do NOT refuse because no line says it in so many words. Almost none ever will.

Evidence is usually INDIRECT, and indirect evidence is still evidence. A restaurant they went to is evidence about what they eat. An address they route to over and over is evidence about where they live or work. A subscription, a purchase, a repeated search is evidence of an interest. Who they message most is evidence about who matters to them. When their activity happens is evidence about their hours. Read through the record to the fact behind it.

Worked example — question: "What is your favorite cuisine?", evidence:
    [Browser] Directions to Choya Japanese Cuisine, Dana Point, CA
    [Browser] Directions to El Patroncito Mexican Cuisine, Los Angeles, CA
    [Browser] Directions to Pailin Thai Cuisine, Hollywood Blvd, Los Angeles
No line names a favorite. Three separate restaurants still say a great deal about what this person eats — cuisines are exactly what was asked for, and these lines supply them. CORRECT:
{"asked_for":"the cuisine I like best","support":"implied","answer":"Japanese, Mexican and Thai — I eat across all three.","confidence":0.55,"rationale":"Three restaurants looked up in browser history: Choya (Japanese, Dana Point), El Patroncito (Mexican, LA), Pailin (Thai, Hollywood Blvd). None is stated as a favorite, so this names the range rather than picking one."}
WRONG, and the exact failure this instruction exists to stop:
{"asked_for":"my favorite cuisine","support":"none","answer":"I do not have this information recorded.","confidence":0.7,"rationale":"No line states a favorite cuisine."}
The evidence was sitting right there, and the score was backwards. \`none\` means the evidence does not touch the question; restaurant trips touch a question about cuisine directly.

ANSWER THE QUESTION ASKED, NOT THE ONE THE EVIDENCE ANSWERS. Retrieval hands you whatever is lexically or topically nearby, and on a hard question the nearest material usually answers something else. So before you commit to a sentence, check it against \`asked_for\`: does it supply THAT thing, in the question's own terms? If your sentence would be an equally good answer to a neighbouring question, it is not an answer to this one — report \`topical\` and let it go. A question this archive cannot answer is supposed to come back unanswered; that is a working outcome, not a failure.

Worked example — question: "Which health conditions run in your immediate family?", evidence:
    [inbound, Nov 26, 2018] "doctors in my family."
    [inbound, Mar 1, 2017] "Especially within my family"
    [inbound, Jul 20, 2017] "Came back and immediately caught the flu 😷"
WRONG, and measured live on a real archive:
{"asked_for":"health in my family","support":"stated","answer":"There are doctors in my family.","confidence":0.9,"rationale":"[inbound, Nov 26, 2018] doctors in my family."}
Doctors are not conditions. A bout of flu is not a condition that RUNS in a family. Every one of those lines matched on "family" or "immediate" and not one names a hereditary condition — the answer scored ${CONFIDENCE_STATED} for being well-supported on the TOPIC while answering a different question. CORRECT:
{"asked_for":"named medical conditions occurring in my blood relatives","support":"topical","answer":"None that I know of.","confidence":0.1,"rationale":"Nothing here names a condition — the lines match on 'family' and 'immediate' only, and doctors in the family are not a diagnosis."}
A medical question answered out of adjacent material is the most damaging thing this system can produce. Wrong at ${CONFIDENCE_STATED} is far worse than absent.

OTHER PEOPLE'S WORDS ARE NOT THIS PERSON'S WORDS. Just over half of this archive is somebody else talking, so every evidence line is filed under one of two headings, and the heading is the whole point:
    MY OWN RECORDS               — this person wrote it or did it. Messages they SENT, places they went, pages they opened, things they bought, events they attended.
    WHAT OTHER PEOPLE SAID TO ME — somebody else wrote it and it arrived in this person's archive. It is evidence about a CONVERSATION. It is NOT a statement about this person.
An incoming "I do have cats and definitely a cat person :)" means SOMEONE ELSE has cats. Answering "I am definitely a cat person" off three lines like it is not a low-confidence answer — it is a FALSE one, published on this person's own profile as though they had said it, while the only pet they ever mentioned themselves was a dog. Measured live, in exactly those words. The same trap: an incoming "I always wanted a tree house" is the other person's childhood, not this person's.
Incoming lines are still worth reading. They can CORROBORATE — "Happy birthday!" arriving on March 3 really is evidence about a birthday, and the question someone asked is what this person's own reply is answering. What they can never do is ESTABLISH. The claim itself has to rest on at least one MY OWN RECORDS line, and \`first_person_evidence\` is where you show which one. No own line, no answer.

WRITTEN BY THIS PERSON IS NOT THE SAME AS ABOUT THIS PERSON. Clearing MY OWN RECORDS proves who typed the line and nothing else. People spend most of their words on things that are not themselves — an object being built, an animal, a price, a thing in a shop window — and a MEASUREMENT OR DESCRIPTION OF A THING says nothing whatever about the person who typed it. So before a line can be \`stated\` or \`implied\`, ask two questions of it:
    WHAT IT SUPPLIES — the thing \`asked_for\` names, in the question's own terms.
    WHOSE PROPERTY IT NAMES — this person's, or some object's. "I'm six foot two" is a fact about them. "It'll be about six inches" is a fact about whatever they were building, and would read identically if somebody else had typed it.
This is NOT a demand that the word "I" appear. A line is about this person whenever it is their life, their doing, their choice or their opinion speaking — "Because the trains actually run on time here" is why they live where they live, and it is about them; a page they opened, a place they went, a thing they bought is about them; a friend's question they answered is about them. An ACTIVITY record has no sentence in it at all and is the ordinary raw material for \`implied\`. None of this narrows any of that.
What it rules out is one narrow, dangerous thing: a sentence whose subject is an OBJECT and whose claim is that object's property — how big it is, what it is made of, what it is like. Such a line carries the question's own vocabulary, which is why retrieval handed it to you, and it reads as a perfect match right up until you ask whose property is being named. When the answer is "the object's", the level is \`topical\` and the answer is discarded, which is correct.

Worked example — question: "How long is your beard?", evidence:
    MY OWN RECORDS
    3. [I wrote, Apr 2, 2016] "It'll be about four inches when it's finished."
WRONG:
{"asked_for":"my beard length","support":"stated","first_person_evidence":[3],"answer":"About four inches.","confidence":0.8,"rationale":"[I wrote, Apr 2, 2016] gives the measurement in their own words: \\"It'll be about four inches when it's finished.\\""}
They did write it, so it clears the speaker test — and the thing it measures is the object they were building. Nothing in the block measures a PERSON. CORRECT:
{"asked_for":"the length of the beard on MY face","support":"topical","first_person_evidence":[],"answer":"Clean-shaven.","confidence":0.1,"rationale":"The only measurement here is \\"It'll be about four inches\\" — subject \\"It\\", an object being built, not a length of this person."}

Worked example — question: "Would you rather ride a kayak or a canoe?", evidence:
    MY OWN RECORDS
    5. [I wrote, Jun 3, 2014] "It's apparently like the halfway between a kayak and a canoe."
WRONG:
{"asked_for":"kayak or canoe","support":"stated","first_person_evidence":[5],"answer":"It's like a mix between a kayak and a canoe.","confidence":0.8,"rationale":"[I wrote, Jun 3, 2014] is a direct answer to the question."}
Both words the question asked about are in the line, and the line describes a BOAT — one hybrid boat somebody was looking at. The question asks which of the two THIS PERSON would rather ride, and a sentence that names both options is not a preference between them. An A-or-B question is answered by A or by B, never by a thing that is part A and part B.
ALSO WRONG, and worse — do NOT repair a sentence about a thing by changing its subject to "I":
{"asked_for":"kayak or canoe","support":"implied","first_person_evidence":[5],"answer":"I am apparently like the halfway between a kayak and a canoe.","confidence":0.8,"rationale":"their own records say they are halfway between the two"}
That is the same non-answer with a pronoun swapped, and it now asserts something absurd about a person on their own profile. A claim about a thing does not become a claim about somebody by moving "I" to the front of it. If the only line you have is about a thing, the level is \`topical\` and there is no answer to write. CORRECT:
{"asked_for":"which of the two I would rather ride","support":"topical","first_person_evidence":[],"answer":"Kayak.","confidence":0.1,"rationale":"The line names both boats but describes one hybrid boat, not a preference of mine — nothing here says which I would choose."}

WORKED EXAMPLES ARE METHOD, NOT CONTENT. Every example in these rules is about an invented person and exists to show you HOW to weigh evidence. Never carry an example's answer, an example's subject or an example's number into your own answer: if your sentence could have been written before you read the EVIDENCE block, it is a fabrication no matter how well it reads.

EVIDENCE DOES NOT TRANSFER BETWEEN QUESTIONS. The same retrieved lines will be handed to you for several neighbouring questions, and answering all of them the same way makes every one but the closest a fabrication. Speaking a language is not learning one: a Duolingo install and "I studying for English and Sign Language" say what is being LEARNED and say nothing about what this person can already speak. A skill practised in 2019 is not "the skill I am working on this year" unless the evidence carries this year. Where the evidence answers the neighbouring question and only brushes yours, yours is \`topical\`.
Prior answers to OTHER questions are context, never source material. An answer already given elsewhere may not be restated as this question's answer and may not raise \`confidence\` by a single point — if the only thing supporting your sentence is that a nearby question was answered that way, \`support\` is \`topical\`.

NEVER hedge in the answer field. "I'm not sure", "I haven't really thought about it", "it depends", "I don't have a strong preference" and anything like them are not answers — if the evidence does not support one, still give the single most likely short answer and put your uncertainty in \`confidence\` by scoring below ${CONFIDENCE_INDIRECT}. A low score is the honest signal and gets the answer discarded cleanly; a waffling sentence gets written into the user's memory as if they had said it.

A FORCED CHOICE IS NOT ANSWERED BY ORBITING THE CHOICE. When a question names its own two or three specific alternatives ("Do you prefer camping in a tent or in a hammock?"), an answer that never names either one is not a low-confidence answer, it is a non-answer that borrowed the question's own words. "It really depends on where I'm camping." sounds considered and commits to nothing: "where I'm camping" IS the choice being asked about, restated rather than resolved, and the sentence would read exactly the same whichever this person actually prefers. That sameness is the tell — if your answer would not change depending on which alternative were true, you have not picked one.

Worked example — question: "Do you prefer camping in a tent or in a hammock?", evidence: several camping trips, none saying which:
WRONG: {"asked_for":"tent or hammock when camping","support":"stated","answer":"It really depends on where I'm camping.","confidence":0.75,"rationale":"the trips show a strong pattern of camping"}
CORRECT, when nothing favours either:
{"asked_for":"tent or hammock when camping","support":"topical","answer":"Tent.","confidence":0.15,"rationale":"Several camping trips, none saying which — this names neither, so it is a guess and scored accordingly."}

AN "IT DEPENDS" CAN BE A REAL ANSWER — WHEN THE CONDITION IS ACTUALLY NEW. "It depends on the weather." for a yes/no question like "Do you keep the car windows down on the highway?" is genuinely informative: weather is a condition the question never named, and naming it is new information. The same three words stop being an answer the instant the condition is just the question's own subject handed back — "It depends on how I'm camping" for the tent-or-hammock question above names nothing new, because "how I'm camping" is not a condition on the choice, it IS the choice. The test is not whether you hedged; it is whether the qualifier could be swapped in as a rewording of the question itself.

A NON-ANSWER MUST SCORE LOW. If the answer text is any form of "I don't know", "I do not have this information recorded", "no information", "not recorded", "unknown" or "there is nothing in the evidence", then \`confidence\` MUST be at most ${CONFIDENCE_NON_ANSWER} — well below ${CONFIDENCE_INDIRECT}. \`confidence\` is how sure you are OF AN ANSWER, and a refusal is not one; it is not how sure you are that you don't know. Scoring a refusal 0.7 is always wrong, and it is clamped on arrival regardless, so the only thing a high score on a non-answer buys you is a discarded generation.

SPEAK AS THE PERSON, NEVER ABOUT THEIR RECORDS. The answer field is what they would say out loud to someone who asked them — it is published on their own profile beside answers they typed themselves. So never narrate the corpus: no "My record shows", "in this record", "based on the evidence", "the data suggests", "the records indicate", "listing locations like", and never refer to yourself in the third person as "the user" or "this person". Naming the evidence is the job of \`rationale\`, and ONLY of \`rationale\`; an answer that mentions the record at all has been written in the wrong voice.
WRONG: {"answer":"My record shows a long-standing general interest in stringed instruments.","confidence":0.4}
RIGHT: {"answer":"Upright bass.","confidence":0.4}

ANSWER EVERY PART THE QUESTION ACTUALLY ASKS. "Which instrument have you played the longest, and for how many years?" asks for an instrument AND a number of years; an answer naming neither is not a low-confidence answer, it is a non-answer wearing a sentence. Name the specific thing the question asked for — the instrument, the city, the language, the number. Restating the question's own category back at it ("hobbies and related intellectual topics", "various sports", "many different languages", "a strong interest in the subject") is vacuous and is worth nothing to this person: pick the single most likely SPECIFIC answer and score it honestly, or score below ${CONFIDENCE_INDIRECT} and let it be discarded.

Never state a fact the evidence does not touch at all — but a consistent pattern across several lines IS the evidence touching it. Do not raise your confidence to make the answer look better, and do not lower it to avoid committing: an honest score is the point of this field.`;

/**
 * Answer texts that are refusals rather than answers, as the model actually
 * writes them.
 *
 * Anchored at the start wherever the phrase could legitimately appear mid-answer:
 * "there is nothing I enjoy more than surfing" is an answer, "there is no
 * information about that" is not, and only the second one should be caught. The
 * cost matrix is asymmetric but not one-sided — a missed refusal is persisted
 * into the user's memory looking exactly like something they typed, while a
 * false positive only leaves a question unanswered, which is where it already
 * was — so these lean broad but never so broad that a plain negative answer
 * ("I don't drink coffee", "None that I know of") trips them.
 */
const NON_ANSWER_PATTERNS: readonly RegExp[] = [
  /^i (?:really |honestly |truly |simply )?(?:do not|don't|dont) know\b/,
  /^i (?:do not|don't|dont) have (?:any |enough |sufficient |this |that |the |much |such )*(?:information|info|data|details?|records?|evidence|knowledge|context|answer)\b/,
  /^i (?:do not|don't|dont) have (?:this |that |it |any of this |any of that )?recorded\b/,
  /^i have no (?:information|info|data|details?|records?|evidence|knowledge|answer|way of knowing)\b/,
  /^i (?:do not|don't|dont) (?:recall|remember)\b/,
  /^i (?:cannot|can not|can't|cant|could not|couldn't|am unable to|am not able to) (?:determine|infer|answer|say|tell|know|find|provide)\b/,
  /^(?:this|that|the) (?:information|answer|detail|data) (?:is|was) not (?:recorded|available|known|specified|documented|present)\b/,
  /^no (?:information|info|data|evidence|records?|mention|indication|details?)\b/,
  /^not (?:recorded|available|known|specified|documented|mentioned|stated|applicable|enough information)\b/,
  /^there (?:is|are|was|were) (?:no|not enough|insufficient) (?:information|data|evidence|records?|mention|indication|details?)\b/,
  /^nothing (?:in|recorded|available|found|here|is recorded|was found)\b/,
  /^(?:the |my )?(?:evidence|data|records?|context|history)(?: below| provided| here)? (?:does|do|did) not\b/,
  /^insufficient (?:information|data|evidence|context)\b/,
  // Whole-answer only: "Unknown Pleasures by Joy Division" is an answer, and a
  // prefix match on "unknown" would throw it away.
  /^(?:unknown|unclear|unspecified|undetermined|n\/a|na)$/,
  /^(?:unknown|unclear|unspecified|undetermined) (?:from|based|in the|to me|at this|at present)\b/,
  // Same refusals with a lead-in the normalizer does not strip ("As the user, I
  // do not have this information recorded").
  /\b(?:i|we) (?:do not|don't|dont) have (?:this|that|any|enough|sufficient) (?:information|data|details?|evidence|context)\b/,
  /\bno (?:information|data|evidence|records?) (?:about|on|regarding|for|recorded|available|found)\b/,
  /\b(?:is|are) not recorded\b/,
  // Measured live miss: "I have not explicitly stated my pronouns in this
  // record." First person, no "I don't know" anywhere in it — what makes it a
  // refusal is that it reports on the RECORD's silence rather than answering.
  /^i have (?:not|never) (?:ever |explicitly |specifically |directly |clearly |openly |publicly |actually )*(?:stated|said|specified|mentioned|indicated|declared|expressed|described|discussed|recorded|documented|noted|listed|shared|provided|disclosed)\b/,
  // The same gap reported with the person's own attribute as the subject: "My
  // pronouns are not specified anywhere." Deliberately excludes "recorded",
  // which the whole-phrase guard above already owns.
  /\b(?:is|are|was|were) not (?:explicitly |specifically |directly |clearly |anywhere )*(?:stated|specified|mentioned|indicated|documented|listed|noted|captured|available|present|known)\b/,
  // The record as the sentence's subject with any verb of absence. The
  // "(?:does|do|did) not" guard above misses contractions and any intervening
  // words — "The evidence here doesn't mention that" cleared it untouched.
  /^(?:my|the|this|these|those|our) (?:own |provided |available |imported |indexed )?(?:records?|evidence|data|dataset|corpus|history|context|logs?|information)(?:\s+\w+){0,3}\s+(?:does not|doesn't|do not|don't|dont|did not|didn't|never|lacks?|contains? no|shows? no|has no|have no|is silent|are silent|says? nothing|mentions? nothing)\b/,
  // Measured live miss: "I do not have a description of my sexual orientation
  // to share." First person, names no record, and the absent thing is THE VERY
  // THING ASKED FOR — the tell is the trailing "to share/give/offer", which a
  // real answer never needs. Requiring that tail is what keeps "I don't have a
  // car" and "I do not have any siblings" (real answers) out of it.
  /^i (?:do not|don't|dont) have (?:a|an|any|the)\b(?:\s+\w+){0,6}\s+to (?:share|give|offer|provide|report|add|state|disclose)\b/,
];

/**
 * A reference to the RECORD itself rather than to the person's life — "in this
 * record", "based on the evidence", "according to my logs".
 *
 * The determiner is required on purpose: "in data" and "in the data" are not the
 * same claim, and "Data engineering." is a real answer to "what do you do?".
 */
const RECORD_REFERENCE =
  /\b(?:in|from|within|throughout|across|based on|according to|per) (?:this|that|the|my|our|these|those|your)(?: (?:own|provided|available|given|current|imported|indexed|supplied|above|below))? (?:records?|evidence|data|dataset|corpus|history|context|memory|memories|archive|logs?|information)\b/;

/**
 * Some claim that something is missing, unknown or absent.
 *
 * Never load-bearing alone — half of all real answers contain a negation
 * ("I don't drink coffee") — only in conjunction with {@link RECORD_REFERENCE}.
 */
const ABSENCE_CLAIM =
  /\b(?:no|not|never|nothing|none|nowhere|neither|silent|lacks?|lacking|absent|missing|unavailable|unspecified|unstated|unmentioned|undocumented|unclear|unknown|insufficient|cannot|can't|cant|doesn't|don't|dont|isn't|aren't|wasn't|weren't|hasn't|haven't)\b/;

/**
 * Is this answer text a refusal dressed as an answer?
 *
 * Used twice on purpose: {@link parseInferredAnswer} clamps the score so no
 * caller can persist a confident refusal, and AnswerInferenceListener drops the
 * row outright so a lowered floor cannot let one through anyway. A prompt rule
 * alone was not enough — the measured failure was a refusal self-scored at 0.7.
 */
export function isNonAnswer(answer: string): boolean {
  const normalized = stripSoftener(normalizeAnswerText(answer));

  if (normalized.length === 0) {
    return false;
  }

  if (NON_ANSWER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // The structural tell, for the shapes no phrase list will ever enumerate: the
  // sentence is about what the RECORD contains, not about the person. Both
  // halves are required — a record reference alone can be a real answer ("I keep
  // it all in my logs") and a negation alone is half of everything anyone says
  // ("I don't drink coffee") — but together they are a report on a gap in the
  // corpus, which is the absence of an answer however fluently it is phrased.
  return RECORD_REFERENCE.test(normalized) && ABSENCE_CLAIM.test(normalized);
}

/**
 * Narrator lead-ins: the model describing the corpus before it gets round to
 * speaking as the person. Stripped rather than rejected — "My record shows I
 * have kept up with woodworking" is a real answer wearing a narrator's hat, and
 * throwing the whole row away would cost the user the fact inside it.
 */
const META_VOICE_LEAD_INS: readonly RegExp[] = [
  // "My record shows (that) …", "The records indicate …", "My data suggests …"
  /^(?:my|the|this|these|those|our|your) (?:own |provided |available |imported |indexed )?(?:records?|evidence|data|dataset|corpus|history|context|memory|memories|logs?|information)(?: below| above| here| provided| available)?,? (?:shows?|suggests?|indicates?|says?|states?|reflects?|implies|confirms?|reveals?|points? to|tells? me|contains?|notes?)(?: that)?[:,]?\s+/i,
  // "Based on the evidence, …", "According to my records, …"
  /^(?:based (?:on|upon)|according to|going by|judging (?:by|from)|drawing on|per|looking at|given) (?:my|the|this|these|those|our|your)(?: own| provided| available| imported| indexed)? (?:records?|evidence|data|dataset|corpus|history|context|memory|memories|logs?|information)(?: below| above| here| provided| available)?[,:]?\s+/i,
  // "It appears (from the record) that …" — narration with the corpus implied.
  /^it (?:appears|seems|looks like)(?: from (?:my|the|this) (?:records?|evidence|data|history|logs?))?(?: that)?,?\s+/i,
];

/**
 * The same leak arriving as a tail — "I prefer the beach, based on the evidence
 * below." Bare "in"/"from" are deliberately absent from the preposition set:
 * they would eat the end of "I work in the data".
 */
const META_VOICE_TAILS: readonly RegExp[] = [
  /[,;]?\s*(?:based (?:on|upon)|according to|going by|judging (?:by|from)|per|as (?:shown|recorded|noted|documented) in)\s+(?:my|the|this|these|those|our|your)(?:\s+(?:own|provided|available|imported|indexed))?\s+(?:records?|evidence|data|dataset|corpus|history|context|memory|memories|logs?|information)(?:\s+(?:below|above|here|provided|available))?\s*([.!?]?)$/i,
];

/**
 * Mid-sentence narration of the act of reading the corpus, measured live in
 * "I grew up all over, listing locations like San Diego, Yorba Linda, Seattle,
 * and Anchorage." The list is the answer; "listing locations like" is the model
 * describing its own retrieval, and a dash carries the same sentence without it.
 */
const META_VOICE_LISTING = /,?\s+listing\s+(?:\w+\s+)?(?:like|such as|including)\s+/gi;

/**
 * Strip narrator framing out of an answer, leaving the person speaking.
 *
 * Applied by {@link parseInferredAnswer} so it lands before the non-answer check
 * rather than after: "Based on the evidence, there is no mention of pronouns."
 * is a refusal that only looks like one once the frame is gone.
 *
 * Repair, not rejection. Only framing that can be removed without touching the
 * claim is removed here; narration that survives it is {@link isNarratedVoice}'s
 * problem, and that one drops the row.
 */
export function sanitizeInferredAnswerVoice(answer: string): string {
  let text = (answer ?? '').trim();

  for (const lead of META_VOICE_LEAD_INS) {
    text = text.replace(lead, '');
  }

  for (const tail of META_VOICE_TAILS) {
    text = text.replace(tail, '$1');
  }

  text = text.replace(META_VOICE_LISTING, ' — ').replace(/\s+/g, ' ').trim();

  // A stripped lead-in usually leaves a lowercase word where the sentence now
  // starts. Only ever raises the first letter — an answer that legitimately
  // begins lowercase ("iPhone", "e.e. cummings") is left as the model wrote it.
  if (text !== answer.trim() && /^[a-z]/.test(text)) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  return text;
}

const NARRATED_VOICE_PATTERNS: readonly RegExp[] = [
  // The corpus named as a thing the answer is about. 'records'/'evidence'/
  // 'dataset'/'corpus' only: 'data' and 'history' are ordinary words in a real
  // answer ("Data engineering.", "I studied history").
  /\b(?:my|the|this|these|those|our) (?:own |provided |available |imported |indexed )?(?:records?|evidence|dataset|corpus)\b/,
  /\b(?:in|from|within|across|based on|according to|per) (?:this|that|the|my|our|these|those) (?:records?|evidence|dataset|corpus|data|history|context|logs?)\b/,
  // The record as narrator.
  /\b(?:the|my|this) (?:data|evidence|records?|history|logs?) (?:shows?|suggests?|indicates?|says?|reflects?|implies|confirms?|reveals?)\b/,
  // Third person about the person whose voice this is supposed to be. "the
  // user" is corpus-speak wherever it lands; "this person" / "the owner" only
  // as the sentence's subject, so a real answer that happens to contain the
  // phrase — "I'm the person everyone calls at 2am" — is left alone.
  /\bthe user\b/,
  /^(?:the|this) (?:user|person|individual|owner)\b/,
];

/**
 * Answers written in the wrong voice — narrating the user's data instead of
 * being the user.
 *
 * Checked AFTER {@link sanitizeInferredAnswerVoice} has removed the framing it
 * can remove, so what reaches here is narration woven into the claim itself
 * ("The user prefers mornings", "a strong interest, per my records") which
 * cannot be repaired without rewriting what the answer says.
 *
 * Same asymmetry as {@link isNonAnswer}: a false positive leaves a question
 * blank, which is where it already was, while a miss publishes "My record shows
 * …" on the user's own profile beside sentences they typed themselves. So an
 * answer that genuinely is about the user's records ("I keep my records in
 * Notion") is lost here, and that is the cheaper mistake.
 */
export function isNarratedVoice(answer: string): boolean {
  const normalized = normalizeAnswerText(answer);

  if (normalized.length === 0) {
    return false;
  }

  return NARRATED_VOICE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * One answer text, flattened to the form every predicate here matches against:
 * lowercase, curly apostrophes straightened, punctuation reduced to spaces.
 *
 * Shared rather than repeated so a pattern written against one predicate's
 * normalization cannot silently fail in another's — the apostrophe rule in
 * particular is load-bearing in three places ("don't", "i'm", "it'll").
 */
function normalizeAnswerText(answer: string): string {
  return (answer ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^a-z0-9'/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drop a leading softener so the sentence's real first word is exposed —
 * "Sorry, I don't know" and "Honestly, it's about a foot tall" both hide their
 * tell behind one.
 */
function stripSoftener(normalized: string): string {
  return normalized.replace(/^(?:sorry|unfortunately|honestly|apologies|well|hmm+)\s+/, '');
}

/**
 * Any reference to the person whose voice this is supposed to be.
 *
 * The apostrophe survives {@link normalizeAnswerText}, and a `'` is a non-word
 * character, so `\bi\b` matches the "i" in "i'm" and "i've" as well as the bare
 * pronoun — the contractions do not need enumerating.
 */
const FIRST_PERSON_REFERENCE = /\b(?:i|me|my|mine|myself|we|us|our|ours|ourselves)\b/;

/**
 * A sentence whose SUBJECT is an impersonal "it", "that" or "this".
 *
 * Two shapes, because the contraction carries the verb: "It's four inches" and
 * "It is four inches" are the same sentence, and only the second has a separate
 * verb to match. The verb list is what keeps a determiner out of it — "This year,
 * mostly hiking." opens with the same word and is a perfectly good answer, so a
 * bare `^(?:it|that|this)\b` would throw it away.
 */
const DEFLECTED_SUBJECT_PATTERNS: readonly RegExp[] = [
  /^(?:it|that|this)'(?:s|ll|d|re|ve)\b/,
  /^(?:it|that|this) (?:is|was|isn't|wasn't|are|were|will|would|can|could|may|might|must|should|has|have|had|does|do|did|seems?|seemed|looks?|looked|sounds?|sounded|feels?|felt|comes?|came|goes|went|gets?|got|becomes?|became|remains?|stays?|stayed|tends?|tended|means?|meant|used|measures?|measured|weighs?|weighed|stands?|stood|runs?|ran|sits?|sat|ends?|ended)\b/,
];

/**
 * ═══ THE ABOUTNESS GATE ═══
 *
 * Is this sentence about SOMETHING ELSE rather than about the person?
 *
 * {@link enforceFirstPersonEvidence} settles who WROTE the evidence. This settles
 * who the resulting sentence is ABOUT, which is a different question and the one
 * that produced both measured failures on the reference corpus:
 *
 *   "How tall are you?"                              → "It'll be like a foot tall."          0.80
 *   "Are you more of a cat person or a dog person?"  → "It's like a mix between a dog and a cat." 0.80
 *
 * Both cleared every existing guard. The cited lines were genuinely outbound, so
 * the speaker gate passed; both are real sentences, so the non-answer patterns
 * passed; both match the question's vocabulary exactly, which is precisely why
 * retrieval surfaced them. What is wrong with them is that their subject is an
 * OBJECT — a thing the owner was describing — and a measurement or a description
 * of a thing says nothing about the person who typed it.
 *
 * Both halves are required, and the second is what makes this safe to apply:
 *   - the sentence opens with an impersonal subject ("It's …", "That was …"), and
 *   - it never refers to the person at all.
 * "It's the house I grew up in." is about the person by its second clause and is
 * left alone; "It'll be like a foot tall." has nobody in it.
 *
 * Same asymmetry as {@link isNonAnswer}: a false positive leaves a question blank,
 * which is where it already was, while a miss publishes a fact about a bookshelf
 * on a person's profile as their own height.
 */
export function isAboutSomethingElse(answer: string): boolean {
  const normalized = stripSoftener(normalizeAnswerText(answer));

  if (normalized.length === 0 || FIRST_PERSON_REFERENCE.test(normalized)) {
    return false;
  }

  return DEFLECTED_SUBJECT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * The same question as {@link isAboutSomethingElse}, asked of an EVIDENCE line
 * rather than of an answer — and it has to be asked differently.
 *
 * An answer is one sentence and the tell is at its start. A retrieved line is
 * whatever the person typed that day, and the measured one hid in the SECOND
 * sentence: "Sorry no.  It is apparently like the halfway between a dog and
 * cat." Anchored at the line's start, that reads as beginning "no" and slips
 * through; split into sentences, the claim is plainly about an animal.
 *
 * The first-person guard is applied to the WHOLE line rather than per sentence,
 * because a line in which the person says anything about themselves is a line
 * about them — "I used to have pets. Dogs, cats, birds." must stay usable.
 */
function isLineAboutSomethingElse(text: string): boolean {
  const line = stripSourceLabel(text);

  if (FIRST_PERSON_REFERENCE.test(normalizeAnswerText(line))) {
    return false;
  }

  return sentencesOf(line).some((sentence) => isAboutSomethingElse(sentence));
}

/**
 * The half of a sentence that follows an impersonal subject and its verb, or
 * null when the sentence does not have one. "It is apparently like the halfway
 * between a dog and cat" → "apparently like the halfway between a dog and cat".
 */
function impersonalPredicate(normalized: string): string | null {
  const match = normalized.match(
    /^(?:it|that|this)(?:'(?:s|ll|d|re|ve)|\s+(?:is|was|are|were|will|would|seems|seemed|looks|looked|sounds|sounded|feels|felt))(?:\s+(?:be|been|being))?\s+(.+)$/,
  );

  return match ? match[1] : null;
}

/**
 * The same half of a sentence, following a FIRST-PERSON subject and copula.
 *
 * Deliberately only the copulas — "I am", "I'm", "I was", "I'll be". A first
 * person doing something ("I grew up all over…", "I sometimes watch hockey…")
 * is a person acting, which is never the laundering shape below and must not be
 * caught by it.
 */
function firstPersonPredicate(normalized: string): string | null {
  const match = normalized.match(
    /^i(?:'(?:m|ll|d|ve)|\s+(?:am|was|are|were|will|would|have|had|feel|felt|seem|seemed))(?:\s+(?:be|been|being))?\s+(.+)$/,
  );

  return match ? match[1] : null;
}

/**
 * Words that carry no claim, dropped from both sides before two predicates are
 * compared. Hedges and articles are exactly what a paraphrase changes.
 */
const PREDICATE_FILLER = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'and',
  'or',
  'be',
  'been',
  'like',
  'about',
  'apparently',
  'basically',
  'sort',
  'kind',
  'really',
  'just',
  'very',
  'quite',
  'pretty',
  'more',
  'most',
  'some',
  'somewhat',
  'somewhere',
  'roughly',
  'approximately',
  'maybe',
  'perhaps',
  'probably',
  'my',
  'their',
  'its',
]);

/**
 * The DISTINCT words a predicate actually claims something with.
 *
 * Distinct, because a repeated word is one claim said twice and counting it
 * twice quietly halves the overlap: "somewhere between a dog person and a cat
 * person" repeats "person", and the repetition is what let that paraphrase
 * through at 0.50 when its claim is the cited line's claim.
 */
function contentTokens(predicate: string): string[] {
  return [
    ...new Set(predicate.split(' ').filter((token) => token.length > 0 && !PREDICATE_FILLER.has(token))),
  ];
}

/**
 * The fewest content words a comparison is allowed to rest on.
 *
 * Two words match by accident all the time — "night owl" is the whole predicate
 * of a correct answer on the reference corpus — so a claim has to be at least
 * this specific before an overlap means anything.
 */
const SUBJECT_SWAP_MIN_TOKENS = 3;

/** How much of the answer's claim has to come from the line to count as its copy. */
const SUBJECT_SWAP_MIN_OVERLAP = 0.7;

/**
 * Is the answer a cited line's THING-sentence with the subject swapped for "I"?
 *
 * The laundering move, measured on the very first run after the answer-side gate
 * closed the plain version. The owner's line was "Sorry no. It is apparently
 * like the halfway between a dog and cat." — them relaying what some animal
 * apparently is — and asked "cat person or dog person?", the model wrote "I am
 * apparently like the halfway between a dog and a cat." at `implied` 0.80, then
 * "I am somewhere between a dog person and a cat person." on a later run. Every
 * gate passed them: own-voice evidence, a first-person sentence, a real claim.
 * They are the same non-answer with a pronoun changed, and what the first
 * asserts about the person is an absurdity.
 *
 * Only fires on a COPULA answer ("I am …") whose claim is materially the cited
 * sentence's claim, so a person doing something in their own words is untouched
 * however closely it echoes a line they wrote.
 */
function isSubjectSwapOf(answer: string, citedLineTexts: readonly string[]): boolean {
  const answerPredicate = firstPersonPredicate(stripSoftener(normalizeAnswerText(answer)));

  if (!answerPredicate) {
    return false;
  }

  const answerTokens = contentTokens(answerPredicate);

  if (answerTokens.length < SUBJECT_SWAP_MIN_TOKENS) {
    return false;
  }

  for (const text of citedLineTexts) {
    for (const sentence of sentencesOf(stripSourceLabel(text))) {
      const linePredicate = impersonalPredicate(stripSoftener(normalizeAnswerText(sentence)));

      if (!linePredicate) {
        continue;
      }

      const lineTokens = new Set(contentTokens(linePredicate));
      const shared = answerTokens.filter((token) => lineTokens.has(token)).length;

      if (shared / answerTokens.length >= SUBJECT_SWAP_MIN_OVERLAP) {
        return true;
      }
    }
  }

  return false;
}

/**
 * A line split into sentences, because a line's second sentence is where the
 * measured one hid: "Sorry no.  It is apparently like the halfway between a dog
 * and cat." is two sentences and only the second is the claim.
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Drop the source label a recall line carries — `[I wrote, Nov 14, 2017] "…"` —
 * so the sentence's own first word is the one that gets tested.
 *
 * The label is THIS side's framing, not the person's words, and every outbound
 * one begins "I wrote": left in place it would make every line look like a
 * first-person statement, which is exactly the confusion the gate below exists
 * to undo.
 */
function stripSourceLabel(text: string): string {
  return (text ?? '')
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/^["'‘’“”`]+/, '')
    .trim();
}

/**
 * ═══ THE EVIDENCE-SIDE ABOUTNESS GATE ═══
 *
 * The same question as {@link isAboutSomethingElse}, asked one step earlier: not
 * "is this ANSWER about the person" but "is the LINE it rests on about the
 * person".
 *
 * It exists because the answer's wording is the model's to choose and the line
 * is not. Measured on the reference corpus, two consecutive runs of "How tall
 * are you?" answered "It'll be like a foot tall." and then "About a foot tall."
 * — the same wrong claim at the same score, off the same single citation, and
 * only the first carries a tell in the answer text. The citation was
 * `[I wrote, Nov 14, 2017] "It'll be like a foot tall."` both times.
 *
 * Two ways to fail it:
 *   - EVERY cited line is a sentence about something else. One object-sentence
 *     alongside a real first-person line is left alone — one good line is enough
 *     to support an answer — and nothing cited at all is not this gate's verdict
 *     to give, {@link enforceFirstPersonEvidence} having already refused it.
 *   - The answer is one of those sentences with the subject swapped for "I"; see
 *     {@link isSubjectSwapOf}. That one is the model's response to being denied
 *     the plain version, and it survives a citation set that is mostly fine.
 *
 * The cost it accepts: a question genuinely about an OBJECT the person owns
 * ("How big is your garden?" → "It's about thirty square metres.") is evidenced
 * by exactly this shape and is discarded with it. That is the trade the rest of
 * this file makes too — a blank card, against a bookshelf's height published as
 * a person's own.
 */
export function enforceEvidenceIsAboutThePerson(
  inferred: InferredAnswer,
  citedLineTexts: readonly string[],
): { inferred: InferredAnswer; aboutThePerson: boolean } {
  const cited = citedLineTexts.filter((text) => (text ?? '').trim().length > 0);

  const everyLineIsAboutAThing = cited.length > 0 && cited.every(isLineAboutSomethingElse);

  if (!everyLineIsAboutAThing && !isSubjectSwapOf(inferred.answer, cited)) {
    return { inferred, aboutThePerson: true };
  }

  return {
    inferred: {
      ...inferred,
      support: 'topical',
      confidence: round2(Math.min(inferred.confidence, CONFIDENCE_OFF_QUESTION)),
    },
    aboutThePerson: false,
  };
}

/**
 * ═══ THE FORCED-CHOICE COMMITMENT GATE ═══
 *
 * A `multiple_choice` question names its own answer space. "Do you prefer
 * small gatherings or large parties?" is not asking for an essay about
 * parties — it is asking which of exactly two things this person would
 * choose, and a sentence that touches the topic without picking a side is not
 * a weak answer to it, it is a non-answer wearing a fluent sentence. Measured
 * live: "It depends on the parties I go to." — self-scored 0.75, `support`
 * unset — which is circular rather than uncertain: "the parties I go to" is
 * the question's own axis (party size) handed back, not a fact this side
 * didn't already know.
 *
 * The wrong fix, already tried and rejected once this session, is banning
 * hedge language. "Do you prefer the beach or the mountains?" has a CORRECT
 * promoted answer — "I'm not sure, but I prefer the beach and nature areas."
 * — that hedges AND commits; a phrase-ban would have discarded a good answer
 * along with a bad one. The signal this gate keys on is narrower and the
 * right one: does the answer name EXACTLY ONE alternative, by the word itself
 * or an unmistakable paraphrase? "I'm not sure, but I prefer the beach…"
 * names "the beach" and only "the beach"; "It depends on the parties I go to"
 * names neither "small" nor "large".
 *
 * EXACTLY one, not "at least one" — a second measured live failure on the
 * same question names BOTH sides and still is not an answer: "I am somewhere
 * between cat and dog, though I currently take care of my neighbor's dogs."
 * for "Are you more of a cat person or a dog person?" contains the literal
 * words "cat" AND "dog", so a check for either word alone would wave it
 * through. The prompt already states the general form of this — "An A-or-B
 * question is answered by A or by B, never by a thing that is part A and part
 * B" — for the case where the sentence has no person in it at all; this is
 * the same shape spoken in the first person, which the existing aboutness
 * gate does not cover because a first-person sentence is exactly what it is
 * built to let through.
 *
 * Deliberately narrow in what it will act on. {@link extractForcedChoiceAlternatives}
 * only ever returns a verdict for a question that cleanly names two or a
 * short few alternatives — most of the real catalogue does ("Do you prefer
 * X or Y?"), but a real minority is open-domain ("What time of day do you
 * prefer to exercise?") or asks for a quantity dressed as a list ("How often
 * do you have therapy or counseling appointments?" is a frequency question,
 * not a choice between "therapy" and "counseling appointments"). Extraction
 * returns `null` for both, and `null` is a no-op here — this gate does not
 * invent alternatives the question did not actually name, and existing
 * behaviour is untouched on every question it cannot parse this way.
 */
export function enforceForcedChoiceCommitment(
  inferred: InferredAnswer,
  question: ForcedChoiceQuestion,
): { inferred: InferredAnswer; committed: boolean; alternatives: readonly string[] | null } {
  if (question.questionType !== 'multiple_choice') {
    return { inferred, committed: true, alternatives: null };
  }

  const alternatives = extractForcedChoiceAlternatives(question.text);

  if (!alternatives) {
    return { inferred, committed: true, alternatives: null };
  }

  const answerWords = wordSetOf(inferred.answer);
  const namedCount = alternatives.filter((alternative) => namesAlternative(answerWords, alternative)).length;
  const committed = namedCount === 1;

  if (committed) {
    return { inferred, committed: true, alternatives: alternatives.map((alternative) => alternative.phrase) };
  }

  return {
    inferred: {
      ...inferred,
      support: 'topical',
      confidence: round2(Math.min(inferred.confidence, CONFIDENCE_OFF_QUESTION)),
    },
    committed: false,
    alternatives: alternatives.map((alternative) => alternative.phrase),
  };
}

/** What {@link enforceForcedChoiceCommitment} and {@link enforceYesNoQualifierIsInformative} need of a question — the same two fields {@link Question} already carries. */
export interface ForcedChoiceQuestion {
  readonly text: string;
  readonly questionType?: string | null;
}

/** One named alternative extracted from a `multiple_choice` question's own text. */
export interface ForcedChoiceAlternative {
  /** The phrase as it appeared in the question — diagnostic only. */
  readonly phrase: string;
  /** The content words that distinguish this alternative from its sibling(s), with words shared by every alternative already removed. */
  readonly tokens: readonly string[];
}

const MIN_FORCED_CHOICE_ALTERNATIVES = 2;

/**
 * A guard against a pathological generation more than a real ceiling — the
 * corpus tops out at three named alternatives ("silent, vibrate, or
 * ringer"), and a split that produces more than four is not a short
 * enumeration any more.
 */
const MAX_FORCED_CHOICE_ALTERNATIVES = 4;

/**
 * Questions that ask for a MAGNITUDE, not a pick between named things — "How
 * often do you have therapy or counseling appointments?" splits cleanly on
 * " or " and is still not a forced choice between "therapy" and "counseling
 * appointments": the question wants a frequency, and "therapy" and
 * "counseling appointments" are the same category said two ways, not two
 * things to choose between. Excluded up front, before extraction is even
 * attempted, because no amount of phrase-splitting turns a frequency question
 * into one.
 */
const QUANTITY_OR_TIME_QUESTION =
  /^(?:how\s+(?:often|much|many|long|far|old|tall|big|small|frequently|early|late)|what\s+time)\b/i;

/**
 * Words dropped before comparing a question's alternatives to each other or
 * to an answer: determiners, prepositions, pronouns, the question's own
 * auxiliary verbs, and the couple of verbs ("prefer", "rather") that
 * introduce a choice without being part of either side of it.
 *
 * A separate set from {@link PREDICATE_FILLER} on purpose — that one is tuned
 * for comparing two ANSWER sentences to each other and already drops words
 * ("my", "their") this gate needs to keep meaningful ("Do you use YOUR legal
 * name…" — "your" here is boilerplate, but the two sets serve different
 * comparisons and conflating them risks silently changing the other gate's
 * measured behaviour for a change this one does not need.
 */
const FORCED_CHOICE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'at',
  'with',
  'for',
  'as',
  'from',
  'into',
  'near',
  'about',
  'over',
  'under',
  'by',
  'out',
  'you',
  'your',
  'yours',
  'i',
  'we',
  'us',
  'our',
  'ours',
  'it',
  'its',
  'me',
  'my',
  'mine',
  'do',
  'does',
  'did',
  'am',
  'are',
  'is',
  'was',
  'were',
  'be',
  'been',
  'being',
  'would',
  'will',
  'can',
  'could',
  'should',
  'shall',
  'must',
  'might',
  'may',
  'have',
  'has',
  'had',
  'prefer',
  'rather',
  'usually',
  'generally',
  'typically',
  'normally',
  'more',
  'most',
  'also',
  'either',
  'when',
  'if',
  'whether',
  'and',
  'or',
]);

function isForcedChoiceStopword(word: string): boolean {
  return FORCED_CHOICE_STOPWORDS.has(word);
}

/**
 * The lowercased words of a chunk of text, split the same way
 * {@link normalizeAnswerText} already splits an answer — so a hyphenated
 * question fragment ("lived-in") and a hyphenated answer word land on the
 * same tokens without a second normalization rule to keep in sync.
 */
function wordsOf(text: string): string[] {
  return normalizeAnswerText(text)
    .split(' ')
    .filter((word) => word.length > 0);
}

/**
 * The trailing run of content words in `words` — everything after the LAST
 * stopword, or all of `words` if none is one.
 *
 * This is what turns "Do you prefer small gatherings" into just
 * `["small", "gatherings"]`: scanning from the end, "prefer" is a stopword and
 * stops the run before it, so the question's own boilerplate never enters the
 * alternative. Used for the FIRST chunk of a split question text, which is
 * the only one still carrying the question's lead-in.
 */
function trailingContentRun(words: readonly string[]): string[] {
  const result: string[] = [];

  for (let i = words.length - 1; i >= 0; i--) {
    if (isForcedChoiceStopword(words[i])) {
      break;
    }

    result.unshift(words[i]);
  }

  return result;
}

/**
 * The leading run of content words in `words`, after first skipping any
 * leading stopwords.
 *
 * Mirrors {@link trailingContentRun} for every chunk AFTER the first, which
 * carries no lead-in and instead opens with its own determiner or preposition
 * ("the mountains", "with music") — skipped, not treated as the stop
 * boundary, because unlike the first chunk there is no boilerplate on the far
 * side of it to protect against.
 */
function leadingContentRun(words: readonly string[]): string[] {
  let start = 0;

  while (start < words.length && isForcedChoiceStopword(words[start])) {
    start++;
  }

  const result: string[] = [];

  for (let i = start; i < words.length; i++) {
    if (isForcedChoiceStopword(words[i])) {
      break;
    }

    result.push(words[i]);
  }

  return result;
}

/**
 * Split a `multiple_choice` question's own text into the alternatives it
 * names, or `null` when it does not cleanly name a short, closed set.
 *
 * Splits on " or " and on a comma optionally followed by "or " in the same
 * pass, so both "Do you rent or own your home?" and "Do you keep your phone
 * on silent, vibrate, or ringer?" go through one rule rather than two. The
 * FIRST chunk is trimmed from its end (it alone carries the question's own
 * lead-in); every later chunk is trimmed from its start.
 *
 * Returns `null` — no verdict, not a guess — whenever the split does not
 * clearly produce a short list of DIFFERENT named things: fewer than two
 * survive, more than four survive, two reduce to the same words, or trimming
 * strips one down to nothing. A first chunk trimmed to nothing is different
 * from these: it means the split boundary fell exactly at the end of the
 * question's lead-in (see the worked case below) and is simply dropped rather
 * than counted as an empty alternative.
 *
 * Worked case: "What kind of stove do you cook on, gas, electric, or
 * induction?" splits into four chunks. The first, "What kind of stove do you
 * cook on", trims to nothing — its last word, "on", is a stopword, so the
 * trailing run stops before it ever reaches "cook" — and is dropped rather
 * than kept as a fourth, nonsensical alternative. The three real ones,
 * "gas" / "electric" / "induction", are untouched by the trim rule because
 * they are not the first chunk.
 */
export function extractForcedChoiceAlternatives(questionText: string): ForcedChoiceAlternative[] | null {
  const stripped = (questionText ?? '').trim().replace(/[?.!]+\s*$/, '');

  if (stripped.length === 0 || QUANTITY_OR_TIME_QUESTION.test(stripped)) {
    return null;
  }

  const rawChunks = stripped
    .split(/\s*,\s*(?:or\s+)?|\s+or\s+/i)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  if (rawChunks.length < MIN_FORCED_CHOICE_ALTERNATIVES) {
    return null;
  }

  const alternatives: ForcedChoiceAlternative[] = [];

  for (const [index, chunk] of rawChunks.entries()) {
    const words = wordsOf(chunk);
    const tokens = index === 0 ? trailingContentRun(words) : leadingContentRun(words);

    if (tokens.length === 0) {
      // A first chunk that trims to nothing is pure lead-in, not a fourth
      // alternative — see the stove example above. The same emptiness on any
      // later chunk means the split landed somewhere that names nothing, and
      // the whole question is untrusted rather than guessed at.
      if (index === 0) {
        continue;
      }

      return null;
    }

    alternatives.push({ phrase: chunk, tokens });
  }

  if (
    alternatives.length < MIN_FORCED_CHOICE_ALTERNATIVES ||
    alternatives.length > MAX_FORCED_CHOICE_ALTERNATIVES
  ) {
    return null;
  }

  // Two alternatives that reduce to the same bag of words did not actually
  // split into two different things.
  const seen = new Set<string>();

  for (const alternative of alternatives) {
    const key = [...alternative.tokens].sort().join(' ');

    if (seen.has(key)) {
      return null;
    }

    seen.add(key);
  }

  // Drop words every alternative shares — "person" in "a cat person" / "a dog
  // person" is the topic the question is about, not what distinguishes either
  // side of it, and a paraphrase that reuses only the shared word ("I have
  // cared for many kinds of pets") must not be able to pass by accident.
  const shared = alternatives[0].tokens.filter((token) =>
    alternatives.every((alternative) => alternative.tokens.includes(token)),
  );

  if (shared.length === 0) {
    return alternatives;
  }

  const distinguished = alternatives.map((alternative) => ({
    phrase: alternative.phrase,
    tokens: alternative.tokens.filter((token) => !shared.includes(token)),
  }));

  // Removing the shared words may leave an alternative with nothing left of
  // its own — two alternatives that differ ONLY in a word every other
  // alternative also uses did not really name two different things.
  return distinguished.some((alternative) => alternative.tokens.length === 0) ? null : distinguished;
}

/**
 * A light, deliberately crude stemmer — just enough to match "cats" against
 * "cat", "parties" against "party", and "traveling" against "travel" without
 * a real morphological analyzer. Applied to both sides of every comparison
 * this gate makes, so a mismatch it introduces is symmetric rather than a
 * one-sided false negative.
 *
 * The `-ing` rule exists for a measured near miss on real, already-good
 * evidence: "Do you check a bag or travel carry-on only?" answered "I prefer
 * traveling with a carry-on." — a real commitment to the second alternative
 * that a plural-only stemmer does not connect to the question's own "travel",
 * discarding a good answer over an inflection.
 */
function stemForComparison(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) {
    return word.slice(0, -3);
  }

  if (word.length > 4 && /(?:sses|ches|shes|xes|zes)$/.test(word)) {
    return word.slice(0, -2);
  }

  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }

  if (word.length > 4 && word.endsWith('ed') && !word.endsWith('eed')) {
    return word.slice(0, -2);
  }

  return word;
}

function wordSetOf(text: string): Set<string> {
  return new Set(wordsOf(text).map(stemForComparison));
}

/**
 * Does `answerWords` name this alternative?
 *
 * Requires EVERY one of the alternative's own distinguishing words, not just
 * one — the measured bug survives a single-word check. "large parties" and
 * "small gatherings" share no word, so on their own either single word would
 * be enough; the failure mode is a shared HEAD noun the split did not catch
 * because the two alternatives spell it differently ("gatherings" vs.
 * "parties"), and "It depends on the parties I go to" contains "parties" —
 * one of "large parties"'s two words — without ever saying "large". A
 * same-length requirement is what a one-word answer like "Beach." or "Night
 * owl." still clears effortlessly: {@link extractForcedChoiceAlternatives}
 * reduces most real alternatives to one or two words in the first place.
 */
function namesAlternative(answerWords: ReadonlySet<string>, alternative: ForcedChoiceAlternative): boolean {
  return (
    alternative.tokens.length > 0 &&
    alternative.tokens.every((token) => answerWords.has(stemForComparison(token)))
  );
}

/**
 * ═══ THE YES/NO QUALIFIED-ANSWER GATE ═══
 *
 * `yes_no` has no text to extract alternatives from — its two poles are
 * always yes and no — so {@link enforceForcedChoiceCommitment}'s approach does
 * not apply, and the failure this gate exists for is not "names neither side"
 * but a narrower thing: an "it depends on X" answer where X is not really a
 * condition at all.
 *
 * Point 2 of the design this gate implements: "It depends on the price." for
 * "Do you buy the extended warranty when it is offered?" is a GOOD, genuinely
 * conditional answer — price is a real variable the question never named, and
 * naming it is new information. What makes "It depends on the parties I go
 * to" a bad answer to a DIFFERENT question is not the shape "it depends", it
 * is that "the parties I go to" is not a condition on the choice — it IS the
 * choice ("small gatherings or large parties") restated. So the test this
 * gate runs is not "does the answer hedge", it is "does the qualifier
 * introduce a word the question did not already use" — a real external
 * condition almost never shares vocabulary with the question it conditions;
 * a circular restatement can never avoid it, because it has nothing else to
 * say.
 *
 * A bare "It depends." with no stated condition at all is the same failure by
 * a shorter road — nothing follows "on", so there is no new information
 * either way — and a small set of placeholder qualifiers ("the situation",
 * "the circumstances") are treated the same way: naming a hollow category is
 * not naming a condition.
 */
/** Matches an "it depends" answer, with or without a stated condition. */
const DEPENDS_PHRASE = /\bit\s+(?:really\s+|kind\s+of\s+|sort\s+of\s+|honestly\s+)?depends?\b/i;

/** The same answer, capturing the condition after "on" when there is one. */
const DEPENDS_CLAUSE =
  /\bit\s+(?:really\s+|kind\s+of\s+|sort\s+of\s+|honestly\s+)?depends?\s+(?:(?:entirely|largely|mostly|mainly)\s+)?on\s+([^,.;!?]+)/i;

/**
 * Qualifiers that name a hollow category rather than an actual condition —
 * "it depends on the situation" answers nothing that "it depends" alone did
 * not already fail to answer.
 */
const VAGUE_QUALIFIER_WORDS = new Set([
  'situation',
  'circumstances',
  'circumstance',
  'context',
  'case',
  'mood',
  'thing',
  'things',
  'stuff',
  'factors',
  'factor',
  'variables',
  'variable',
]);

export function enforceYesNoQualifierIsInformative(
  inferred: InferredAnswer,
  question: ForcedChoiceQuestion,
): { inferred: InferredAnswer; informative: boolean } {
  if (question.questionType !== 'yes_no' || !DEPENDS_PHRASE.test(inferred.answer)) {
    return { inferred, informative: true };
  }

  const clauseMatch = inferred.answer.match(DEPENDS_CLAUSE);
  const qualifierTokens = clauseMatch
    ? wordsOf(clauseMatch[1]).filter((word) => !isForcedChoiceStopword(word))
    : [];

  // `.every()` on an empty array is already `true`, so an empty qualifier
  // (no clause matched, or the clause was all stopwords) is vacuous for free.
  const isVacuous = qualifierTokens.every((word) => VAGUE_QUALIFIER_WORDS.has(word));

  const questionTokens = new Set(
    wordsOf(question.text)
      .filter((word) => !isForcedChoiceStopword(word))
      .map(stemForComparison),
  );
  const isCircular = qualifierTokens.some((word) => questionTokens.has(stemForComparison(word)));

  if (!isVacuous && !isCircular) {
    return { inferred, informative: true };
  }

  return {
    inferred: {
      ...inferred,
      support: 'topical',
      confidence: round2(Math.min(inferred.confidence, CONFIDENCE_OFF_QUESTION)),
    },
    informative: false,
  };
}

/**
 * Parse the model's raw content into a validated inferred answer, or null if
 * nothing usable came back.
 *
 * Tolerant of markdown fences and leading prose (the same slice-to-outermost-braces
 * approach TaskBreakdownService and GraphEnrichmentService use), and returns null
 * rather than throwing: a bad generation should surface as "no answer was
 * inferred", never as an unhandled rejection inside a queue worker.
 *
 * A missing or non-finite `confidence` is a parse FAILURE, not a zero and not a
 * default: silently substituting a number would put a score in the database that
 * no model ever produced, which is exactly the fabrication this feature exists to
 * prevent. The caller decides what to do without one.
 */
export function parseInferredAnswer(content: string): InferredAnswer | null {
  let jsonStr = (content ?? '').replace(/```json\n?|\n?```/g, '').trim();

  const firstOpen = jsonStr.indexOf('{');
  const lastClose = jsonStr.lastIndexOf('}');

  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
  }

  let parsed: z.infer<typeof inferredAnswerSchema>;

  try {
    const result = inferredAnswerSchema.safeParse(JSON.parse(jsonStr));

    if (!result.success) {
      return null;
    }

    parsed = result.data;
  } catch {
    return null;
  }

  // Voice repair happens here, before the length and non-answer checks below, so
  // every caller gets the same text and the refusal detector sees the sentence
  // with its narrator framing removed — "Based on the evidence, there is no
  // mention of pronouns." only reads as a refusal once the frame is gone.
  const answer = sanitizeInferredAnswerVoice(parsed.answer);

  if (answer.length === 0 || !Number.isFinite(parsed.confidence)) {
    return null;
  }

  // Models emit percentages ("confidence": 85) about as readily as fractions.
  // Rescaling is safe because the scale in the prompt tops out at 1: anything
  // above it was meant as a percentage or is out of range either way, and both
  // readings clamp to the same place at the top.
  const normalized = parsed.confidence > 1 ? parsed.confidence / 100 : parsed.confidence;
  const bounded = Math.min(Math.max(normalized, 0), 1);

  // The prompt states this rule; the clamp is what makes it true. A model that
  // has refused to answer scores how sure it is that it does not know — the
  // opposite quantity, and a high one — so a refusal arrives at 0.7 and clears a
  // 0.4 floor it was designed to fail. Clamping here rather than at the call site
  // means no future consumer of this parser has to remember the rule.
  const clamped = isNonAnswer(answer) ? Math.min(bounded, CONFIDENCE_NON_ANSWER) : bounded;

  // The same clamp, applied to the same failure one level up. A model that has
  // answered a NEARBY question scores how well the evidence supported the thing
  // it said — which is high, and is the wrong quantity twice over: the evidence
  // did support it, and it was not an answer to what was asked. Measured: "There
  // are doctors in my family." for "Which health conditions run in your
  // immediate family?", self-scored 0.90. The prompt states the rule; this makes
  // it true for every caller of the parser rather than only the careful ones.

  // And once more for the sentence that is about a different SUBJECT.
  // A model that has described an object scores how well the evidence supported
  // the description — high, and the wrong quantity, because nothing was said
  // about the person. Measured: "It'll be like a foot tall." for "How tall are
  // you?", self-reported `stated` at 0.80 with a rationale arguing the point.
  // See {@link isAboutSomethingElse}; the caller-side gate is in
  // AnswerInferenceListener, and this is the floor under every other caller.
  const deflected = isAboutSomethingElse(answer) ? Math.min(clamped, CONFIDENCE_OFF_QUESTION) : clamped;

  const support = normalizeAnswerSupport(parsed.support);
  const confidence = round2(Math.min(deflected, supportConfidenceCeiling(support)));

  const rationale = parsed.rationale?.trim();
  const askedFor = parsed.asked_for?.trim();
  const firstPersonEvidence = normalizeEvidenceRefs(parsed.first_person_evidence);

  return {
    answer,
    confidence,
    ...(rationale ? { rationale } : {}),
    ...(askedFor ? { askedFor } : {}),
    ...(support ? { support } : {}),
    ...(firstPersonEvidence.length > 0 ? { firstPersonEvidence } : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TURNING AN ASKER'S SENTENCE INTO A QUERY THAT CANNOT ANSWER "YES" BY LUCK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `keywordSearch` deliberately rewrites `websearch_to_tsquery`'s AND-joined
 * tsquery into an OR-joined one, so "dog breed" still finds the entity whose
 * vector carries only 'dog'. For an owner searching their OWN memory that is a
 * recall win. For an ask — a question ANOTHER person directs at this box — it is
 * the difference between an answer and a fabrication:
 *
 *   "Do you know Zerbcorpolis Fnargle?"  → 'know' | 'zerbcorpoli' | 'fnargl'
 *   Nothing in memory contains either invented word. 'know' matches 10 entities.
 *   Ten matches → the boolean rung answers "Yes." about a person who does not
 *   exist. On the owner's real 19,241-entity archive, "Have you seen <invented
 *   name>?" matched 297 entities — every one of them on the word 'seen'.
 *
 *   "Do you know David Miller?"
 *   'miller' matches Steve Miller. One match → "Yes." The owner never sees what
 *   it matched, because a boolean answer discloses only the word "Yes".
 *
 * The failure is not the OR rewrite by itself; it is OR with nothing that has to
 * be true. This module rebuilds the query so that two things must hold:
 *
 *   1. A NAMED THING IS A CONSTRAINT, NOT AN ALTERNATIVE. A run of consecutive
 *      capitalised words — or, for an ask whose archetype says the subject IS a
 *      person, the whole subject — becomes a PHRASE (`'david' <-> 'miller'`,
 *      exact adjacency) and is AND-ed with everything else. So "David Miller"
 *      can no longer be satisfied by Steve Miller, and "photos of Zerbcorpolis
 *      Fnargle" can no longer be satisfied by the 600 entities carrying 'photo'.
 *
 *   2. ASK SCAFFOLDING IS NOT EVIDENCE. Postgres's english dictionary drops
 *      "do"/"you"/"have", but NOT "know", "seen", "met", "told", "heard" — the
 *      exact words that turn an unanswerable question into 297 matches. They
 *      describe the SPEECH ACT, never anything in the owner's memory, so they
 *      are removed before the query is built.
 *
 * Both rules only ever REMOVE reasons for a row to match, so neither can widen
 * what a peer receives. A prompt that reduces to nothing produces NO groups, and
 * the caller must treat that as zero results — never as "unfiltered".
 *
 * ═══ WHY NO LLM ═══
 *
 * The obvious way to parse "Do you know David Miller?" is to ask a model. This
 * module deliberately does not: the prompt is asker-controlled text arriving at
 * the box that holds the owner's entire life, and feeding it to an LLM that also
 * sees memory content is a prompt-injection surface that needs its own threat
 * review. Everything here is deterministic string work over the asker's own
 * words, and every rule is a narrowing one.
 */

/**
 * One conjunct of the rebuilt query.
 *
 * `phrase` groups are REQUIRED — every one must match. `term` groups are
 * ALTERNATIVES — at least one must match. The caller combines them as
 * `AND(phrases) & OR(terms)`; see {@link SearchService.searchPrompt}.
 */
export interface PromptQueryGroup {
  kind: 'phrase' | 'term';
  /** Raw asker text. Converted to a tsquery BY POSTGRES, never by string concat. */
  text: string;
}

export interface BuildPromptQueryOptions {
  /**
   * The ask's subject is a PERSON NAME, so the whole residual prompt is one
   * name rather than a bag of topic words.
   *
   * This mirrors the wire contract: `relationshipAskSchema.subject` is
   * documented as "the person being asked about, as the asker knows them", and
   * the peer path puts exactly that string in `query.prompt`. Binding it as a
   * phrase is what makes "David Miller" unsatisfiable by Steve Miller EVEN WHEN
   * THE ASKER TYPES IT IN LOWER CASE — capitalisation is a hint the peer wire
   * format does not promise, so a name ask must not depend on it.
   */
  subjectIsName?: boolean;
}

/**
 * Words that describe the ASK rather than anything that could be in memory.
 *
 * Membership test: could this word ever be part of the NAME of a thing the
 * owner remembers? If it could, it is not here. That is why "live" (live album),
 * "meeting" (a real calendar noun), "free" (an availability answer) and "go"
 * (go-kart) are deliberately ABSENT even though they read like scaffolding —
 * leaving a word out only preserves today's behaviour, while wrongly including
 * one would silently make a legitimate ask unanswerable.
 *
 * Most interrogatives and pronouns here are already Postgres english stopwords
 * and would vanish from the tsquery anyway. They are listed all the same,
 * because this list is also what BREAKS A CAPITALISED RUN: without "Know" in it,
 * "Do You Know David Miller" is one four-word run and the phrase it builds can
 * never match. Stopword removal happens inside Postgres, too late for that.
 */
const ASK_FRAME_WORDS: ReadonlySet<string> = new Set([
  // interrogatives / auxiliaries — run breakers
  'do',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'am',
  'have',
  'has',
  'had',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'who',
  'whom',
  'whose',
  'what',
  'which',
  'when',
  'where',
  'why',
  'how',
  // pronouns / determiners / prepositions — run breakers
  'i',
  'me',
  'my',
  'mine',
  'we',
  'us',
  'our',
  'ours',
  'you',
  'your',
  'yours',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'it',
  'its',
  'they',
  'them',
  'their',
  'theirs',
  'a',
  'an',
  'the',
  'any',
  'some',
  'of',
  'about',
  'for',
  'from',
  'in',
  'on',
  'at',
  'to',
  'with',
  'and',
  'or',
  'that',
  'this',
  // epistemic verbs — NOT postgres stopwords, and the actual false-positive
  // engines: 'seen' alone matched 297 of the owner's 19,241 entities.
  'know',
  'knows',
  'knew',
  'known',
  'knowing',
  'see',
  'sees',
  'saw',
  'seen',
  'seeing',
  'meet',
  'meets',
  'met',
  'tell',
  'tells',
  'told',
  'say',
  'says',
  'said',
  'ask',
  'asks',
  'asked',
  'think',
  'thinks',
  'thought',
  'remember',
  'remembers',
  'remembered',
  'recall',
  'recalls',
  'recalled',
  'hear',
  'hears',
  'heard',
  'mention',
  'mentions',
  'mentioned',
  'ever',
  'never',
  'please',
  'thanks',
  'anything',
  'anyone',
  'anybody',
  'someone',
  'somebody',
  'something',
]);

/**
 * Words that say what KIND of thing is asked about, not what it shows.
 *
 * "Do you have any photos of the volcano?" used to answer "at least one" for
 * anyone with photos and no volcano: 'photo' is on every photo event, so the
 * OR of terms was satisfied by the kind word alone. Videos are the same: every
 * video event's title opens with 'Video'. As a loose term the kind word is not
 * evidence of anything the asker named. It is dropped from the terms and the
 * ask executor turns it into a type filter instead (see
 * {@link promptMediaClass}). The value is the data class it stands for.
 *
 * Only ever dropped as a loose TERM: inside a run of capitalised words
 * ("Google Photos") or in a name ask it stays, because there it is part of
 * what has to match.
 */
const MEDIA_KIND_WORDS: ReadonlyMap<string, 'photos' | 'media'> = new Map([
  ['photo', 'photos'],
  ['photos', 'photos'],
  ['picture', 'photos'],
  ['pictures', 'photos'],
  ['pic', 'photos'],
  ['pics', 'photos'],
  ['image', 'photos'],
  ['images', 'photos'],
  ['video', 'media'],
  ['videos', 'media'],
]);

/**
 * The data class a word names when it is a {@link MEDIA_KIND_WORDS} word.
 *
 * A trailing apostrophe, "'s" or hyphen is ignored: "photo's" and "photos'"
 * are the same kind word, and Postgres reduces both to 'photo', so keeping
 * them as terms would bring back the match on every photo event.
 */
function mediaKindOf(word: string): 'photos' | 'media' | undefined {
  return MEDIA_KIND_WORDS.get(word.toLowerCase().replace(/(?:['’]s?|-)+$/u, ''));
}

/**
 * Characters that may sit INSIDE one word. Everything else separates words and
 * ends a capitalised run, so "Alice, Bob" is two names rather than the phrase
 * `'alice' <-> 'bob'` that would match neither of them.
 *
 * A `.` or `_` between two letters or digits is matched here too, so a file
 * name ("PXL_20261021_115500_010.jpg") comes out as one candidate. Only a
 * candidate that {@link FILE_NAME_PATTERN} accepts stays whole; see
 * {@link promptWords}. A sentence's closing `.` is followed by nothing, so it
 * always ends the word.
 */
const WORD_PATTERN = /[\p{L}\p{N}](?:[\p{L}\p{N}'’-]|[._](?=[\p{L}\p{N}]))*/gu;

/** One word with no `.` or `_` inside it. */
const PLAIN_WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * A word that ends in a file extension. Postgres indexes a file name as one
 * lexeme ("pxl_20261021_115500_010.jpg"); split into `pxl`, `20261021`, … the
 * prompt could never match it.
 *
 * Anything else with a `.` or `_` inside is split there, as before: Postgres
 * reads "alice.wong" as one lexeme too, which no "Alice Wong" carries, and
 * splits "photos_of_me" back into 'photo' on its own, which every photo event
 * carries. The media extensions mirror `MEDIA_FILENAME_RE` in
 * `search-ingress/searchTexts.ts`.
 */
const FILE_NAME_PATTERN =
  /\.(?:jpe?g|png|gif|webp|heic|heif|tiff?|bmp|dng|raw|cr2|nef|mp4|mov|m4v|avi|mkv|webm|3gp|mpe?g|wmv|mp3|m4a|wav|flac|pdf|docx?|xlsx?|pptx?|txt|csv|md|json|zip)$/iu;

/** The prompt's words and where each starts, with only file names kept whole. */
function* promptWords(prompt: string): Generator<{ word: string; start: number }> {
  for (const match of prompt.matchAll(WORD_PATTERN)) {
    const word = match[0];
    const start = match.index ?? 0;

    if (!/[._]/u.test(word) || FILE_NAME_PATTERN.test(word)) {
      yield { word, start };
      continue;
    }

    for (const part of word.matchAll(PLAIN_WORD_PATTERN)) {
      yield { word: part[0], start: start + (part.index ?? 0) };
    }
  }
}

/** A word is "named" if it opens with an uppercase letter. */
function isCapitalised(word: string): boolean {
  return /^\p{Lu}/u.test(word);
}

/**
 * Does the prompt open with an explicit person-recognition / relationship
 * question frame ("do you know …", "have you met …", "who is …")?
 *
 * Closes G1 (`docs/asks-system-guide.md` §9): the asker controls BOTH
 * capitalisation and `queryType`, so sending `queryType: 'content'` with a
 * lowercase prompt `"do you know david miller"` used to skip `subjectIsName`
 * and treat `'david'` and `'miller'` as loose OR-joined topic terms — matching
 * Steve Miller and answering `"Yes."` unattended. Detecting the relationship
 * speech-act frame on the prompt text itself forces the residual subject to
 * bind as a required phrase regardless of `queryType` or casing.
 */
const NAME_SUBJECT_FRAME_RE =
  /^\s*(?:(?:do|does|did)\s+(?:you|we|they|he|she|i)\s+(?:ever\s+)?(?:know|meet|remember)|(?:have|has|had)\s+(?:you|we|they|he|she|i)\s+(?:ever\s+)?(?:met|known|heard\s+of)|who\s+(?:is|was|are|were)|(?:are|is|was|were)\s+(?:you|we|they|he|she)\s+(?:friends|acquainted|familiar|related)\s+with)\b/iu;

export function hasNameSubjectFrame(prompt: string): boolean {
  return NAME_SUBJECT_FRAME_RE.test(prompt);
}

/**
 * Split the prompt into runs of words that are adjacent in the ORIGINAL TEXT:
 * punctuation between two words ends the run, ask-frame words end it too.
 *
 * ORDERING TRAP: frame removal has to happen HERE, while the run is being cut,
 * and not as a filter afterwards. Deleting "Tell" from "Did Amanda Tell Brian"
 * as a post-filter splices "Amanda" and "Brian" into one phrase that names
 * nobody; treating it as a boundary yields two separate one-word groups, which
 * is what the sentence actually says.
 */
function toAdjacentRuns(prompt: string): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  let cursor = 0;

  const flush = () => {
    if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  };

  for (const { word, start } of promptWords(prompt)) {
    // Anything other than plain spaces between the previous word and this one
    // (a comma, a question mark, a newline) is a boundary.
    if (current.length > 0 && !/^[ \t]*$/.test(prompt.slice(cursor, start))) {
      flush();
    }

    cursor = start + word.length;

    if (ASK_FRAME_WORDS.has(word.toLowerCase())) {
      flush();
      continue;
    }

    current.push(word);
  }

  flush();

  return runs;
}

/**
 * Rebuild an asker's prompt as required phrases plus alternative terms.
 *
 * Returns an EMPTY array when the prompt carries no content of its own — an
 * empty string, pure punctuation, or nothing but ask scaffolding ("do you
 * know?"). Callers must read that as "match nothing", which is the only safe
 * reading: a question with no subject has no true answer to disclose.
 */
export function buildPromptQuery(prompt: string, options: BuildPromptQueryOptions = {}): PromptQueryGroup[] {
  const runs = toAdjacentRuns(prompt);

  if (options.subjectIsName || hasNameSubjectFrame(prompt)) {
    // The residual IS the name. Every run is required, so "Alice? Bob?" asks
    // about both rather than about either — an ask that names two people and
    // gets "Yes" for one of them is the same fabrication in a different shape.
    return runs.map((run) => ({ kind: 'phrase' as const, text: run.join(' ') }));
  }

  const groups: PromptQueryGroup[] = [];

  // A loose term, unless it only names the kind of thing asked about.
  const pushTerm = (word: string) => {
    if (mediaKindOf(word) == null) {
      groups.push({ kind: 'term', text: word });
    }
  };

  for (const run of runs) {
    let index = 0;

    while (index < run.length) {
      if (!isCapitalised(run[index])) {
        pushTerm(run[index]);

        index += 1;
        continue;
      }

      let end = index;
      while (end < run.length && isCapitalised(run[end])) {
        end += 1;
      }

      // A lone capitalised word carries no adjacency to enforce — it is just a
      // word, and requiring it would silently narrow every sentence-initial one.
      if (end - index === 1) {
        pushTerm(run[index]);
      } else {
        groups.push({ kind: 'phrase', text: run.slice(index, end).join(' ') });
      }

      index = end;
    }
  }

  return groups;
}

/**
 * Which media class a topic ask says it is about: 'photos' for "photos of …"
 * or "any pictures …", 'media' once it names videos, `null` for neither.
 *
 * A {@link MEDIA_KIND_WORDS} word counts when it stands on its own, which is
 * exactly when {@link buildPromptQuery} drops it from the terms. The ask
 * executor reads the class as a type filter so the kind still narrows the
 * search once it stops counting as a match. A name ask, or the word inside a
 * capitalised name, says nothing about kind and answers `null`.
 */
export function promptMediaClass(
  prompt: string,
  options: BuildPromptQueryOptions = {},
): 'photos' | 'media' | null {
  if (options.subjectIsName || hasNameSubjectFrame(prompt)) {
    return null;
  }

  let found: 'photos' | 'media' | null = null;

  for (const run of toAdjacentRuns(prompt)) {
    for (const [index, word] of run.entries()) {
      const kind = mediaKindOf(word);

      // Part of a capitalised run of two or more ("Google Photos"): a name.
      const inName =
        isCapitalised(word) &&
        ((index > 0 && isCapitalised(run[index - 1])) ||
          (index < run.length - 1 && isCapitalised(run[index + 1])));

      if (kind == null || inName) {
        continue;
      }

      // 'media' covers photos too, so it wins once any video word is named.
      if (kind === 'media') {
        return 'media';
      }

      found = kind;
    }
  }

  return found;
}

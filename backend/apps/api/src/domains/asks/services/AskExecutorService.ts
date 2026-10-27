import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  INDEXABLE_ENTITIES,
  type EntityIdentifier,
  type IndexableEntity,
  type PromptSearchResult,
  SearchService,
  hasNameSubjectFrame,
  promptMediaClass,
} from '@ci/domains/search-next';

import { type Ask } from '../entities/AskEntity';
import { canonicalDataClass } from '../grantMatch';
import type { AskQuery } from '../types';

/**
 * Ask types whose subject is a PERSON, not a topic.
 *
 * These mirror the `relationship` / `identity` branches of `inferAnswerForm` —
 * kept as a literal list rather than imported so a change there cannot silently
 * change retrieval semantics here, and vice versa. What the flag buys: the
 * residual prompt is bound as a PHRASE, so "David Miller" needs adjacent
 * 'david' and 'miller' in one entity and can never be answered by Steve Miller.
 * A topic ask ("photos of the beach") must NOT get this treatment — nothing in a
 * corpus carries 'photo' adjacent to 'beach', so it would answer nothing.
 */
const NAME_SUBJECT_QUERY_TYPES: ReadonlySet<string> = new Set([
  'relationship',
  'know',
  'boolean',
  'identity',
  'identity-claim',
  'confirm',
  'are-you',
]);

/**
 * Cap on how many matches one ask may be computed over.
 *
 * The cap is not a privacy control (the disclosure filter is), it is a cost
 * bound — but it USED to be silent, so a count answer saturating here reported
 * "50" for a corpus that held 607. {@link AskExecution.truncated} is what makes
 * the difference visible; the cap itself is unchanged.
 */
const DEFAULT_MAX_RESULTS = 50;

/** Coarse data-class → candidate entity-type hints (validated against the taxonomy). */
const CLASS_TYPE_HINTS: Readonly<Record<string, readonly string[]>> = {
  photos: ['file'],
  media: ['file'],
  files: ['file'],
  documents: ['content', 'file'],
  events: ['event'],
  calendar: ['event'],
  messages: ['communication'],
  communications: ['communication'],
};

/**
 * Runs a bounded ask query inside the RESPONDER's memory scope and returns the
 * matching entity identifiers.
 *
 * This is the run-as-owner executor: the query executes as
 * `{ userId: responderUserId }`, mirroring how `SearchResolver.runSharedSearch`
 * runs a shared search as its owner. The ask query is asker-supplied (hostile),
 * so ONLY its text (keyword mode — no embedding side effects) and an optional
 * known data-class → entity-type filter are honored; nothing else from the asker
 * reaches search.
 *
 * Phase 0 returns the raw scoped identifiers for the owner's preview / dogfood.
 * The disclosure filter that turns these into a synthesized, redactable answer
 * for the asker — and the actual cross-person delivery — is Phase 1+.
 *
 * ═══ WHY THIS DOES NOT USE `search({ mode: 'keyword' })` ═══
 *
 * It used to, and the consequence was that this box answered questions about
 * people who do not exist. That mode OR-joins every token with no floor, so
 * "Do you know Zerbcorpolis Fnargle?" matched 10 entities on the word 'know'
 * and the boolean rung answered "Yes." — a false claim about the owner, made to
 * someone whose opinion of the owner matters, and invisible to the owner because
 * a boolean answer discloses only the word "Yes". `searchPrompt` rebuilds the
 * question so that anything the asker NAMED has to actually be there; see
 * `buildPromptQuery` in the search-next domain for the measurements.
 */
@Injectable()
export class AskExecutorService {
  constructor(
    private readonly searchService: SearchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskExecutorService.name);
  }

  /**
   * The matched identifiers, for callers that only turn them into a count or a
   * yes/no. Prefer {@link executeWithMeta} where truncation can be surfaced.
   */
  async execute(
    ask: Ask,
    options: { maxResults?: number } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    const { items } = await this.executeWithMeta(ask, options);

    return items;
  }

  /**
   * The matched identifiers PLUS whether the match set was cut off at the cap.
   *
   * Two answers that look identical to `execute` are not the same answer: 50
   * matches out of 50, and 50 matches out of 607. The disclosure ladder turns
   * both into the number 50, and only one of them is true. Callers rendering a
   * `count` rung should read {@link PromptSearchResult.truncated} and say "at
   * least" — the executor cannot say it for them, so it says it in the log.
   */
  async executeWithMeta(ask: Ask, options: { maxResults?: number } = {}): Promise<AskExecution> {
    // Only an ask with a LOCAL responder has memory here to search. An outbound
    // ask is answered by the peer's box, so reaching the executor with one is a
    // programming error, not a runtime condition to paper over.
    if (ask.responderUserId == null) {
      throw new Error(`Ask ${ask.id} has no local responder and cannot be executed here`);
    }

    const responderContext: UserServiceContext = { userId: ask.responderUserId };
    // The archetype the asker declared — OR a relationship/person-recognition
    // question frame in the prompt itself (closing G1) — decides whether the
    // prompt is a NAME or a topic. `subjectIsName` can only ever narrow: it
    // turns an OR of loose words into one required phrase.
    const subjectIsName =
      NAME_SUBJECT_QUERY_TYPES.has(ask.query.queryType.toLowerCase()) ||
      hasNameSubjectFrame(ask.query.prompt);
    const includeTypes = toIncludeTypes(ask.query, subjectIsName);

    const result = await this.searchService.searchPrompt(responderContext, {
      prompt: ask.query.prompt,
      subjectIsName,
      maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
      ...(includeTypes ? { includeTypes } : {}),
    });

    if (result.truncated) {
      // Owner-visible, on the owner's own box. The asker learns nothing from
      // this line; the owner learns that the number they are about to disclose
      // is a floor rather than a count.
      this.logger.warn(
        `Ask ${ask.id} matched ${result.totalMatches} entities but was capped at ${result.limit}; ` +
          'any count disclosed for it is a lower bound, not an exact figure',
      );
    }

    return result;
  }
}

/**
 * What one ask actually matched. Structurally the search result — re-exported
 * under the ask domain's own name so callers here do not have to reach into the
 * search domain's vocabulary to read a truncation flag.
 */
export type AskExecution = PromptSearchResult;

function toIncludeTypes(query: AskQuery, subjectIsName: boolean): IndexableEntity[] | undefined {
  // Same canonical form the grant evaluator matched on — if these diverged, a
  // peer could satisfy one and evade the other.
  //
  // With no class named, "photos of …" (or "videos of …") in the prompt stands
  // in for the class. `buildPromptQuery` no longer lets those words count as a
  // match (they matched every photo or video event), so the kind is carried
  // here, as a filter, instead. Only ever narrows: an ask with no class
  // searched every type. A class that canonicalizes to nothing is "no class
  // named" here exactly as it is to the grant evaluator.
  const canonical = canonicalDataClass(query.dataClass) ?? promptMediaClass(query.prompt, { subjectIsName });
  if (canonical == null) {
    return undefined;
  }

  const hints = CLASS_TYPE_HINTS[canonical];
  if (hints == null) {
    return undefined; // unknown class → unfiltered (still responder-scoped)
  }

  const valid = hints.filter((type): type is IndexableEntity =>
    (INDEXABLE_ENTITIES as readonly string[]).includes(type),
  );

  return valid.length > 0 ? valid : undefined;
}

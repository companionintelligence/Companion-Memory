import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { PlaceService, queryNamesPlace } from '@ci/domains/memory';
import {
  INDEXABLE_ENTITIES,
  type EntityIdentifier,
  type IndexableEntity,
  type PromptSearchResult,
  SearchService,
  buildPromptQuery,
  hasNameSubjectFrame,
  promptMediaClass,
} from '@ci/domains/search-next';

import { type Ask } from '../entities/AskEntity';
import { canonicalDataClass } from '../grantMatch';
import { photoAskMayMatchPlaces } from '../policy';
import type { AskQuery, TrustTier } from '../types';

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

/**
 * Words of a photo ask that say how the photo relates to a place, not what it
 * shows: "photos taken at", "near". The ask frame words ("do you have", "of",
 * "at") are already gone from {@link buildPromptQuery}'s groups.
 */
const PLACE_REQUEST_WORDS: ReadonlySet<string> = new Set(['taken', 'near', 'around', 'by']);

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
    private readonly places: PlaceService,
  ) {
    this.logger.setContext(AskExecutorService.name);
  }

  /**
   * The matched identifiers, for callers that only turn them into a count or a
   * yes/no. Prefer {@link executeWithMeta} where truncation can be surfaced.
   */
  async execute(ask: Ask, options: AskExecutionOptions = {}): Promise<EntityIdentifier<IndexableEntity>[]> {
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
  async executeWithMeta(ask: Ask, options: AskExecutionOptions = {}): Promise<AskExecution> {
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
    const canonical = askedClass(ask.query, subjectIsName);
    const includeTypes = toIncludeTypes(canonical);
    // A photo's place and capture date live on its event, so a photo ask also
    // searches photo events. Only the photo (and video) ones: see
    // `SearchService.searchPrompt`'s `mediaEvents`.
    const mediaEvents =
      includeTypes && (canonical === 'photos' || canonical === 'media') ? canonical : undefined;
    // The place on those events counts only for a tier allowed to learn it, and
    // never when the caller didn't say who is asking.
    const mediaEventPlaces =
      options.tier != null && photoAskMayMatchPlaces(options.tier, ask.query.dataClass);

    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const searched = await this.searchService.searchPrompt(responderContext, {
      prompt: ask.query.prompt,
      subjectIsName,
      maxResults,
      ...(includeTypes ? { includeTypes } : {}),
      ...(mediaEvents ? { mediaEvents, mediaEventPlaces } : {}),
    });
    // The search above can match a photo by its place only through its event's
    // `location_name`, which a geocoder writes. Without one (Memory Desktop) that
    // is NULL on every photo, so "photos of Blue Bottle Coffee" answered "They
    // have none." while chat found the photos by where they were taken. The
    // same lookup chat uses answers instead, under the same tier rule, and only
    // when the prompt names nothing but the place.
    const atPlace =
      mediaEvents && mediaEventPlaces
        ? await this.photosAtNamedPlace(responderContext, ask, subjectIsName, maxResults)
        : null;
    const result = atPlace ?? searched;

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

  /**
   * The photos taken at the place a photo ask names, as chat's
   * `media.findPhotos` finds them ({@link PlaceService.photosAtNamedPlace}), or
   * null to keep the text search's answer.
   *
   * Null unless every word the prompt asks about belongs to the name of a place
   * it names. The lookup answers with every photo taken there, so "photos of my
   * dog at Blue Bottle Coffee" must not get "yes" for a coffee shop with no dog
   * in it. Null too when it finds nothing, or fails (logged).
   */
  private async photosAtNamedPlace(
    context: UserServiceContext,
    ask: Ask,
    subjectIsName: boolean,
    maxResults: number,
  ): Promise<AskExecution | null> {
    const groups = buildPromptQuery(ask.query.prompt, { subjectIsName }).filter(
      (group) => !PLACE_REQUEST_WORDS.has(group.text.toLowerCase()),
    );

    if (groups.length === 0) {
      return null;
    }

    try {
      const found = await this.places.photosAtNamedPlace(context, ask.query.prompt, maxResults);
      const placeOnly =
        found.places.length > 0 &&
        groups.every((group) => found.places.some((place) => queryNamesPlace(place.name, group.text)));

      if (!placeOnly || found.total === 0) {
        return null;
      }

      return {
        items: found.fileIds.map((id) => ({ id, type: 'file' as const })),
        totalMatches: found.total,
        truncated: found.total > found.fileIds.length,
        limit: maxResults,
      };
    } catch (error) {
      this.logger.warn(
        `Ask ${ask.id}: could not look for photos at a named place; answering from the text search ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );

      return null;
    }
  }
}

export interface AskExecutionOptions {
  maxResults?: number;
  /**
   * The asker's trust tier. A photo ask matches a photo by the place on its
   * event only when this tier may learn places (`photoAskMayMatchPlaces`).
   * Absent, it never does.
   */
  tier?: TrustTier;
}

/**
 * What one ask actually matched. Structurally the search result — re-exported
 * under the ask domain's own name so callers here do not have to reach into the
 * search domain's vocabulary to read a truncation flag.
 */
export type AskExecution = PromptSearchResult;

/**
 * The data class an ask is about: the one it names, or for none the kind its
 * prompt names.
 *
 * Same canonical form the grant evaluator matched on — if these diverged, a
 * peer could satisfy one and evade the other.
 *
 * With no class named, "photos of …" (or "videos of …") in the prompt stands in
 * for the class. `buildPromptQuery` no longer lets those words count as a match
 * (they matched every photo or video event), so the kind is carried here, as a
 * filter, instead. Only ever narrows: an ask with no class searched every type.
 * A class that canonicalizes to nothing is "no class named" here exactly as it
 * is to the grant evaluator.
 */
function askedClass(query: AskQuery, subjectIsName: boolean): string | null {
  return canonicalDataClass(query.dataClass) ?? promptMediaClass(query.prompt, { subjectIsName });
}

function toIncludeTypes(canonical: string | null): IndexableEntity[] | undefined {
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

import { Injectable, Optional } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { fenceUntrusted, untrustedBlock } from '@ci/common/prompt/untrustedBlock';
import { EntityResolutionService, type ResolvedEntity } from '@ci/domains/entity-resolution';
import { EventService } from '@ci/domains/events';
import { GraphExpansionService } from '@ci/domains/graph';
import { PersonService, UserContextService } from '@ci/domains/memory';
import { type RetrievalPolicy, RetrievalPolicyService } from '@ci/domains/retrieval-policy';
import {
  type IndexableEntity,
  queryTokenCount,
  RetrievalQueryEvent,
  type RetrievalQueryPayload,
  SearchService,
} from '@ci/domains/search-next';

import type { EvidenceVoice, RecallDto, RecallLine, RecallResult } from '../types';

import { AgentMemoryService } from './AgentMemoryService';
import { SerializerService } from './SerializerService';

const DEFAULT_MAX_RESULTS = 5;

/**
 * ═══ Where the recall knobs live now ═══
 *
 * `MESSAGE_RESULTS`, `MESSAGE_DISTANCE_FLOOR`, `SEED_MODE`,
 * `GROUNDED_SIMILARITY_FLOOR` and `ANCHORED_DEPTH_MULTIPLIER` used to be
 * module-level literals here. They are fields of the appliance's versioned
 * retrieval policy (`ci.retrieval_policy`, read through
 * {@link RetrievalPolicyService}), because the tuning loop that sets them is
 * already being run by hand — the comments they carried said as much ("flip the
 * constant (not the call sites) if the benchmark reverses it") — and a measured
 * result should be promotable without an edit-rebuild-redeploy.
 *
 * The baseline is unchanged and still stated in code, as
 * `RETRIEVAL_POLICY_DEFAULTS` in `domains/retrieval-policy/constants.ts`. v1 of
 * the table is seeded with exactly those numbers and the service falls back to
 * them when the table is empty or unreachable, so behaviour is identical until
 * somebody promotes a v2. What each one meant, unchanged:
 *
 * - `recallMessageResults` (10) — raw-message ("naive RAG") channel: how many
 *   source fragments to vector-search and union into the recall block alongside
 *   the graph nodes + expansion. The merge itself is uncapped (tuning showed
 *   capping/re-ranking only hurts); the noise control lives in
 *   `SearchService.searchMessages`' cosine-distance floor (gap G5) rather than
 *   in a post-hoc cap here.
 * - `recallMessageDistanceFloor` (null) — cosine-distance floor forwarded to
 *   `searchMessages`. Null/undefined means "use the SearchService default" (0.5,
 *   matching semantic mode). See memory-and-search plan §5 ("searchMessages
 *   floor → start at 0.5").
 * - `recallSeedMode` ('boosted') — seed mode for the entity/graph channel.
 *   DECISION (memory-and-search plan §5, "Default recall seed mode boosted vs.
 *   hybrid → keep boosted; switch only if the merged benchmark shows hybrid
 *   winning"). Boosted is the most reliable seed finder for entity-centric KG
 *   queries and, unlike 'hybrid', never lets a pure-semantic single-channel hit
 *   outrank a keyword-anchored one. Reversing it is now a v2 promotion rather
 *   than a diff.
 *
 * ── `groundedSimilarityFloor` (0.7) ────────────────────────────────────────
 *
 * Cosine-SIMILARITY floor for the 'grounded' strategy's semantic channel.
 *
 * `semanticSearch`'s own default (0.5) is a "not obviously unrelated" bar, which
 * is the right bar when the caller is a person scrolling results and the wrong
 * one when the caller is a model being told these lines are EVIDENCE. Measured
 * over the answer-inference question set on the reference corpus, 0.7 is where
 * the two populations separate:
 *
 *   kept    "What's your favorite food?" 0.901 · "Where do you live?" 0.889
 *           "…what languages are you using?" 0.810 · "What are you learning?" 0.822
 *   dropped "Excellent!  Following." 0.652 · "Much more to follow." 0.600
 *           "Yup. Following $$$$." 0.598
 *
 * The dropped rows are the whole semantic result for "What sports do you
 * follow?" — every one of them a match on the word 'follow' and none of them
 * about sport. A model handed those infers from noise; handed nothing, it says
 * so, and the anchored channel (which returns real sporting-goods trips) carries
 * the question instead.
 *
 * ── `anchoredDepthMultiplier` (2) ──────────────────────────────────────────
 *
 * How much deeper the 'grounded' strategy cuts its anchored channel than its
 * semantic one.
 *
 * The two channels' precision decays at very different rates. The semantic
 * channel is at its floor by rank 8 — rank 1 scores ~0.90 and rank 8 ~0.75, and
 * one more rank is one step closer to the noise the floor exists to exclude. The
 * anchored channel does not decay that way: every row in it carries the
 * question's selective term by construction, so rank 20 is still on-topic.
 * Measured, ranks 9–20 for "What is your favorite cuisine?": Haveli, Pailin
 * Thai, Choya Japanese, Akbar, Ashoka, Tara's Himalayan — all restaurants; and
 * for "What sports do you follow?": "There are a few sports bars around me",
 * "Enjoying the weekend and watching sports", Nintendo Switch Sports, EA Sports.
 *
 * So the anchored channel is allowed a deeper cut, which is also what keeps the
 * behavioural evidence broad enough to answer a question the conversational
 * channel cannot: one restaurant trip is an anecdote, twelve are a preference.
 * Depth costs nothing — {@link SearchService.searchAnchored}'s match set is
 * capped at the anchor's document frequency, so rank 16 and rank 8 read the same
 * rows.
 *
 * 2× rather than something smaller because the row that answers a question
 * outright can sit well down the list: "Toki Pona: The Language You Can Learn in
 * a Day" — the record behind this user's actual answer to "Which languages are
 * you learning?" — is rank 14.
 */

export interface RecallOptions {
  /**
   * How the seed channel is built.
   *
   * - `seed-then-fallback` (default) — today's behaviour, unchanged: one
   *   `policy.recallSeedMode` search, falling back to semantic only when it is
   *   empty.
   *   Tuned for entity-centric agent queries, where a keyword anchor is usually
   *   present and recall beats precision.
   * - `grounded` — precision-first, for callers that put the result in front of
   *   a model AS EVIDENCE and need every line to be defensible: a
   *   high-similarity semantic channel unioned with
   *   {@link SearchService.searchAnchored}'s selectivity-gated lexical channel.
   */
  strategy?: 'seed-then-fallback' | 'grounded';
  /**
   * Entity types kept out of the seed channels, on top of the always-excluded
   * 'message' (which has its own channel).
   */
  excludeTypes?: IndexableEntity[];
  /**
   * Override whether exponential recency decay is applied to message-channel
   * hits. Defaults to the user's `memoryRecencyDecayEnabled` setting (true).
   */
  recencyDecay?: boolean;
}

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90;
const DEFAULT_RECENCY_MIN_MULTIPLIER = 0.25;

/**
 * Exponential temporal recency decay (`knowl` pattern): weights a base relevance
 * score by $2^{-\text{ageDays} / \text{halfLifeDays}}$, floored at `minMultiplier`
 * so foundational older memories never decay to zero.
 */
export function applyRecencyDecay(
  baseScore: number,
  timestamp: Date | string | null | undefined,
  options: { now?: Date; halfLifeDays?: number; minMultiplier?: number } = {},
): number {
  if (!timestamp) {
    return baseScore;
  }

  const parsed = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return baseScore;
  }

  const now = options.now ?? new Date();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const minMultiplier = options.minMultiplier ?? DEFAULT_RECENCY_MIN_MULTIPLIER;
  const ageDays = Math.max(0, (now.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24));
  const decay = Math.max(minMultiplier, Math.pow(2, -ageDays / halfLifeDays));

  return baseScore * decay;
}

/**
 * L1 — per-turn keyword/semantic search against the knowledge graph.
 *
 * Runs SearchService in 'auto' mode (keyword for short queries, boosted for
 * medium, semantic for long), resolves the returned identifiers into full
 * domain entities via EntityResolutionService, serialises them into compact
 * single-line strings, then expands one query-relevant hop through the graph
 * (GraphExpansionService) so relational questions ("where does X live?") can
 * reach the answer node that sits one edge away from the search hit.
 */
@Injectable()
export class RecallService {
  constructor(
    private readonly searchService: SearchService,
    private readonly entityResolution: EntityResolutionService,
    private readonly serializer: SerializerService,
    private readonly graphExpansion: GraphExpansionService,
    private readonly agentMemory: AgentMemoryService,
    private readonly events: EventService,
    private readonly logger: LoggerService,
    private readonly retrievalPolicy: RetrievalPolicyService,
    @Optional() private readonly personService?: PersonService,
    @Optional() private readonly userContextService?: UserContextService,
  ) {
    this.logger.setContext(RecallService.name);
  }

  /**
   * Emit one `retrieval.query` row onto the `telemetry` queue, fire-and-forget.
   *
   * `recall` already computes `resultCount` and hands it to its caller, who
   * throws it away — so a recall that returned NOTHING has, until now, been
   * completely silent (the only log calls in this class are `.warn` on the two
   * failure paths). This is the write that makes an empty recall countable.
   * Never awaited and never rethrown: recall has already produced its answer.
   */
  private recordQuery(payload: RetrievalQueryPayload): void {
    void this.events.send(RetrievalQueryEvent, payload, { queue: 'telemetry' }).catch((err: unknown) => {
      this.logger.warn('retrieval.query emit failed (non-fatal)', {
        userId: payload.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async recall(
    context: UserServiceContext,
    dto: RecallDto,
    options: RecallOptions = {},
  ): Promise<RecallResult> {
    const maxResults = dto.maxResults ?? DEFAULT_MAX_RESULTS;
    const query = this.sanitizeQuery(dto.query);
    const startedAt = Date.now();
    const strategy = options.strategy ?? 'seed-then-fallback';
    // 'message' is always excluded from the seed channels; it has its own
    // naive-RAG channel below. Resolved once here so the telemetry row states
    // the filter the seeds actually ran with rather than the caller's request.
    const seedExcludeTypes: IndexableEntity[] = ['message', ...(options.excludeTypes ?? [])];

    /** One telemetry row for this recall. See {@link recordQuery}. */
    const record = (resultCount: number): void =>
      this.recordQuery({
        userId: context.userId,
        caller: 'recall',
        modeTaken: strategy,
        queryTokenCount: queryTokenCount(dto.query),
        includeTypes: null,
        excludeTypes: seedExcludeTypes,
        resultCount,
        // Recall merges three channels with three different score scales
        // (ts_rank seeds, graph neighbours with no score at all, cosine
        // message hits). There is no comparable top score to state, and
        // inventing one would put incomparable numbers in one column.
        topScore: null,
        latencyMs: Date.now() - startedAt,
      });

    if (!query) {
      // NOT recorded. An empty query is a caller passing nothing, not a
      // question this appliance failed to answer; counting it would inflate the
      // zero-result rate with non-questions and make the alert unreadable.
      return { block: '', resultCount: 0, lines: [] };
    }

    // Resolved ONCE per recall and threaded down, so both seed channels and the
    // message channel of a single call are guaranteed to have been built by the
    // same policy version. Re-reading per channel would let a promotion landing
    // mid-call produce a block that no single version explains.
    const policy = await this.retrievalPolicy.get();

    try {
      const results =
        strategy === 'grounded'
          ? await this.groundedSeeds(context, dto.query, maxResults, policy, seedExcludeTypes)
          : await this.seedThenFallback(context, query, maxResults, policy, seedExcludeTypes);

      if (results.length === 0) {
        record(0);

        return { block: '', resultCount: 0, lines: [] };
      }

      const resolved = await this.entityResolution.resolve(context, results);

      const lines: RecallLine[] = [];
      const includedIds = new Set<string>();

      // Identical text from distinct rows is one piece of evidence, not six —
      // six separate plays of "I Follow Rivers" or six different people asking
      // "Where do you live?" spend the whole block saying one thing. Only the
      // 'grounded' strategy collapses them: the existing callers' prompts are
      // built around the seed count they get today.
      const seenLines = options.strategy === 'grounded' ? new Set<string>() : null;

      // Preserve the original search-score ordering.
      for (const { type, id } of results) {
        const hit = resolved.get(`${type}:${id}`);

        if (!hit) {
          continue;
        }

        const line = this.serializer.serialize(hit);

        if (!line || seenLines?.has(line)) {
          continue;
        }

        lines.push({ text: line, voice: this.voiceOf(hit), ref: this.serializer.reference(hit) });
        includedIds.add(id);
        seenLines?.add(line);
      }

      if (lines.length === 0) {
        // Seeds were found but none of them survived resolution/serialisation,
        // so the caller still got nothing. Counted as a zero result, because
        // from the asker's side that is exactly what it is.
        record(0);

        return { block: '', resultCount: 0, lines: [] };
      }

      // Expand one query-relevant hop. Seeds are the search hits; their ids are
      // ci.entities entity_ids (item/content/event are indexed under the
      // 'concept' tag but keep their real id). Neighbours already shown as
      // seeds are excluded so we never duplicate a line.
      const seedIds = results.map((r) => r.id);
      const neighbours = await this.graphExpansion.expand(context, seedIds, query, includedIds);

      for (const neighbour of neighbours) {
        if (includedIds.has(neighbour.entityId)) {
          continue;
        }

        // A graph neighbour is a node in the OWNER's own graph — a place, a
        // person, a concept — not a line somebody spoke, so it carries no
        // speaker of its own and belongs to the archive's owner.
        //
        // The id is a `ci.entities.entity_id` and the node's own type is not
        // carried on `ExpandedNeighbour`, so the ref names the TABLE rather than
        // guessing the type: 'graph-node' resolves against ci.entities, which is
        // where a click would have to land anyway.
        lines.push({
          text: neighbour.line,
          voice: 'own',
          ref: { type: 'graph-node', id: neighbour.entityId, at: null },
        });
        includedIds.add(neighbour.entityId);
      }

      // Naive-RAG channel. The graph lines above are terse, lossy serialisations
      // ("Priya Sharma — lives in Phoenix"); the source sentences carry detail
      // the extraction dropped ("moved from Eugene last spring, lives with her
      // husband Arjun"). Vector-search the raw messages and union their text in.
      // Use the original (unsanitised) query — natural language embeds better.
      try {
        const messageHits = await this.searchService.searchMessages(
          context,
          dto.query,
          policy.recallMessageResults,
          // `null` in the policy row means "inherit searchMessages' own
          // default", which is what the constant's `undefined` meant.
          policy.recallMessageDistanceFloor ?? undefined,
        );

        if (messageHits.length > 0) {
          const memories = await this.agentMemory.findByIds(
            context,
            messageHits.map((hit) => hit.id),
          );
          const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
          const seenText = new Set(lines.map((line) => line.text));
          const useRecencyDecay = options.recencyDecay ?? (await this.isRecencyDecayEnabled(context.userId));

          const orderedHits = useRecencyDecay
            ? [...messageHits].sort((a, b) => {
                const memA = memoryById.get(a.id);
                const memB = memoryById.get(b.id);
                const scoreA = applyRecencyDecay(a.score ?? 1, memA?.createdAt);
                const scoreB = applyRecencyDecay(b.score ?? 1, memB?.createdAt);

                return scoreB - scoreA;
              })
            : messageHits;

          for (const hit of orderedHits) {
            const memory = memoryById.get(hit.id);
            if (!memory || memory.status === 'superseded') {
              continue;
            }

            const text = memory.content?.trim();

            if (text && !seenText.has(text)) {
              // An agent-memory fragment is a raw turn with no direction column
              // and no speaker in the text. Unattributable, so 'other': a line
              // whose speaker cannot be established must never be able to carry
              // a first-person claim about the owner.
              lines.push({
                text,
                voice: 'other',
                ref: {
                  type: 'agent-memory',
                  id: hit.id,
                  // The only timestamp this table has. Unlike an imported
                  // message's `time`, `created_at` on a fragment written by the
                  // agent IS when it happened.
                  at: memory.createdAt ? new Date(memory.createdAt).toISOString() : null,
                },
              });
              seenText.add(text);
            }
          }
        }
      } catch (err) {
        // The graph result still stands if the message channel fails.
        this.logger.warn('Message-channel retrieval failed', {
          userId: context.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // The rendered block is fenced; `lines` is NOT. Every line here is a clip
      // of somebody else's email, SMS or web page, so it goes into the prompt
      // as marked data. It stays byte-exact on `lines`, because the
      // answer-inference citation numbering and the stored snippets key off
      // those bytes and a `\n` swallowed by fencing would move a citation.
      const block = untrustedBlock(
        lines.map((line) => fenceUntrusted(line.text)).join('\n'),
        '## Relevant context',
      );

      record(lines.length);

      return { block, resultCount: lines.length, lines };
    } catch (err) {
      // NOT recorded as a zero result. A thrown recall is a broken retrieval,
      // not an empty one, and folding the two together would let an outage read
      // as "the corpus has no answer". It already has its own warn line.
      this.logger.warn('Recall failed', {
        userId: context.userId,
        error: err instanceof Error ? err.message : String(err),
      });

      return { block: '', resultCount: 0, lines: [] };
    }
  }

  /**
   * Who produced this line.
   *
   * A communication is the only resolved type that has a speaker other than the
   * archive's owner: an INBOUND message is somebody else talking. Everything
   * else the resolver returns — browser activity, events, places, items,
   * receipts, notes, files, graph concepts — is a record of what the OWNER did,
   * which is first-person evidence even though nobody said it out loud.
   */
  private voiceOf(hit: ResolvedEntity): EvidenceVoice {
    if (hit.type !== 'communication') {
      return 'own';
    }

    return hit.entity.direction === 'outbound' ? 'own' : 'other';
  }

  // ---------------------------------------------------------------------------
  // Seed strategies
  // ---------------------------------------------------------------------------

  /**
   * The original seed channel, unchanged.
   *
   * 'boosted' (keyword match + embedding boost, OR-joined) is the most reliable
   * seed finder for entity-centric KG queries — short or long. 'auto' routes 8+
   * word questions ("What does Jordan's brother do for work?") to pure semantic
   * search, which frequently returns nothing and leaves graph expansion with no
   * seed to expand from. Fall back to semantic only when boosted is empty
   * (genuinely paraphrased queries).
   */
  private async seedThenFallback(
    context: UserServiceContext,
    query: string,
    maxResults: number,
    policy: RetrievalPolicy,
    exclude: IndexableEntity[] = [],
  ) {
    const seeded = await this.searchService.search(context, {
      query,
      mode: policy.recallSeedMode,
      maxResults,
      excludeTypes: exclude,
    });

    if (seeded.length > 0) {
      return seeded;
    }

    return this.searchService.search(context, {
      query,
      mode: 'semantic',
      maxResults,
      excludeTypes: exclude,
    });
  }

  /**
   * Precision-first seeds for a caller that will label the result EVIDENCE.
   *
   * Two channels, unioned, each with its own budget of `maxResults`, because
   * they answer different halves of a question about a person:
   *
   *   1. SEMANTIC, at the policy's `groundedSimilarityFloor` rather than the looser
   *      search default — what the user and others have SAID. This is the
   *      channel that finds "Favorite food? Hard to choose… Mexican and Indian
   *      cuisine is my usual go to."
   *   2. ANCHORED LEXICAL — what the user has DONE. Records of behaviour rarely
   *      paraphrase the question, so they sit below any useful semantic floor
   *      (the restaurant trips answering "favorite cuisine" score 0.43–0.48);
   *      they are reachable only by the word that makes the question specific.
   *      {@link SearchService.searchAnchored} is what makes that word-match safe.
   *
   * The lexical channel goes FIRST. It is the higher-precision of the two by
   * construction — every row carries a selective term — and on a question the
   * semantic channel can only answer with other people's questions ("Where do
   * you live?"), the behavioural rows are the only lines with an answer in them.
   *
   * If BOTH come back empty the caller gets nothing rather than a loosened
   * retry: the floors are the point, and a question this corpus cannot support
   * should read as unsupported.
   */
  private async groundedSeeds(
    context: UserServiceContext,
    rawQuery: string,
    maxResults: number,
    policy: RetrievalPolicy,
    exclude: IndexableEntity[] = [],
  ) {
    const [anchored, semantic] = await Promise.all([
      // The RAW question, not the sanitised one: `searchAnchored` needs the
      // sentence both to pick lexemes from and to embed, and natural language
      // embeds better than a punctuation-stripped bag of words.
      this.searchService.searchAnchored(context, rawQuery, {
        maxResults: Math.round(maxResults * policy.anchoredDepthMultiplier),
        excludeTypes: exclude,
      }),
      this.searchService.search(context, {
        query: rawQuery,
        mode: 'semantic',
        maxResults,
        excludeTypes: exclude,
        distanceThreshold: 1 - policy.groundedSimilarityFloor,
      }),
    ]);

    const seen = new Set<string>();
    const merged: typeof anchored = [];

    for (const hit of [...anchored, ...semantic]) {
      const key = `${hit.type}:${hit.id}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(hit);
    }

    return merged;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Strips punctuation and normalises whitespace so the query works cleanly
   * with Postgres websearch_to_tsquery.
   *
   * NOT keyword extraction — stop-word removal and stemming are delegated
   * entirely to Postgres.
   */
  private sanitizeQuery(query: string): string {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async isRecencyDecayEnabled(userId: string): Promise<boolean> {
    if (!this.userContextService || !this.personService || !userId) {
      return true;
    }

    try {
      const selfIdentity = await this.userContextService.getSelfIdentity(userId);
      if (!selfIdentity) {
        return true;
      }

      const self = await this.personService.findById({ userId }, selfIdentity.entityId);
      const planner = (self?.properties?.planner ?? {}) as Record<string, unknown>;

      return planner.memory_recency_decay_enabled !== false;
    } catch {
      return true;
    }
  }
}

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OllamaService } from '@ci/domains/llm/services/OllamaService';

/**
 * Relationship types this extractor may propose.
 *
 * Deliberately the pair `ReadKnowledgeTool` already queries for "What do I
 * like?" (see its `relationshipTypes: ['PREFERS', 'DISLIKES']` presets), and
 * the type onboarding writes. An earlier version of this path minted
 * `INTERESTED_IN`, which nothing in the system reads — so every concept it
 * promoted was invisible to the agent the moment it was written.
 */
export const CONCEPT_RELATIONSHIP_TYPES = ['PREFERS', 'DISLIKES'] as const;

export type ConceptRelationshipType = (typeof CONCEPT_RELATIONSHIP_TYPES)[number];

/** A promotable preference recovered from one question/answer pair. */
export interface ConceptExtraction {
  /** Short label — a thing, not a sentence ("Tacos", "Ice skating"). */
  readonly name: string;
  /** Coarse grouping, matching onboarding's `category` ("food", "activity"). */
  readonly category: string;
  readonly relationshipType: ConceptRelationshipType;
  /** 0..1. How firmly the answer states the preference. */
  readonly strength: number;
}

/**
 * `name` is capped at three words and 64 characters at the schema boundary
 * rather than trusted from the prompt. The failure this replaces was a concept
 * named by an arbitrary 120-character cut of a paragraph, and "the instructions
 * said to be brief" is not a constraint.
 */
const EXTRACTION_SCHEMA = z.object({
  hasPreference: z.boolean(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((value) => value.split(/\s+/).length <= 3, { message: 'name must be at most three words' })
    .nullable()
    .optional(),
  category: z.string().trim().min(1).max(40).nullable().optional(),
  relationshipType: z.enum(CONCEPT_RELATIONSHIP_TYPES).nullable().optional(),
  strength: z.number().min(0).max(1).nullable().optional(),
});

/**
 * Grammar-level guard, passed to Ollama's `format`. Ollama compiles this to a
 * constrained decoding grammar and DOES honour `maxLength` — measured against
 * gemma4 on this appliance.
 *
 * The limits here are deliberately LOOSER than the zod ones above, and that
 * ordering is the whole point. Constrained decoding does not make a model
 * concise; it stops the token stream dead at the limit. Measured on the same
 * prompt:
 *
 *   maxLength 12 -> "Systemic/Alg"                 truncated mid-word
 *   maxLength 20 -> "Structural Analysis"          clean
 *   maxLength 64 -> "Systematic Problem Solving"   clean
 *   unconstrained -> "Systemic Optimization"       clean
 *
 * A tight limit therefore manufactures exactly the mid-word fragment this
 * service exists to prevent. So the grammar limit is set where it will
 * essentially never bind — a runaway guard, nothing more — and zod stays the
 * semantic gate. Were the two equal, a value truncated AT the boundary would
 * satisfy zod's `.max()` and reach the graph; being looser guarantees any
 * truncation artifact is over the zod limit and gets rejected rather than
 * written.
 */
const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    hasPreference: { type: 'boolean' },
    name: { type: 'string', maxLength: 120 },
    category: { type: 'string', maxLength: 80 },
    relationshipType: { type: 'string', enum: [...CONCEPT_RELATIONSHIP_TYPES] },
    strength: { type: 'number' },
  },
  required: ['hasPreference'],
};

/**
 * Names the concept an answer is *about*.
 *
 * The path this serves used to use the answer text itself as the concept name,
 * which only reads correctly when a question happens to be phrased so its
 * answer is already a noun ("hiking, bowling or ice skating?" -> "Hiking").
 * Any other phrasing produced nonsense: "When making decisions, do you rely on
 * logic or intuition?" yielded a Concept named with the first 120 characters of
 * a paragraph, asserted as something the user is interested in.
 *
 * An answer is evidence about a concept; it is not the concept's name. Only a
 * reader of both the question and the answer can say what the concept is, so
 * that is what this does.
 */
@Injectable()
export class ConceptExtractionService {
  constructor(
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConceptExtractionService.name);
  }

  /**
   * Returns the preference an answer expresses, or null when it expresses none.
   *
   * Null is the correct and common outcome. Plenty of answers are traits,
   * schedules or facts rather than preferences — "I rely on logic and analysis"
   * describes how someone thinks and is not something they prefer — and the
   * caller skips those rather than inventing an edge for them.
   *
   * NOTE ON FAILURE: an LLM error also returns null. There is deliberately no
   * fallback to the answer text, because that fallback IS the bug this replaces:
   * it is what wrote sentence fragments into the graph as concepts. Losing a
   * promotion when the model is unavailable is recoverable — the answer stays in
   * ci.answers and the next hydration pass sees it again. A poisoned graph node
   * is not.
   */
  async extract(
    context: UserServiceContext,
    input: { questionText?: string | null; answerText: string },
  ): Promise<ConceptExtraction | null> {
    const answerText = input.answerText.trim();

    if (!answerText) {
      return null;
    }

    try {
      const llmContext = { userId: context.userId } as RequestContext;

      const response = await this.ollamaService.chat(
        llmContext,
        [{ role: 'user', content: this.buildPrompt(input.questionText ?? null, answerText) }],
        { tier: 'utility', enableTools: false, format: EXTRACTION_JSON_SCHEMA },
      );

      const parsed = EXTRACTION_SCHEMA.parse(JSON.parse(response.message.content));

      if (!parsed.hasPreference || !parsed.name || !parsed.relationshipType) {
        return null;
      }

      return {
        name: parsed.name,
        category: parsed.category?.toLowerCase() ?? 'general',
        relationshipType: parsed.relationshipType,
        // A stated preference is worth more than the flat 0.6 this path used to
        // assert for everything, but the model's own number is kept when given
        // so a hedged answer ("sometimes") does not read as a firm one.
        strength: parsed.strength ?? 0.8,
      };
    } catch (error) {
      this.logger.warn('Concept extraction failed; skipping promotion', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  private buildPrompt(questionText: string | null, answerText: string): string {
    return [
      'You extract the single thing a person expressed a preference about.',
      '',
      questionText ? `Question they were asked: ${questionText}` : 'Question: (not recorded)',
      `Their answer: ${answerText}`,
      '',
      'Name the CONCEPT the answer is about — not the answer text itself.',
      'The name is a noun phrase of at most three words, capitalised as a title: "Tacos",',
      '"Ice skating", "Science fiction". Never a sentence, never a clause, never a verb phrase.',
      '',
      'Set hasPreference false, and omit every other field, when the answer does not express',
      'liking or disliking a thing. Traits, habits, schedules, times, opinions about oneself and',
      'refusals are all hasPreference false. "I rely on logic over intuition" describes how they',
      'think and is NOT a preference for a thing.',
      '',
      'relationshipType is PREFERS when they like it, DISLIKES when they do not.',
      'category is one lowercase word grouping the concept: food, activity, entertainment,',
      'music, travel, work, other.',
      'strength is 0 to 1: how firmly the answer states it. A plain statement is about 0.8;',
      'a hedged one ("sometimes", "it depends") is lower.',
      '',
      'Return JSON only: { "hasPreference": true, "name": "...", "category": "...",',
      '"relationshipType": "PREFERS", "strength": 0.8 }',
    ].join('\n');
  }
}

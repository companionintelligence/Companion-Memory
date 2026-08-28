import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  GraphIngestService,
  type GraphEntityInputDto,
  type GraphRelationshipInputDto,
} from '@ci/domains/graph';

import { shouldSkipHydrationCandidate } from '../utils/hydrationCandidateFilter';

import { ConceptExtractionService } from './ConceptExtractionService';
import { PersonalizationService } from './PersonalizationService';

export interface HydrationResult {
  readonly sampledRecords: number;
  readonly autoWritten: number;
  readonly reviewQueued: number;
  readonly skipped: number;
}

interface HydrationTextRow {
  readonly text: string;
  readonly questionText?: string | null;
}

@Injectable()
export class CrossTableHydrationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly graphIngestService: GraphIngestService,
    private readonly personalizationService: PersonalizationService,
    private readonly conceptExtractionService: ConceptExtractionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CrossTableHydrationService.name);
  }

  async hydrateAnswers(context: UserServiceContext, limit = 50): Promise<HydrationResult> {
    type Row = { answer_id: string; answer_text: string; question_text: string | null };
    const rows = (await this.dataSource.query(
      `
      SELECT a.answer_id, a.answer_text, q.question_text
      FROM ci.answers a
      LEFT JOIN ci.questions q ON q.question_id = a.question_id
      WHERE a.user_id = $1
        AND a.answer_text IS NOT NULL
        AND TRIM(a.answer_text) <> ''
      ORDER BY a.answered_at DESC
      LIMIT $2;
      `,
      [context.userId, limit],
    )) as Row[];

    return this.hydrateFromTexts(
      context,
      rows.map((row) => ({ text: row.answer_text, questionText: row.question_text })),
      'hydrate_answers',
    );
  }

  /**
   * Objects live in `ci.objects`, and has no `name` or `description`.
   *
   * This read was written against a `ci.items` table with those two columns.
   * No such table exists — `to_regclass('ci.items')` is null on a migrated
   * database — so every call threw `relation "ci.items" does not exist` and the
   * objects half of hydration had never run. A physical thing is identified
   * here by brand/model over category/subcategory instead, which is what the
   * columns actually carry.
   *
   * Rows merged into another object are excluded: they are duplicates by
   * definition, and hydrating both sides teaches the profile the same thing
   * twice.
   */
  async hydrateThings(context: UserServiceContext, limit = 50): Promise<HydrationResult> {
    type Row = { object_id: string; name: string | null; description: string | null };
    const rows = (await this.dataSource.query(
      `
      SELECT i.object_id,
             NULLIF(TRIM(CONCAT_WS(' ', i.brand, i.model)), '')          AS name,
             NULLIF(TRIM(CONCAT_WS(', ', i.category, i.subcategory)), '') AS description
      FROM ci.objects i
      WHERE i.user_id = $1
        AND i.merged_into_object_id IS NULL
      ORDER BY i.created_at DESC
      LIMIT $2;
      `,
      [context.userId, limit],
    )) as Row[];

    const texts = rows
      .map((row) => ({
        text: [row.name, row.description].filter(Boolean).join(': '),
        questionText: null,
      }))
      .filter((row) => row.text.length > 0);

    return this.hydrateFromTexts(context, texts, 'hydrate_things');
  }

  private async hydrateFromTexts(
    context: UserServiceContext,
    rows: HydrationTextRow[],
    sourceJob: string,
  ): Promise<HydrationResult> {
    const result = {
      sampledRecords: rows.length,
      autoWritten: 0,
      reviewQueued: 0,
      skipped: 0,
    };

    if (rows.length === 0 || !context.userId) {
      return result;
    }

    for (const row of rows) {
      const text = row.text.trim();

      if (shouldSkipHydrationCandidate(text, row.questionText)) {
        result.skipped += 1;
        continue;
      }

      // The concept is NAMED by a model that reads both the question and the
      // answer, never taken from the answer text. An answer is evidence about a
      // concept, not its name — "Tacos" only looks like a label because that
      // question happened to be phrased so its answer was already a noun.
      //
      // Null means "no promotable preference here", which is the common and
      // correct outcome for traits, schedules and facts. It is also what an LLM
      // failure returns; there is deliberately no fall back to the raw text,
      // since that fallback is precisely what wrote sentence fragments into the
      // graph as concepts.
      const concept = await this.conceptExtractionService.extract(context, {
        questionText: row.questionText,
        answerText: text,
      });

      if (!concept) {
        result.skipped += 1;
        continue;
      }

      // Keyed on the concept NAME, not the answer, so two phrasings of the same
      // preference converge on one node — and on the same node onboarding
      // already wrote, rather than minting a second "Tacos".
      const conceptKey = `concept:${concept.name.toLowerCase()}`;

      const entities: GraphEntityInputDto[] = [
        {
          key: conceptKey,
          entityType: 'Concept',
          name: concept.name,
          sourceSystem: sourceJob,
          properties: { source: sourceJob, category: concept.category },
        },
      ];

      // PREFERS/DISLIKES, matching onboarding and the pair ReadKnowledgeTool
      // queries for "What do I like?". The previous INTERESTED_IN was read by
      // nothing, so everything this path promoted was invisible to the agent.
      const relationships: GraphRelationshipInputDto[] = [
        {
          fromKey: 'self',
          toKey: conceptKey,
          type: concept.relationshipType,
          properties: { strength: concept.strength, source: sourceJob, category: concept.category },
        },
      ];

      const decision = await this.personalizationService.decideAction(context.userId, {
        kind: 'graph_edge',
        confidence: 0.69,
        hasUserInput: true,
      });

      if (decision === 'skip') {
        result.skipped += 1;
        continue;
      }

      if (decision === 'review') {
        result.reviewQueued += 1;
        continue;
      }

      await this.graphIngestService.ingest(context, { entities, relationships });
      result.autoWritten += 1;
    }

    this.logger.log('Cross-table hydration complete', { userId: context.userId, sourceJob, ...result });

    return result;
  }
}
